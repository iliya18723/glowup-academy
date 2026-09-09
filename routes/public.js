const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sanitizeHtml } = require('../utils/sanitize');
const crypto = require('crypto');
function activeSale(courseId){
  return db.prepare(`SELECT * FROM flash_sales WHERE course_id=? AND is_active=1 AND datetime(starts_at)<=datetime('now') AND datetime(ends_at)>datetime('now') ORDER BY sale_price ASC LIMIT 1`).get(courseId);
}
function effectivePrice(course){ const sale=activeSale(course.id); course.flash_sale_price=sale?.sale_price||null; return sale?.sale_price ?? (course.discount_price || course.price); }
function decorateWishlist(courses, userId){
  if(!userId || !Array.isArray(courses) || !courses.length) return courses;
  const ids=courses.map(c=>Number(c.id)).filter(Number.isInteger);
  if(!ids.length) return courses;
  const marks=ids.map(()=>'?').join(',');
  const saved=new Set(db.prepare(`SELECT course_id FROM wishlists WHERE user_id=? AND course_id IN (${marks})`).all(userId,...ids).map(r=>Number(r.course_id)));
  courses.forEach(c=>{ c.wished=saved.has(Number(c.id)); });
  return courses;
}
function safeLocalRedirect(req, fallback='/dashboard') { const ref=String(req.get('referer')||''); try { const u=new URL(ref); if (u.origin === `${req.protocol}://${req.get('host')}`) return u.pathname + u.search + u.hash; } catch (_) {} return fallback; }

function createNotification(userId, title, body, type='system', link='/dashboard') {
  return db.prepare('INSERT INTO notifications(user_id,title,body,type,link) VALUES(?,?,?,?,?)').run(userId, title, body, type, link);
}

function achievementDefinitions(){
  return [
    ['first-step','اولین قدم','🚀','اولین جلسه‌ات را کامل کردی','جلسه',1,'sessions'],
    ['on-fire','روی فرم','🔥','۳ روز پشت‌سرهم فعال بودی','استریک',3,'streak'],
    ['finisher','تمام‌کننده','🏆','اولین دوره را کامل کردی','دوره کامل‌شده',1,'completed_courses'],
    ['xp-250','XP Hunter','⚡','به ۲۵۰ امتیاز تجربه رسیدی','XP',250,'xp'],
    ['xp-500','نیمه‌حرفه‌ای','💎','به ۵۰۰ XP رسیدی','XP',500,'xp'],
    ['streak-7','هفته طلایی','🌟','۷ روز متوالی در مسیر ماندی','استریک',7,'streak'],
    ['session-10','ده قدم جلوتر','🎯','۱۰ جلسه آموزشی را کامل کردی','جلسه',10,'sessions'],
    ['course-3','سه‌گانه','👑','۳ دوره را کامل کردی','دوره کامل‌شده',3,'completed_courses'],
    ['wishlist-3','انتخاب‌گر','❤️','۳ دوره را ذخیره کردی','ذخیره',3,'wishlist'],
    ['reviewer','صدای گلوآپ','⭐','اولین نظر خودت را ثبت کردی','نظر',1,'reviews']
  ];
}
function ensureAchievementDefinitions(){
  const ins=db.prepare('INSERT OR IGNORE INTO badges(slug,title,icon,description) VALUES(?,?,?,?)');
  for(const [slug,title,icon,description] of achievementDefinitions()) ins.run(slug,title,icon,description);
}
function awardAchievements(userId){
  ensureAchievementDefinitions();
  const stats=db.prepare(`SELECT
    (SELECT COUNT(*) FROM session_progress WHERE user_id=?) sessions,
    (SELECT COALESCE(xp,0) FROM user_xp WHERE user_id=?) xp,
    (SELECT COALESCE(streak_days,0) FROM user_xp WHERE user_id=?) streak,
    (SELECT COUNT(*) FROM wishlists WHERE user_id=?) wishlist,
    (SELECT COUNT(*) FROM reviews WHERE user_id=?) reviews,
    (SELECT COUNT(*) FROM (SELECT e.course_id FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? GROUP BY e.course_id HAVING (SELECT COUNT(*) FROM course_sessions cs WHERE cs.course_id=e.course_id)>0 AND (SELECT COUNT(*) FROM session_progress sp WHERE sp.user_id=? AND sp.course_id=e.course_id)>=(SELECT COUNT(*) FROM course_sessions cs2 WHERE cs2.course_id=e.course_id))) completed_courses`)
    .get(userId,userId,userId,userId,userId,userId,userId);
  const values={sessions:Number(stats.sessions||0),xp:Number(stats.xp||0),streak:Number(stats.streak||0),wishlist:Number(stats.wishlist||0),reviews:Number(stats.reviews||0),completed_courses:Number(stats.completed_courses||0)};
  const award=db.prepare('INSERT OR IGNORE INTO user_badges(user_id,badge_id) VALUES(?,?)');
  const newly=[];
  for(const [slug,title,icon,description,label,target,key] of achievementDefinitions()){
    if(values[key] < target) continue;
    const badge=db.prepare('SELECT id FROM badges WHERE slug=?').get(slug);
    const result=award.run(userId,badge.id);
    if(result.changes>0){ newly.push({slug,title,icon,description}); createNotification(userId,`نشان جدید: ${icon} ${title}`,`تبریک! نشان «${title}» را باز کردی. ${description}`,'achievement','/achievements'); }
  }
  return newly;
}


router.get('/', (req, res) => {
  // The first viewport should never be empty just because an admin forgot to mark courses as featured.
  const featured = db.prepare('SELECT * FROM courses WHERE is_published = 1 AND is_featured = 1 ORDER BY sort_order,id LIMIT 8').all();
  if (featured.length < 5) {
    const existing = new Set(featured.map(c => c.id));
    const fallback = db.prepare('SELECT * FROM courses WHERE is_published = 1 ORDER BY is_featured DESC, sort_order,id LIMIT 12').all();
    for (const c of fallback) {
      if (existing.has(c.id)) continue;
      featured.push(c); existing.add(c.id);
      if (featured.length >= 8) break;
    }
  }
  featured.forEach(c=>effectivePrice(c));
  decorateWishlist(featured, req.session.user?.id);
  const posts = db.prepare('SELECT * FROM blog_posts WHERE is_published = 1 ORDER BY created_at DESC LIMIT 3').all();
  posts.forEach(p => { p.reading_time = readingTime(p.content || p.excerpt); });
  const settingRows = db.prepare('SELECT key,value FROM settings').all();
  const settings = Object.fromEntries(settingRows.map(r=>[r.key,r.value]));
  const testimonials = db.prepare('SELECT * FROM testimonials WHERE is_published=1 ORDER BY sort_order,id LIMIT 6').all();
  const faqs = db.prepare('SELECT * FROM faqs WHERE is_published=1 ORDER BY sort_order,id LIMIT 10').all();
  const homepageSections = db.prepare('SELECT * FROM homepage_sections WHERE is_enabled=1 ORDER BY sort_order,id').all();
  const now = new Date().toISOString().slice(0,19).replace('T',' ');
  const banners = db.prepare("SELECT * FROM homepage_banners WHERE is_published=1 AND (starts_at IS NULL OR datetime(starts_at)<=datetime(?)) AND (ends_at IS NULL OR datetime(ends_at)>datetime(?)) ORDER BY sort_order,id LIMIT 6").all(now, now);
  res.render('home', { title: 'خانه', featured, posts, settings, testimonials, faqs, homepageSections, banners });
});

router.get('/wishlist', requireAuth, (req,res)=>{
  const uid=req.session.user.id;
  const saved=db.prepare(`SELECT c.*, cat.title AS category_title, w.created_at AS saved_at
    FROM wishlists w JOIN courses c ON c.id=w.course_id LEFT JOIN categories cat ON cat.id=c.category_id
    WHERE w.user_id=? AND c.is_published=1 ORDER BY w.created_at DESC`).all(uid);
  saved.forEach(effectivePrice);
  const categories=db.prepare('SELECT id,title FROM categories ORDER BY title').all();
  const categoryIds=[...new Set(saved.map(c=>c.category_id).filter(Boolean))];
  let recommendations=[];
  if(categoryIds.length){
    const marks=categoryIds.map(()=>'?').join(',');
    recommendations=db.prepare(`SELECT c.*, cat.title AS category_title FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id
      WHERE c.is_published=1 AND c.category_id IN (${marks}) AND c.id NOT IN (SELECT course_id FROM wishlists WHERE user_id=?)
      ORDER BY c.is_featured DESC,c.sort_order,c.id DESC LIMIT 6`).all(...categoryIds,uid);
  } else {
    recommendations=db.prepare(`SELECT c.*, cat.title AS category_title FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id
      WHERE c.is_published=1 AND c.id NOT IN (SELECT course_id FROM wishlists WHERE user_id=?)
      ORDER BY c.is_featured DESC,c.sort_order,c.id DESC LIMIT 6`).all(uid);
  }
  recommendations.forEach(effectivePrice);
  decorateWishlist(saved, uid);
  decorateWishlist(recommendations, uid);
  res.render('wishlist',{title:'دوره‌های ذخیره‌شده',saved,recommendations,categories});
});

router.get('/achievements', requireAuth, (req,res)=>{
  const uid=req.session.user.id;
  const newly=awardAchievements(uid);
  const earned=db.prepare(`SELECT b.*, ub.earned_at FROM badges b JOIN user_badges ub ON ub.badge_id=b.id WHERE ub.user_id=? ORDER BY ub.earned_at DESC`).all(uid);
  const earnedIds=new Set(earned.map(b=>b.id));
  const all=achievementDefinitions().map(([slug,title,icon,description,label,target,key])=>({slug,title,icon,description,label,target,key,earned:false}));
  const rows=db.prepare('SELECT id,slug,title,icon,description FROM badges').all();
  const bySlug=new Map(rows.map(r=>[r.slug,r]));
  all.forEach(a=>{const b=bySlug.get(a.slug); a.id=b?.id; a.earned=earnedIds.has(b?.id);});
  const xpRow=db.prepare('SELECT COALESCE(xp,0) xp,COALESCE(streak_days,0) streak_days FROM user_xp WHERE user_id=?').get(uid)||{xp:0,streak_days:0};
  const stats=db.prepare(`SELECT (SELECT COUNT(*) FROM session_progress WHERE user_id=?) sessions,(SELECT COUNT(*) FROM wishlists WHERE user_id=?) wishlist,(SELECT COUNT(*) FROM reviews WHERE user_id=?) reviews`).get(uid,uid,uid);
  const completedCourses=all.length; // display count is derived below from the same source of truth
  const completedCount=db.prepare(`SELECT COUNT(*) c FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? AND (SELECT COUNT(*) FROM course_sessions cs WHERE cs.course_id=e.course_id)>0 AND (SELECT COUNT(*) FROM session_progress sp WHERE sp.user_id=? AND sp.course_id=e.course_id)>=(SELECT COUNT(*) FROM course_sessions cs2 WHERE cs2.course_id=e.course_id)`).get(uid,uid).c;
  const current={xp:Number(xpRow.xp||0),streak:Number(xpRow.streak_days||0),sessions:Number(stats.sessions||0),wishlist:Number(stats.wishlist||0),reviews:Number(stats.reviews||0),completed_courses:Number(completedCount||0)};
  all.forEach(a=>{a.value=current[a.key]||0;a.progress=Math.min(100,Math.round((a.value/a.target)*100));});
  res.render('achievements',{title:'دستاوردها و نشان‌ها',all,earned,newly,current});
});

router.get('/notifications', requireAuth, (req,res)=>{
  const filter = req.query.filter === 'unread' ? 'unread' : 'all';
  const uid = req.session.user.id;
  const where = filter === 'unread' ? 'AND is_read=0' : '';
  const notifications = db.prepare(`SELECT * FROM notifications WHERE user_id=? ${where} ORDER BY created_at DESC LIMIT 60`).all(uid);
  const unreadCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(uid).c;
  res.render('notifications',{title:'اعلان‌های من',notifications,unreadCount,filter});
});

router.get('/profile', requireAuth, (req,res)=>{
  const uid=req.session.user.id;
  const profile=db.prepare('SELECT id,full_name,phone,email,avatar,created_at FROM users WHERE id=?').get(uid);
  if(!profile) return res.redirect('/login');
  const stats=db.prepare(`SELECT
    (SELECT COUNT(*) FROM enrollments WHERE user_id=?) AS enrolled_count,
    (SELECT COUNT(*) FROM session_progress WHERE user_id=?) AS completed_sessions,
    (SELECT COALESCE(SUM(amount),0) FROM xp_events WHERE user_id=?) AS total_xp,
    (SELECT COUNT(*) FROM certificates WHERE user_id=?) AS certificates_count,
    (SELECT COUNT(*) FROM wishlists WHERE user_id=?) AS wishlist_count
  `).get(uid,uid,uid,uid,uid);
  const xp=Number(stats.total_xp||0);
  const level=Math.max(1,Math.floor(xp/250)+1);
  const levelBase=(level-1)*250;
  const levelProgress=Math.min(100,Math.round(((xp-levelBase)/250)*100));
  const recentActivity=db.prepare(`SELECT xe.amount,xe.created_at,cs.title AS session_title,c.title AS course_title,c.slug
    FROM xp_events xe JOIN course_sessions cs ON cs.id=xe.session_id JOIN courses c ON c.id=cs.course_id
    WHERE xe.user_id=? ORDER BY xe.created_at DESC LIMIT 5`).all(uid);
  res.render('profile',{title:'پروفایل من',profile,stats:{...stats,level,levelProgress},recentActivity,success:req.query.success==='1',error:req.query.error||null});
});

router.post('/profile', requireAuth, (req,res)=>{
  const uid=req.session.user.id;
  const fullName=String(req.body.full_name||'').trim().slice(0,100);
  const email=String(req.body.email||'').trim().slice(0,160);
  const avatar=String(req.body.avatar||'').trim().slice(0,500);
  if(fullName.length<2) return res.redirect('/profile?error='+encodeURIComponent('نام باید حداقل ۲ کاراکتر باشد.'));
  if(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.redirect('/profile?error='+encodeURIComponent('ایمیل واردشده معتبر نیست.'));
  if(avatar){
    try {
      const u=new URL(avatar);
      if(!['https:','http:'].includes(u.protocol.toLowerCase())) throw new Error('bad protocol');
    } catch (_) {
      return res.redirect('/profile?error='+encodeURIComponent('لینک تصویر پروفایل باید یک آدرس معتبر http یا https باشد.'));
    }
  }
  db.prepare('UPDATE users SET full_name=?,email=?,avatar=? WHERE id=?').run(fullName,email||null,avatar||null,uid);
  req.session.user={...req.session.user,full_name:fullName,email:email||null,avatar:avatar||null};
  db.prepare('INSERT INTO notifications(user_id,title,body,type,link) VALUES(?,?,?,?,?)').run(uid,'پروفایل به‌روزرسانی شد','اطلاعات پروفایل شما با موفقیت ذخیره شد.','system','/profile');
  res.redirect('/profile?success=1');
});

router.get('/dashboard', requireAuth, (req, res) => {
  const userId = req.session.user.id;
  const courses = db.prepare(`
    SELECT c.*, COUNT(DISTINCT cs.id) AS total_sessions,
      COUNT(DISTINCT CASE WHEN sp.user_id = ? THEN sp.session_id END) AS completed_sessions
    FROM enrollments e JOIN courses c ON c.id=e.course_id
    LEFT JOIN course_sessions cs ON cs.course_id=c.id
    LEFT JOIN session_progress sp ON sp.course_id=c.id AND sp.session_id=cs.id
    WHERE e.user_id=? AND c.is_published=1 GROUP BY c.id ORDER BY e.created_at DESC
  `).all(userId, userId);
  courses.forEach(c => {
    c.progress = c.total_sessions ? Math.round((c.completed_sessions / c.total_sessions) * 100) : 0;
    c.nextSession = db.prepare(`SELECT cs.* FROM course_sessions cs
      WHERE cs.course_id=? AND NOT EXISTS (SELECT 1 FROM session_progress sp WHERE sp.user_id=? AND sp.session_id=cs.id)
      ORDER BY cs.sort_order LIMIT 1`).get(c.id, userId);
    if (!c.nextSession) c.nextSession = db.prepare('SELECT * FROM course_sessions WHERE course_id=? ORDER BY sort_order LIMIT 1').get(c.id);
  });
  const completed = db.prepare('SELECT COUNT(*) c FROM session_progress WHERE user_id=?').get(userId).c;
  const enrolledCount = db.prepare(`SELECT COUNT(*) c FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=? AND c.is_published=1`).get(userId).c;
  const completedCourses = courses.filter(c => c.total_sessions > 0 && c.completed_sessions >= c.total_sessions).length;
  const remainingSessions = Math.max(0, courses.reduce((sum,c) => sum + Math.max(0, c.total_sessions - c.completed_sessions), 0));
  const resumeCourse = courses.find(c => c.nextSession && c.progress < 100) || courses.find(c => c.nextSession) || null;
  const recentActivity = db.prepare(`
    SELECT xe.amount, xe.created_at, cs.title AS session_title, c.title AS course_title, c.slug
    FROM xp_events xe
    JOIN course_sessions cs ON cs.id=xe.session_id
    JOIN courses c ON c.id=cs.course_id
    WHERE xe.user_id=? ORDER BY xe.created_at DESC LIMIT 6
  `).all(userId);
  const weeklyXp = db.prepare(`SELECT COALESCE(SUM(amount),0) xp FROM xp_events WHERE user_id=? AND datetime(created_at) >= datetime('now','-6 days','localtime')`).get(userId).xp;
  const xpRow = db.prepare('SELECT * FROM user_xp WHERE user_id=?').get(userId) || {xp:0,streak_days:0};
  const level = Math.max(1, Math.floor((xpRow.xp || 0) / 250) + 1);
  const levelBase=(level-1)*250, levelProgress=Math.min(100,Math.round(((xpRow.xp-levelBase)/250)*100));
  const badges = db.prepare('SELECT b.* FROM badges b JOIN user_badges ub ON ub.badge_id=b.id WHERE ub.user_id=? ORDER BY ub.earned_at DESC').all(userId);
  const wishlist = db.prepare(`SELECT c.* FROM wishlists w JOIN courses c ON c.id=w.course_id WHERE w.user_id=? AND c.is_published=1 ORDER BY w.created_at DESC`).all(userId);
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 8').all(userId);
  const unreadNotifications = notifications.filter(n=>!n.is_read).length;
  const certificates = db.prepare(`SELECT cert.*, c.title AS course_title FROM certificates cert JOIN courses c ON c.id=cert.course_id WHERE cert.user_id=? ORDER BY cert.issued_at DESC`).all(userId);
  res.render('dashboard', { title:'داشبورد من', courses, completed, enrolledCount, completedCourses, remainingSessions, resumeCourse, recentActivity, weeklyXp, xp:xpRow.xp||0, streak:xpRow.streak_days||0, level, levelProgress, badges, wishlist, notifications, unreadNotifications, certificates });
});

router.get('/quiz', (req,res)=>res.render('quiz',{title:'تست گلوآپ'}));

router.get('/courses', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  const category = String(req.query.category || 'all');
  const sort = ['featured','newest','price_asc','price_desc'].includes(String(req.query.sort)) ? String(req.query.sort) : 'featured';
  const categories = db.prepare('SELECT * FROM categories ORDER BY title').all();
  const params = [ ];
  const where = ['c.is_published = 1'];
  if (q) { const like = '%' + q.replace(/[%_]/g, '') + '%'; where.push('(c.title LIKE ? OR c.subtitle LIKE ? OR c.description LIKE ? OR cat.title LIKE ?)'); params.push(like, like, like, like); }
  if (category !== 'all' && /^\d+$/.test(category)) { where.push('c.category_id = ?'); params.push(Number(category)); }
  const orderBy = { featured: 'c.is_featured DESC, c.sort_order ASC, c.id DESC', newest: 'c.created_at DESC, c.id DESC', price_asc: 'COALESCE(NULLIF(c.discount_price,0), c.price) ASC, c.id DESC', price_desc: 'COALESCE(NULLIF(c.discount_price,0), c.price) DESC, c.id DESC' }[sort];
  const courses = db.prepare(`SELECT c.*, cat.title AS category_title FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`).all(...params);
  courses.forEach(c=>effectivePrice(c));
  decorateWishlist(courses, req.session.user?.id);
  res.render('courses', { title: q ? `دوره‌ها: ${q}` : 'دوره‌ها', courses, categories, q, category, sort });
});

router.get('/courses/:slug', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE slug = ? AND is_published = 1').get(req.params.slug);
  if (!course) return res.status(404).render('404', { title: 'پیدا نشد' });
  effectivePrice(course);
  const sessions = db.prepare('SELECT * FROM course_sessions WHERE course_id = ? ORDER BY sort_order').all(course.id);

  let owned = false, wished = false, myReview = null, completedIds = [];
  if (req.session.user) {
    owned = !!db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?').get(req.session.user.id, course.id);
    wished = !!db.prepare('SELECT 1 FROM wishlists WHERE user_id=? AND course_id=?').get(req.session.user.id, course.id);
    myReview = db.prepare('SELECT * FROM reviews WHERE user_id=? AND course_id=?').get(req.session.user.id, course.id) || null;
    completedIds = db.prepare('SELECT session_id FROM session_progress WHERE user_id=? AND course_id=?').all(req.session.user.id, course.id).map(r => r.session_id);
  }
  const totalDurationSeconds = sessions.reduce((sum, s) => sum + (Number(s.duration_seconds) || 0), 0);
  const phaseCount = new Set(sessions.map(s => s.phase || 'سرفصل‌های دوره')).size;
  const reviews = db.prepare(`SELECT r.*, u.full_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.course_id=? AND r.is_approved=1 ORDER BY r.created_at DESC LIMIT 20`).all(course.id);
  const ratingRow = db.prepare(`SELECT COALESCE(AVG(rating),0) avg_rating, COUNT(*) count FROM reviews WHERE course_id=? AND is_approved=1`).get(course.id);
  let relatedCourses=[];
  if(course.category_id){
    relatedCourses=db.prepare(`SELECT c.*, cat.title AS category_title FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id
      WHERE c.is_published=1 AND c.category_id=? AND c.id<>? ORDER BY c.is_featured DESC,c.sort_order,c.id DESC LIMIT 4`).all(course.category_id,course.id);
  }
  relatedCourses.forEach(effectivePrice);
  decorateWishlist(relatedCourses, req.session.user?.id);
  res.render('course-detail', { title: course.title, course, sessions, owned, wished, myReview, reviews, completedIds, totalDurationSeconds, phaseCount, relatedCourses, ratingAvg: Number(ratingRow.avg_rating||0), ratingCount: ratingRow.count||0 });
});

// --- صفحه‌ی پخش ویدیوی جلسه (فقط برای مالکان دوره یا جلسات پیش‌نمایش رایگان) ---
router.get('/courses/:slug/watch/:sessionId', requireAuth, (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE slug = ? AND is_published = 1').get(req.params.slug);
  if (!course) return res.status(404).render('404', { title: 'پیدا نشد' });

  const sessions = db.prepare('SELECT * FROM course_sessions WHERE course_id = ? ORDER BY sort_order').all(course.id);
  const session = sessions.find(s => String(s.id) === req.params.sessionId);
  if (!session) return res.status(404).render('404', { title: 'پیدا نشد' });

  const owned = !!db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?')
    .get(req.session.user.id, course.id);
  if (!owned && !session.is_free_preview) return res.status(403).render('403', { title: 'دسترسی غیرمجاز' });

  const idx = sessions.findIndex(s => s.id === session.id);
  const prevSession = idx > 0 ? sessions[idx - 1] : null;
  const nextSession = idx < sessions.length - 1 ? sessions[idx + 1] : null;

  const completedIds = db.prepare('SELECT session_id FROM session_progress WHERE user_id = ? AND course_id = ?')
    .all(req.session.user.id, course.id).map(r => r.session_id);
  const percent = sessions.length ? Math.round((completedIds.length / sessions.length) * 100) : 0;
  const videoSrc = String(session.video_url || '').startsWith('/uploads/videos/')
    ? '/uploads/videos/' + encodeURIComponent(String(session.video_url).split('/').pop())
    : session.video_url;

  res.render('watch', { title: session.title, course, sessions, session, videoSrc, owned, prevSession, nextSession, completedIds, percent });
});

// --- علامت‌گذاری/برداشتن علامت «دیده‌شده» برای یک جلسه (ذخیره‌ی واقعی در دیتابیس) ---
router.post('/courses/:slug/watch/:sessionId/complete', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const course = db.prepare('SELECT * FROM courses WHERE slug = ? AND is_published = 1').get(req.params.slug);
  if (!course) return res.status(404).json({ error: 'دوره پیدا نشد' });

  const session = db.prepare('SELECT * FROM course_sessions WHERE id = ? AND course_id = ?')
    .get(req.params.sessionId, course.id);
  if (!session) return res.status(404).json({ error: 'جلسه پیدا نشد' });

  const owned = !!db.prepare('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?')
    .get(uid, course.id);
  if (!owned && !session.is_free_preview) return res.status(403).json({ error: 'دسترسی غیرمجاز' });

  const unmark = req.body && req.body.action === 'unmark';
  const watchedSeconds = Number(req.body?.watched_seconds);
  const durationSeconds = Number(session.duration_seconds || 0);
  // A normal completion must come from actually reaching the end portion of the
  // lesson. The client reports playback time; this is not a DRM guarantee, but it
  // prevents a bare POST from granting completion/certificate on timed lessons.
  if (!unmark && durationSeconds > 0 && (!Number.isFinite(watchedSeconds) || watchedSeconds < durationSeconds * 0.9)) {
    return res.status(422).json({ error: 'برای تکمیل این جلسه، حداقل ۹۰٪ ویدئو را تماشا کن.' });
  }

  const existing = db.prepare('SELECT id FROM session_progress WHERE user_id = ? AND session_id = ?')
    .get(uid, session.id);
  // Completion is idempotent by default. Use action=unmark only when the user
  // explicitly wants to remove completion; repeated/double-click requests must not
  // silently undo progress. action=mark is kept for backwards compatibility.

  let completed;
  if (existing) {
    if (unmark) {
      db.prepare('DELETE FROM session_progress WHERE id = ?').run(existing.id);
      completed = false;
    } else {
      completed = true;
    }
  } else {
    db.prepare('INSERT OR IGNORE INTO session_progress (user_id, session_id, course_id) VALUES (?, ?, ?)')
      .run(uid, session.id, course.id);
    completed = true;
  }

  const totalSessions = db.prepare('SELECT COUNT(*) c FROM course_sessions WHERE course_id = ?').get(course.id).c;
  const doneCount = db.prepare('SELECT COUNT(*) c FROM session_progress WHERE user_id = ? AND course_id = ?')
    .get(uid, course.id).c;
  const percent = totalSessions ? Math.round((doneCount / totalSessions) * 100) : 0;

  // XP is awarded once per user/session, even if the user later unchecks and rechecks completion.
  db.prepare(`INSERT INTO user_xp(user_id,xp,streak_days,last_active_date)
    VALUES(?,0,0,date('now','localtime')) ON CONFLICT(user_id) DO NOTHING`).run(uid);
  const xpBefore = db.prepare('SELECT * FROM user_xp WHERE user_id=?').get(uid);
  const xpEvent = completed && !existing
    ? db.prepare('INSERT OR IGNORE INTO xp_events(user_id,session_id,amount) VALUES(?,?,25)').run(uid, session.id)
    : { changes: 0 };

  if (xpEvent.changes > 0) {
    const today = db.prepare("SELECT date('now','localtime') d").get().d;
    const yesterday = db.prepare("SELECT date('now','localtime','-1 day') d").get().d;
    const streak = xpBefore.last_active_date === yesterday ? (xpBefore.streak_days || 0) + 1 : 1;
    db.prepare('UPDATE user_xp SET xp=xp+25, streak_days=?, last_active_date=? WHERE user_id=?')
      .run(streak, today, uid);
  }

  // Evaluate the full achievement catalog after every meaningful learning action.
  awardAchievements(uid);

  // A certificate is a purchase benefit: previews alone must never unlock one.
  // Certificate issuance is made collision-safe and notification-safe: concurrent
  // completion requests may race, but only the request that actually inserts the
  // certificate is allowed to notify the learner.
  if(owned && totalSessions>0 && doneCount>=totalSessions){
    const b=db.prepare("SELECT id FROM badges WHERE slug='finisher'").get();
    if (b) db.prepare('INSERT OR IGNORE INTO user_badges(user_id,badge_id) VALUES(?,?)').run(uid,b.id);

    const existingCert=db.prepare('SELECT id FROM certificates WHERE user_id=? AND course_id=?').get(uid,course.id);
    if(!existingCert){
      const insertCert=db.prepare('INSERT OR IGNORE INTO certificates(user_id,course_id,certificate_code) VALUES(?,?,?)');
      let issued=false;
      // 8 random bytes gives a much larger code space than the old 5-byte code.
      // Retry if a certificate-code collision ever occurs.
      for(let attempt=0; attempt<5 && !issued; attempt++){
        const certCode='GLOW-'+new Date().getFullYear()+'-'+crypto.randomBytes(8).toString('hex').toUpperCase();
        try {
          issued = insertCert.run(uid,course.id,certCode).changes > 0;
        } catch (err) {
          if (!String(err?.message || '').toLowerCase().includes('unique')) throw err;
        }
      }
      if(issued) createNotification(uid,'تبریک! دوره را کامل کردی 🎉',`گواهی پایان دوره «${course.title}» آماده است.`,'certificate','/dashboard');
    }
  }

  const xpNow = db.prepare('SELECT xp, streak_days FROM user_xp WHERE user_id=?').get(uid) || { xp: 0, streak_days: 0 };
  res.json({ completed, percent, doneCount, totalSessions, xp:xpNow.xp, streak:xpNow.streak_days });
});

router.get('/search', (req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,100);
  const category=String(req.query.category||'all');
  const sort=['featured','newest','price_asc','price_desc'].includes(String(req.query.sort)) ? String(req.query.sort) : 'featured';
  const categories=db.prepare('SELECT * FROM categories ORDER BY title').all();
  let courses=[], posts=[];
  if(q){
    const like='%'+q.replace(/[%_]/g,'')+'%';
    const where=['c.is_published=1','(c.title LIKE ? OR c.subtitle LIKE ? OR c.description LIKE ? OR cat.title LIKE ?)'];
    const params=[like,like,like,like];
    if(category!=='all' && /^\d+$/.test(category)){ where.push('c.category_id=?'); params.push(Number(category)); }
    const orderBy={featured:'c.is_featured DESC, c.sort_order ASC, c.id DESC',newest:'c.created_at DESC, c.id DESC',price_asc:'COALESCE(NULLIF(c.discount_price,0),c.price) ASC, c.id DESC',price_desc:'COALESCE(NULLIF(c.discount_price,0),c.price) DESC, c.id DESC'}[sort];
    courses=db.prepare(`SELECT c.*, cat.title AS category_title FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT 40`).all(...params);
    courses.forEach(c=>effectivePrice(c));
    decorateWishlist(courses, req.session.user?.id);
    posts=db.prepare(`SELECT * FROM blog_posts WHERE is_published=1 AND (title LIKE ? OR excerpt LIKE ? OR content LIKE ?) ORDER BY created_at DESC LIMIT 30`).all(like,like,like);
  }
  res.render('search',{title:q?`جستجو: ${q}`:'جستجو',q,courses,posts,categories,category,sort});
});

router.post('/wishlist/:courseId/toggle', requireAuth, (req,res)=>{
  const cid=Number(req.params.courseId); const course=db.prepare('SELECT id FROM courses WHERE id=? AND is_published=1').get(cid);
  if(!course) return res.status(404).json({error:'دوره پیدا نشد'});
  const exists=db.prepare('SELECT id FROM wishlists WHERE user_id=? AND course_id=?').get(req.session.user.id,cid);
  if(exists) db.prepare('DELETE FROM wishlists WHERE id=?').run(exists.id); else db.prepare('INSERT INTO wishlists(user_id,course_id) VALUES(?,?)').run(req.session.user.id,cid);
  if(!exists) awardAchievements(req.session.user.id);
  res.json({wished:!exists});
});

router.post('/courses/:slug/review', requireAuth, (req,res)=>{
  const course=db.prepare('SELECT id,slug FROM courses WHERE slug=? AND is_published=1').get(req.params.slug);
  if(!course) return res.status(404).render('404',{title:'پیدا نشد'});
  const owned=db.prepare('SELECT 1 FROM enrollments WHERE user_id=? AND course_id=?').get(req.session.user.id,course.id);
  if(!owned) return res.status(403).render('403',{title:'فقط خریداران می‌توانند نظر بدهند'});
  const parsedRating=Number.parseInt(String(req.body.rating ?? ''),10);
  if(!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) return res.redirect(`/courses/${course.slug}`);
  const rating=parsedRating; const body=String(req.body.body||'').trim().slice(0,1000);
  db.prepare(`INSERT INTO reviews(user_id,course_id,rating,body,is_approved) VALUES(?,?,?,?,0) ON CONFLICT(user_id,course_id) DO UPDATE SET rating=excluded.rating,body=excluded.body,is_approved=0,updated_at=CURRENT_TIMESTAMP`).run(req.session.user.id,course.id,rating,body);
  db.prepare(`INSERT INTO notifications(user_id,title,body,type,link) VALUES(?,?,?,?,?)`).run(req.session.user.id,'نظر شما ثبت شد','نظر شما پس از تأیید نمایش داده می‌شود.','review',`/courses/${course.slug}`);
  awardAchievements(req.session.user.id);
  res.redirect(`/courses/${course.slug}#reviews`);
});

router.post('/notifications/read-all', requireAuth, (req,res)=>{ db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.session.user.id); res.redirect(safeLocalRedirect(req)); });
router.post('/notifications/:id/read', requireAuth, (req,res)=>{ db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(req.params.id,req.session.user.id); res.redirect(safeLocalRedirect(req)); });

router.get('/certificate/:code', (req,res)=>{
  const cert=db.prepare(`SELECT cert.*, u.full_name, c.title AS course_title FROM certificates cert JOIN users u ON u.id=cert.user_id JOIN courses c ON c.id=cert.course_id WHERE cert.certificate_code=?`).get(req.params.code);
  if(!cert) return res.status(404).render('404',{title:'گواهی پیدا نشد'});
  res.render('certificate',{title:'گواهی پایان دوره',cert});
});

function readingTime(html) {
  const text = String(html || '').replace(/<[^>]*>/g, ' ');
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 180));
}

router.get('/blog', (req, res) => {
  const posts = db.prepare('SELECT * FROM blog_posts WHERE is_published = 1 ORDER BY created_at DESC').all();
  posts.forEach(p => { p.reading_time = readingTime(p.content || p.excerpt); });
  res.render('blog', { title: 'وبلاگ', posts });
});

router.get('/blog/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM blog_posts WHERE slug = ? AND is_published = 1').get(req.params.slug);
  if (!post) return res.status(404).render('404', { title: 'پیدا نشد' });
  post.content = sanitizeHtml(post.content);
  post.reading_time = readingTime(post.content);
  const prevPost = db.prepare('SELECT title, slug FROM blog_posts WHERE is_published = 1 AND created_at < ? ORDER BY created_at DESC LIMIT 1').get(post.created_at);
  const nextPost = db.prepare('SELECT title, slug FROM blog_posts WHERE is_published = 1 AND created_at > ? ORDER BY created_at ASC LIMIT 1').get(post.created_at);
  const relatedPosts = db.prepare('SELECT title, slug, cover_image FROM blog_posts WHERE is_published = 1 AND slug != ? ORDER BY created_at DESC LIMIT 3').all(post.slug);
  res.render('blog-detail', { title: post.title, post, prevPost, nextPost, relatedPosts });
});

// --- سبد خرید (ساده، در سشن ذخیره می‌شود) ---
router.post('/cart/add/:courseId', (req, res) => {
  req.session.cart = req.session.cart || [];
  const id = Number.parseInt(req.params.courseId, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).send('دوره نامعتبر است.');
  const course = db.prepare('SELECT id FROM courses WHERE id=? AND is_published=1').get(id);
  if (!course) return res.status(404).render('404', { title: 'دوره پیدا نشد' });
  if (req.session.user && db.prepare('SELECT 1 FROM enrollments WHERE user_id=? AND course_id=?').get(req.session.user.id, id)) {
    return res.redirect('/cart');
  }
  if (!req.session.cart.includes(id)) req.session.cart.push(id);
  res.redirect('/cart');
});

router.post('/cart/remove/:courseId', (req, res) => {
  const id = parseInt(req.params.courseId, 10);
  req.session.cart = (req.session.cart || []).filter(c => c !== id);
  res.redirect('/cart');
});

router.post('/cart/coupon',(req,res)=>{
  const code=(req.body.code||'').trim().toUpperCase();
  const c=db.prepare('SELECT * FROM coupons WHERE code=? AND is_active=1').get(code);
  if(!c || (c.expires_at && new Date(c.expires_at)<new Date()) || (c.max_uses && db.prepare("SELECT COUNT(*) c FROM orders WHERE coupon_id=? AND status='paid'").get(c.id).c>=c.max_uses)) return res.redirect('/cart');
  req.session.coupon={code:c.code}; res.redirect('/cart');
});
router.post('/cart/coupon/remove',(req,res)=>{ req.session.coupon=null; res.redirect('/cart'); });
router.post('/cart/referral',(req,res)=>{
  const code=String(req.body.code||'').trim().toUpperCase();
  const r=db.prepare('SELECT * FROM referral_codes WHERE code=?').get(code);
  if(r && (!req.session.user || r.user_id!==req.session.user.id)){ req.session.referralCode=code; }
  res.redirect('/cart');
});
router.post('/cart/referral/remove',(req,res)=>{ req.session.referralCode=null; res.redirect('/cart'); });
router.get('/cart',(req,res)=>{
  const ids=Array.isArray(req.session.cart)?req.session.cart:[]; const courseIds=[...new Set(ids.map(Number).filter(Number.isInteger).filter(x=>x>0))];
  let items=courseIds.length?db.prepare(`SELECT * FROM courses WHERE is_published=1 AND id IN (${courseIds.map(()=>'?').join(',')})`).all(...courseIds):[];
  // Never show a standalone course in the cart after the current user already owns it.
  // This prevents stale sessions from charging for an already-enrolled course.
  if(req.session.user && items.length){
    const owned=new Set(db.prepare(`SELECT course_id FROM enrollments WHERE user_id=? AND course_id IN (${items.map(()=>'?').join(',')})`).all(req.session.user.id,...items.map(c=>c.id)).map(r=>Number(r.course_id)));
    items=items.filter(c=>!owned.has(Number(c.id)));
  }
  items.forEach(effectivePrice);
  const bundleIds=[...new Set((Array.isArray(req.session.bundleCart)?req.session.bundleCart:[]).map(Number).filter(Number.isInteger).filter(x=>x>0))];
  const bundles=bundleIds.length?db.prepare(`SELECT * FROM bundles WHERE is_published=1 AND id IN (${bundleIds.map(()=>'?').join(',')})`).all(...bundleIds):[];
  req.session.cart=courseIds.filter(id=>items.some(c=>Number(c.id)===id));
  req.session.bundleCart=bundles.map(b=>Number(b.id));
  const pricedBundles=[];
  const seenBundleCourses=new Set();
  for(const b of bundles){
    const bis=db.prepare('SELECT c.id,c.is_published FROM bundle_items bi JOIN courses c ON c.id=bi.course_id WHERE bi.bundle_id=?').all(b.id);
    b.course_count=bis.length;
    if(!bis.length || bis.some(x=>!x.is_published)) continue;
    const remaining=req.session.user
      ? bis.filter(x=>!db.prepare('SELECT 1 FROM enrollments WHERE user_id=? AND course_id=?').get(req.session.user.id,Number(x.id)))
      : bis;
    if(!remaining.length) continue;
    if(remaining.some(x=>seenBundleCourses.has(Number(x.id)))) continue;
    remaining.forEach(x=>seenBundleCourses.add(Number(x.id)));
    b.charge_price=Math.floor(Number(b.price||0)*remaining.length/bis.length);
    pricedBundles.push(b);
  }
  bundles.splice(0,bundles.length,...pricedBundles);
  req.session.bundleCart=bundles.map(b=>Number(b.id));
  const bundleCourseIds=new Set();
  bundles.forEach(b=>{
    const bis=db.prepare('SELECT course_id FROM bundle_items WHERE bundle_id=?').all(b.id);
    bis.forEach(x=>bundleCourseIds.add(Number(x.course_id)));
  });
  // A course covered by a selected bundle is not a separately chargeable cart item.
  items=items.filter(c=>!bundleCourseIds.has(Number(c.id)));
  const subtotal=items.reduce((sum,c)=>sum+effectivePrice(c),0)+bundles.reduce((sum,b)=>sum+Number(b.charge_price||0),0);
  let coupon=null,discount=0;
  if(req.session.coupon){ coupon=db.prepare('SELECT * FROM coupons WHERE code=? AND is_active=1').get(req.session.coupon.code); if(!coupon || (coupon.expires_at&&new Date(coupon.expires_at)<new Date()) || (coupon.max_uses&&db.prepare("SELECT COUNT(*) c FROM orders WHERE coupon_id=? AND status='paid'").get(coupon.id).c>=coupon.max_uses)){req.session.coupon=null;coupon=null;} else {discount=coupon.type==='percent'?Math.floor(subtotal*coupon.value/100):coupon.value;discount=Math.min(discount,subtotal);} }
  let referral=null, referralDiscount=0;
  if(req.session.referralCode){ referral=db.prepare('SELECT * FROM referral_codes WHERE code=?').get(req.session.referralCode); if(referral && (!req.session.user || referral.user_id===req.session.user.id)){referral=null;req.session.referralCode=null;} else if(referral){ const pctRow=db.prepare("SELECT value FROM settings WHERE key='referral_reward_percent'").get(); const capRow=db.prepare("SELECT value FROM settings WHERE key='referral_discount_cap'").get(); const pct=Math.max(0,Math.min(100,Number(pctRow?.value ?? 5)||0)); const cap=Math.max(0,Number(capRow?.value ?? 100000)||0); referralDiscount=Math.min(cap,Math.floor(subtotal*pct/100)); } }
  const total=Math.max(0,subtotal-discount-referralDiscount);
  const cartIds=new Set(items.map(c=>Number(c.id)));
  const categoryIds=[...new Set(items.map(c=>c.category_id).filter(Boolean))];
  let recommended=[];
  const excluded=[...cartIds];
  if(categoryIds.length){
    const ex=excluded.length?`c.id NOT IN (${excluded.map(()=>'?').join(',')}) AND `:'';
    recommended=db.prepare(`SELECT c.*, cat.title AS category_title FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id WHERE c.is_published=1 AND ${ex}c.category_id IN (${categoryIds.map(()=>'?').join(',')}) ORDER BY c.is_featured DESC,c.sort_order ASC,c.id DESC LIMIT 4`).all(...excluded,...categoryIds);
  } else {
    const ex=excluded.length?`AND c.id NOT IN (${excluded.map(()=>'?').join(',')})`:'';
    recommended=db.prepare(`SELECT c.*, cat.title AS category_title FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id WHERE c.is_published=1 ${ex} ORDER BY c.is_featured DESC,c.sort_order ASC,c.id DESC LIMIT 4`).all(...excluded);
  }
  recommended.forEach(effectivePrice);
  const referralRewardPercentRow=db.prepare("SELECT value FROM settings WHERE key='referral_reward_percent'").get(); const referralRewardPercent=Math.max(0,Math.min(100,Number(referralRewardPercentRow?.value ?? 5)||0));
  res.render('cart',{title:'سبد خرید',items,bundles,subtotal,discount,referralDiscount,total,coupon,referral,recommended,referralRewardPercent});
});
router.get('/bundles',(req,res)=>{ const bundles=db.prepare('SELECT * FROM bundles WHERE is_published=1 ORDER BY created_at DESC').all(); bundles.forEach(b=>b.items=db.prepare('SELECT c.* FROM bundle_items bi JOIN courses c ON c.id=bi.course_id WHERE bi.bundle_id=? AND c.is_published=1').all(b.id)); res.render('bundles',{title:'پکیج‌ها',bundles}); });
router.post('/cart/bundle/add/:id',(req,res)=>{
  const id=Number(req.params.id);
  const b=db.prepare('SELECT id FROM bundles WHERE id=? AND is_published=1').get(id);
  if(b){
    req.session.bundleCart=req.session.bundleCart||[];
    if(!req.session.bundleCart.includes(id)){
      const existing=req.session.bundleCart.map(Number).filter(Number.isInteger);
      if(existing.length){
        const placeholders=existing.map(()=>'?').join(',');
        const overlap=db.prepare(`SELECT 1 FROM bundle_items x JOIN bundle_items y ON x.course_id=y.course_id WHERE x.bundle_id IN (${placeholders}) AND y.bundle_id=? LIMIT 1`).get(...existing,id);
        if(overlap) return res.redirect('/cart?error='+encodeURIComponent('این پکیج با یکی از پکیج‌های سبد دوره مشترک دارد.'));
      }
      req.session.bundleCart.push(id);
    }
  }
  res.redirect('/cart');
});
router.post('/cart/bundle/remove/:id',(req,res)=>{ const id=Number(req.params.id); req.session.bundleCart=(req.session.bundleCart||[]).filter(x=>x!==id); res.redirect('/cart'); });
router.get('/referral',(req,res)=>{ if(!req.session.user)return res.redirect('/login'); let rc=db.prepare('SELECT * FROM referral_codes WHERE user_id=?').get(req.session.user.id); if(!rc){ const code='GLOW-'+req.session.user.id+'-'+crypto.randomBytes(2).toString('hex').toUpperCase(); db.prepare('INSERT INTO referral_codes(user_id,code) VALUES(?,?)').run(req.session.user.id,code); rc={code}; } const stats=db.prepare("SELECT COUNT(*) c FROM referrals WHERE referrer_id=? AND status='rewarded'").get(req.session.user.id).c; const rewardRow=db.prepare("SELECT COALESCE(SUM(amount),0) total FROM referral_rewards WHERE referrer_id=?").get(req.session.user.id); const rewardTotal=Number(rewardRow.total||0); res.render('referral',{title:'معرفی دوستان',referralCode:rc.code,rewarded:stats,rewardTotal}); });
module.exports = router;
