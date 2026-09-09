const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../db');
const { requireAdmin, requireRole } = require('../middleware/auth');

router.use(requireAdmin);

// Role-aware permissions: keep navigation and server-side access in sync.
router.use((req, res, next) => {
  res.locals.adminError = String(req.query.error || '');
  res.locals.adminNotice = String(req.query.notice || '');
  const role = req.session.user?.role;
  if (role === 'admin') return next();
  const p = req.path;
  const editorAllowed = [
    /^\/courses(?:\/|$)/, /^\/sessions(?:\/|$)/, /^\/blog(?:\/|$)/,
    /^\/categories(?:\/|$)/, /^\/homepage(?:\/|$)/, /^\/banners(?:\/|$)/,
    /^\/menu(?:\/|$)/, /^\/media(?:\/|$)/
  ];
  const supportAllowed = [
    /^\/users(?:\/|$)/, /^\/orders(?:\/|$)/, /^\/reviews(?:\/|$)/,
    /^\/notifications(?:\/|$)/
  ];
  const shared = p === '/search' || p === '/accessible';
  if (role === 'editor' && (shared || editorAllowed.some(re => re.test(p)))) return next();
  if (role === 'support' && (shared || supportAllowed.some(re => re.test(p)))) return next();
  // Non-admin users get a safe operational home instead of financial/admin data.
  if ((role === 'editor' || role === 'support') && req.method === 'GET' && p === '/') return res.redirect('/admin/accessible');
  return res.status(403).render('403', { title: 'این بخش برای نقش شما فعال نیست' });
});

// Safe landing page for non-admin roles.
router.get('/accessible', (req, res) => {
  const role = req.session.user?.role;
  if (role === 'admin') return res.redirect('/admin');
  const data = role === 'support'
    ? {
        title: 'مرکز پشتیبانی',
        cards: [
          {label:'کاربران', value: db.prepare('SELECT COUNT(*) c FROM users WHERE role=\'user\'').get().c, href:'/admin/users'},
          {label:'سفارش‌ها', value: db.prepare('SELECT COUNT(*) c FROM orders').get().c, href:'/admin/orders'},
          {label:'نظرات', value: db.prepare('SELECT COUNT(*) c FROM reviews WHERE is_approved=0').get().c, href:'/admin/reviews'},
          {label:'اعلان‌ها', value: db.prepare('SELECT COUNT(*) c FROM notifications').get().c, href:'/admin/notifications'}
        ]
      }
    : {
        title: 'مرکز محتوا',
        cards: [
          {label:'دوره‌ها', value: db.prepare('SELECT COUNT(*) c FROM courses').get().c, href:'/admin/courses'},
          {label:'دوره‌های منتشرشده', value: db.prepare('SELECT COUNT(*) c FROM courses WHERE is_published=1').get().c, href:'/admin/courses'},
          {label:'مطالب وبلاگ', value: db.prepare('SELECT COUNT(*) c FROM blog_posts').get().c, href:'/admin/blog'},
          {label:'رسانه‌ها', value: db.prepare('SELECT COUNT(*) c FROM media_assets').get().c, href:'/admin/media'}
        ]
      };
  res.render('admin/accessible', data);
});

// اعلان‌های اخیر پنل ادمین (کاربر جدید / سفارش موفق) — روی همه صفحات ادمین در دسترس است
router.use((req, res, next) => {
  try {
    const recentUsers = db.prepare("SELECT full_name AS label, created_at, 'user' AS type FROM users ORDER BY created_at DESC LIMIT 4").all();
    const recentPaid = db.prepare(`
      SELECT users.full_name AS label, orders.created_at, 'order' AS type
      FROM orders JOIN users ON users.id = orders.user_id
      WHERE orders.status = 'paid' ORDER BY orders.created_at DESC LIMIT 4
    `).all();
    res.locals.adminNotifications = [...recentUsers, ...recentPaid]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 6);
  } catch (e) {
    res.locals.adminNotifications = [];
  }
  next();
});

const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { UPLOADS_DIR: uploadsDir, VIDEOS_DIR: videosDir, BACKUPS_DIR: backupsDir, DB_PATH } = require('../config');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });

const maxImageMB = Math.max(1, Math.min(Number(process.env.MAX_IMAGE_MB) || 8, 100));
const maxVideoMB = Math.max(1, Math.min(Number(process.env.MAX_VIDEO_MB) || 1024, 2048));
const maxImageBytes = maxImageMB * 1024 * 1024;
const maxVideoBytes = maxVideoMB * 1024 * 1024;
const imageMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function safeFilename(originalName, fallbackExt = '') {
  const ext = fallbackExt || path.extname(originalName || '').toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10) || '.bin';
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

function removeUploadUrl(url) {
  const raw = String(url || '');
  if (!raw.startsWith('/uploads/')) return false;
  const root = path.resolve(uploadsDir);
  const target = path.resolve(uploadsDir, raw.replace(/^\/uploads\//, ''));
  if (!(target === root || target.startsWith(root + path.sep))) return false;
  try { fs.unlinkSync(target); return true; } catch (_) { return false; }
}
const mimeExt = { 'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp', 'image/gif':'.gif', 'video/mp4':'.mp4', 'video/webm':'.webm', 'video/quicktime':'.mov', 'video/x-matroska':'.mkv', 'application/pdf':'.pdf', 'audio/mpeg':'.mp3', 'audio/wav':'.wav', 'audio/ogg':'.ogg', 'text/plain':'.txt' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname, mimeExt[file.mimetype] || '.bin'))
});
const upload = multer({
  storage,
  limits: { fileSize: maxImageBytes, files: 1 },
  fileFilter: (req, file, cb) => cb(null, imageMimes.has(file.mimetype))
});

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, videosDir),
  filename: (req, file, cb) => cb(null, safeFilename(file.originalname, mimeExt[file.mimetype] || '.mp4'))
});
const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: maxVideoBytes, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^video\/(mp4|webm|quicktime|x-matroska)$/.test(file.mimetype))
});


function csrfRejected(req) {
  const supplied = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const expected = String(req.session.csrfToken || '');
  if (!supplied || !expected || supplied.length !== expected.length) return true;
  try { return !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected)); }
  catch (_) { return true; }
}

function rejectCsrf(req, res, file) {
  removeUploadedFile(file);
  console.warn('⚠️ CSRF rejected:', req.method, req.originalUrl, '| session:', req.sessionID);
  const back = safeAdminRedirect(req, res, '/admin');
  const sep = back.includes('?') ? '&' : '?';
  return res.redirect(back + sep + 'error=' + encodeURIComponent('فرم قدیمی یا منقضی شده بود. صفحه را تازه کن و دوباره ذخیره کن.'));
}

const safeUpload = (req, res, next) => upload.single('cover_image')(req, res, (err) => {
  if (err) return res.redirect(safeAdminRedirect(req, res, '/admin') + (safeAdminRedirect(req, res, '/admin').includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'حجم تصویر بیش از حد مجاز است' : 'فایل تصویر نامعتبر است'));
  if (csrfRejected(req)) return rejectCsrf(req, res, req.file);
  next();
});
const safeUploadVideo = (req, res, next) => uploadVideo.single('video_file')(req, res, (err) => {
  if (err) return res.redirect(safeAdminRedirect(req, res, '/admin') + (safeAdminRedirect(req, res, '/admin').includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.code === 'LIMIT_FILE_SIZE' ? 'حجم ویدیو بیش از حد مجاز است' : 'فایل ویدیو نامعتبر است'));
  if (csrfRejected(req)) return rejectCsrf(req, res, req.file);
  next();
});

function removeUploadedFile(file) {
  if (!file?.path) return;
  try { fs.unlinkSync(file.path); } catch (e) {}
}

function uploadError(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError || err.message) {
    console.warn('⚠️ Upload rejected:', err.code || err.message);
    const back = safeAdminRedirect(req, res, '/admin'); const sep = back.includes('?') ? '&' : '?'; return res.redirect(back + sep + 'error=' + encodeURIComponent('فایل نامعتبر یا بیش از حد مجاز است'));
  }
  next(err);
}

function slugify(str) {
  return str.toString().trim().toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s-]/g, '')
    .replace(/\s+/g, '-');
}
function safeNavUrl(value, fallback='/') {
  const url=String(value||'').trim().slice(0,240);
  if (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url) || /^#[^\s]*$/.test(url)) return url;
  return fallback;
}
function safeAdminRedirect(req, res, fallback='/admin') {
  const raw = req.get('referer');
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.origin === `${req.protocol}://${req.get('host')}` && u.pathname.startsWith('/admin')) {
        return u.pathname + u.search;
      }
    } catch (_) {}
  }
  return fallback;
}
function positiveId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function intValue(value, fallback=0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Log admin mutations for audit trail
router.use((req,res,next)=>{
  if(req.method==='POST'){
    try {
      const safeBody = {...(req.body||{})};
      ['password','password_hash','_csrf'].forEach(k=>delete safeBody[k]);
      db.prepare('INSERT INTO activity_logs(user_id,action,entity,entity_id,meta) VALUES(?,?,?,?,?)')
        .run(req.session.user?.id||null, req.path, req.path.split('/')[1]||'admin', Number(req.params.id)||null, JSON.stringify(safeBody).slice(0,1000));
    } catch(e) {}
  }
  next();
});

// ---------- جستجوی سراسری پنل ادمین (برای Command Palette) ----------
router.get('/search', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  if (!q || q === '%%') return res.json({ courses: [], users: [], orders: [] });
  const courses = db.prepare('SELECT id, title, slug FROM courses WHERE title LIKE ? LIMIT 5').all(q);
  const users = db.prepare('SELECT id, full_name, phone FROM users WHERE full_name LIKE ? OR phone LIKE ? LIMIT 5').all(q, q);
  const orders = db.prepare(`
    SELECT orders.id, orders.amount, orders.status, users.full_name FROM orders
    JOIN users ON users.id = orders.user_id
    WHERE users.full_name LIKE ? OR orders.ref_id LIKE ? LIMIT 5
  `).all(q, q);
  res.json({ courses, users, orders });
});

// Stable aliases: old bookmarks/links to /admin/dashboard should never become a 404.
router.get('/dashboard', (req, res) => res.redirect('/admin'));

router.get('/marketing/export.csv', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT id, code, type, value, max_uses, expires_at, is_active, created_at FROM coupons ORDER BY created_at DESC`).all();
  const esc = v => '"' + String(v ?? '').replace(/"/g,'""') + '"';
  const csv = ['id,code,type,value,max_uses,expires_at,is_active,created_at', ...rows.map(r => [r.id,r.code,r.type,r.value,r.max_uses,r.expires_at,r.is_active,r.created_at].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename=glowup-marketing-coupons.csv');
  res.send('\uFEFF' + csv);
});

// ---------- Dashboard ----------
router.get('/', (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    courses: db.prepare('SELECT COUNT(*) c FROM courses').get().c,
    orders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'paid'").get().c,
    revenue: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status = 'paid'").get().s,
    posts: db.prepare('SELECT COUNT(*) c FROM blog_posts').get().c,
    publishedCourses: db.prepare('SELECT COUNT(*) c FROM courses WHERE is_published=1').get().c,
    pendingOrders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending'").get().c,
    monthlyRevenue: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='paid' AND created_at >= date('now','start of month')").get().s,
    todayRevenue: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='paid' AND date(created_at,'localtime')=date('now','localtime')").get().s,
    todayOrders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid' AND date(created_at,'localtime')=date('now','localtime')").get().c,
    newUsersToday: db.prepare("SELECT COUNT(*) c FROM users WHERE date(created_at,'localtime')=date('now','localtime') AND role='user'").get().c,
    enrollments: db.prepare('SELECT COUNT(*) c FROM enrollments').get().c,
    pendingReviews: db.prepare("SELECT COUNT(*) c FROM reviews WHERE is_approved=0").get().c
  };

  // روند ۷ روز اخیر در مقابل ۷ روز قبل‌تر، برای فلش‌های رشد/افت
  const thisWeekRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='paid' AND created_at >= date('now','-6 days')").get().s;
  const lastWeekRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='paid' AND created_at >= date('now','-13 days') AND created_at < date('now','-6 days')").get().s;
  const thisWeekOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid' AND created_at >= date('now','-6 days')").get().c;
  const lastWeekOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid' AND created_at >= date('now','-13 days') AND created_at < date('now','-6 days')").get().c;
  const thisWeekUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE created_at >= date('now','-6 days')").get().c;
  const lastWeekUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE created_at >= date('now','-13 days') AND created_at < date('now','-6 days')").get().c;

  function trend(cur, prev) {
    if (!prev) return { dir: cur > 0 ? 'up' : 'flat', pct: cur > 0 ? 100 : 0 };
    const pct = Math.round(((cur - prev) / prev) * 100);
    return { dir: pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat'), pct: Math.abs(pct) };
  }
  stats.trends = {
    revenue: trend(thisWeekRevenue, lastWeekRevenue),
    orders: trend(thisWeekOrders, lastWeekOrders),
    users: trend(thisWeekUsers, lastWeekUsers)
  };

  // نمودار درآمد ۱۴ روز اخیر
  const rows = db.prepare(`
    SELECT date(created_at) d, COALESCE(SUM(amount),0) total
    FROM orders WHERE status = 'paid' AND created_at >= date('now','-13 days')
    GROUP BY d
  `).all();
  const byDate = Object.fromEntries(rows.map(r => [r.d, r.total]));
  const revenueChart = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    revenueChart.push({ date: key, total: byDate[key] || 0 });
  }

  const recentOrders = db.prepare(`
    SELECT orders.*, users.full_name, users.phone FROM orders
    JOIN users ON users.id = orders.user_id
    ORDER BY orders.created_at DESC LIMIT 8
  `).all();
  const topCourses = db.prepare(`
    SELECT c.title, COUNT(oi.id) sales, COALESCE(SUM(oi.price),0) revenue
    FROM order_items oi JOIN courses c ON c.id=oi.course_id
    JOIN orders o ON o.id=oi.order_id AND o.status='paid'
    GROUP BY c.id ORDER BY sales DESC LIMIT 6
  `).all();
  const recentUsers = db.prepare(`SELECT id, full_name, phone, created_at FROM users WHERE role='user' ORDER BY created_at DESC LIMIT 6`).all();
  const recentActivity = db.prepare(`
    SELECT 'order' type, o.id ref_id, u.full_name label, o.amount value, o.created_at
    FROM orders o JOIN users u ON u.id=o.user_id
    UNION ALL
    SELECT 'user' type, u.id ref_id, u.full_name label, NULL value, u.created_at
    FROM users u WHERE u.role='user'
    ORDER BY created_at DESC LIMIT 10
  `).all();
  const attention = [
    { label:'سفارش‌های در انتظار پرداخت', value:stats.pendingOrders, href:'/admin/orders', tone:stats.pendingOrders?'warn':'ok', icon:'⏳' },
    { label:'نظرات منتظر تأیید', value:stats.pendingReviews, href:'/admin/reviews', tone:stats.pendingReviews?'warn':'ok', icon:'★' },
    { label:'دوره‌های منتشرشده', value:stats.publishedCourses + ' / ' + stats.courses, href:'/admin/courses', tone:stats.publishedCourses < stats.courses?'info':'ok', icon:'🎓' }
  ];
  res.render('admin/dashboard', { title: 'داشبورد ادمین', stats, recentOrders, topCourses, revenueChart, recentUsers, recentActivity, attention });
});

// Course Builder Pro readiness endpoint.
router.get('/courses/:id/health', (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ok:false,error:'invalid_id'});
  const c = db.prepare('SELECT * FROM courses WHERE id=?').get(id);
  if (!c) return res.status(404).json({ok:false,error:'not_found'});
  const sessionStats = db.prepare(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN video_url IS NOT NULL AND TRIM(video_url)<>'' THEN 1 ELSE 0 END),0) videos, COALESCE(SUM(CASE WHEN is_free_preview=1 THEN 1 ELSE 0 END),0) previews FROM course_sessions WHERE course_id=?`).get(id);
  const checks = {
    title: !!String(c.title||'').trim(), subtitle: !!String(c.subtitle||'').trim(), description: String(c.description||'').trim().length >= 80,
    cover: !!c.cover_image, category: !!c.category_id, price: Number(c.price)>=0, sessions: sessionStats.total>0, videos: sessionStats.total===0 || sessionStats.videos===sessionStats.total
  };
  const score = Math.round(Object.values(checks).filter(Boolean).length/Object.keys(checks).length*100);
  res.json({ok:true,score,checks,sessions:sessionStats});
});

// ---------- Courses ----------
router.get('/courses', (req, res) => {
  const courses = db.prepare(`
    SELECT courses.*, categories.title AS category_title FROM courses
    LEFT JOIN categories ON categories.id = courses.category_id
    ORDER BY courses.sort_order
  `).all();
  res.render('admin/courses', { title: 'مدیریت دوره‌ها', courses });
});

router.get('/courses/new', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories').all();
  res.render('admin/course-form', { title: 'دوره جدید', course: null, categories });
});

router.post('/courses/new', safeUpload, (req, res) => {
  const b = req.body;
  const title = String(b.title || '').trim().slice(0, 180);
  const price = Math.max(0, intValue(b.price, 0));
  const discount = b.discount_price === '' || b.discount_price == null ? null : Math.max(0, intValue(b.discount_price, 0));
  if (!title) { removeUploadedFile(req.file); return res.redirect('/admin/courses/new?error=' + encodeURIComponent('عنوان دوره الزامی است.')); }
  if (discount !== null && discount > price) { removeUploadedFile(req.file); return res.redirect('/admin/courses/new?error=' + encodeURIComponent('قیمت تخفیف‌خورده نباید بیشتر از قیمت اصلی باشد.')); }
  const categoryId = b.category_id ? positiveId(b.category_id) : null;
  if (categoryId && !db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) { removeUploadedFile(req.file); return res.redirect('/admin/courses/new?error=' + encodeURIComponent('دسته‌بندی انتخاب‌شده وجود ندارد.')); }
  const cover = req.file ? '/uploads/' + req.file.filename : null;
  db.prepare(`
    INSERT INTO courses (title, slug, subtitle, description, cover_image, price, discount_price, sessions_count, category_id, is_published, is_featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title, slugify(title) + '-' + Date.now().toString().slice(-4), b.subtitle, b.description, cover,
    price, discount,
    0, categoryId,
    b.is_published ? 1 : 0, b.is_featured ? 1 : 0
  );
  res.redirect('/admin/courses');
});

router.get('/courses/:id/edit', (req, res) => {
  const course = db.prepare('SELECT * FROM courses WHERE id = ?').get(req.params.id);
  if (!course) return res.redirect('/admin/courses?error=' + encodeURIComponent('دوره موردنظر پیدا نشد.'));
  const categories = db.prepare('SELECT * FROM categories').all();
  const sessions = db.prepare('SELECT * FROM course_sessions WHERE course_id = ? ORDER BY sort_order').all(course.id);
  res.render('admin/course-form', { title: 'ویرایش دوره', course, categories, sessions });
});

// Course Builder Pro: duplicate a course as a safe draft, including its lesson structure.
router.post('/courses/:id/duplicate', (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.redirect('/admin/courses?error=' + encodeURIComponent('شناسه دوره نامعتبر است.'));
  const source = db.prepare('SELECT * FROM courses WHERE id=?').get(id);
  if (!source) return res.redirect('/admin/courses?error=' + encodeURIComponent('دوره موردنظر پیدا نشد.'));
  const slug = slugify(`${source.title}-کپی`) + '-' + Date.now().toString().slice(-6);
  const info = db.prepare(`INSERT INTO courses (title,slug,subtitle,description,cover_image,price,discount_price,sessions_count,category_id,is_published,is_featured,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`${source.title} — کپی`, slug, source.subtitle, source.description, source.cover_image, source.price, source.discount_price, 0, source.category_id || null, 0, 0, source.sort_order || 0);
  const newId = Number(info.lastInsertRowid);
  const sessions = db.prepare('SELECT title,phase,video_url,duration_seconds,sort_order,is_free_preview FROM course_sessions WHERE course_id=? ORDER BY sort_order,id').all(id);
  const ins = db.prepare('INSERT INTO course_sessions (course_id,title,phase,video_url,duration_seconds,sort_order,is_free_preview) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => sessions.forEach(x => ins.run(newId,x.title,x.phase,x.video_url,x.duration_seconds,x.sort_order,x.is_free_preview)))();
  db.prepare('UPDATE courses SET sessions_count=(SELECT COUNT(*) FROM course_sessions WHERE course_id=?) WHERE id=?').run(newId,newId);
  res.redirect(`/admin/courses/${newId}/edit?notice=${encodeURIComponent('نسخه کپی ساخته شد؛ به‌صورت پیش‌نویس آماده ویرایش است.')}`);
});

router.post('/courses/:id/edit', safeUpload, (req, res) => {
  const id = positiveId(req.params.id);
  const b = req.body;
  if (!id) { removeUploadedFile(req.file); return res.redirect('/admin/courses?error=' + encodeURIComponent('شناسه دوره نامعتبر است.')); }
  const existing = db.prepare('SELECT cover_image FROM courses WHERE id = ?').get(req.params.id);
  if (!existing) { removeUploadedFile(req.file); return res.redirect('/admin/courses?error=' + encodeURIComponent('دوره موردنظر پیدا نشد.')); }
  const title = String(b.title || '').trim().slice(0, 180);
  const price = Math.max(0, intValue(b.price, 0));
  const discount = b.discount_price === '' || b.discount_price == null ? null : Math.max(0, intValue(b.discount_price, 0));
  if (!title) { removeUploadedFile(req.file); return res.redirect(`/admin/courses/${id}/edit?error=` + encodeURIComponent('عنوان دوره الزامی است.')); }
  if (discount !== null && discount > price) { removeUploadedFile(req.file); return res.redirect(`/admin/courses/${id}/edit?error=` + encodeURIComponent('قیمت تخفیف‌خورده نباید بیشتر از قیمت اصلی باشد.')); }
  const categoryId = b.category_id ? positiveId(b.category_id) : null;
  if (categoryId && !db.prepare('SELECT id FROM categories WHERE id=?').get(categoryId)) { removeUploadedFile(req.file); return res.redirect(`/admin/courses/${id}/edit?error=` + encodeURIComponent('دسته‌بندی انتخاب‌شده وجود ندارد.')); }
  const cover = req.file ? '/uploads/' + req.file.filename : existing.cover_image;
  const actualSessionsCount = Number(db.prepare('SELECT COUNT(*) AS c FROM course_sessions WHERE course_id=?').get(id).c || 0);
  db.prepare(`
    UPDATE courses SET title=?, subtitle=?, description=?, cover_image=?, price=?, discount_price=?,
    sessions_count=?, category_id=?, is_published=?, is_featured=? WHERE id=?
  `).run(
    title, String(b.subtitle || '').slice(0,300), String(b.description || '').slice(0,10000), cover,
    price, discount,
    actualSessionsCount, categoryId,
    b.is_published ? 1 : 0, b.is_featured ? 1 : 0,
    id
  );
  // Uploaded covers live under DATA_DIR/uploads (not public/uploads).
  // Remove the previous local cover after a successful replacement so old files
  // do not accumulate on the persistent disk.
  if (req.file && existing.cover_image && existing.cover_image !== cover) {
    removeUploadUrl(existing.cover_image);
  }
  res.redirect('/admin/courses');
});

router.post('/courses/bulk', (req, res) => {
  const ids = Array.isArray(req.body.course_ids) ? req.body.course_ids : (req.body.course_ids ? [req.body.course_ids] : []);
  const action = String(req.body.action || '');
  const allowedActions = new Set(['publish','draft','feature','unfeature']);
  const cleanIds = [...new Set(ids.map(Number).filter(Number.isInteger).filter(id=>id>0))];
  if (!cleanIds.length) return res.redirect('/admin/courses?error='+encodeURIComponent('حداقل یک دوره را انتخاب کن.'));
  if (!allowedActions.has(action)) return res.redirect('/admin/courses?error='+encodeURIComponent('عملیات گروهی معتبر نیست.'));
  const placeholders = cleanIds.map(() => '?').join(',');
  const existingCount = db.prepare(`SELECT COUNT(*) AS c FROM courses WHERE id IN (${placeholders})`).get(...cleanIds).c;
  if (existingCount !== cleanIds.length) return res.redirect('/admin/courses?error='+encodeURIComponent('یکی از دوره‌های انتخاب‌شده دیگر وجود ندارد.'));
  if (action === 'publish') db.prepare(`UPDATE courses SET is_published=1 WHERE id IN (${placeholders})`).run(...cleanIds);
  if (action === 'draft') db.prepare(`UPDATE courses SET is_published=0 WHERE id IN (${placeholders})`).run(...cleanIds);
  if (action === 'feature') db.prepare(`UPDATE courses SET is_featured=1 WHERE id IN (${placeholders})`).run(...cleanIds);
  if (action === 'unfeature') db.prepare(`UPDATE courses SET is_featured=0 WHERE id IN (${placeholders})`).run(...cleanIds);
  res.redirect('/admin/courses?notice='+encodeURIComponent('عملیات گروهی با موفقیت انجام شد.'));
});

router.post('/courses/:id/delete', (req, res) => {
  const id=positiveId(req.params.id);
  if (!id) return res.redirect('/admin/courses?error=' + encodeURIComponent('شناسه دوره نامعتبر است.'));
  const used=db.prepare('SELECT (SELECT COUNT(*) FROM order_items WHERE course_id=?) + (SELECT COUNT(*) FROM enrollments WHERE course_id=?) AS c').get(id,id).c;
  if (used>0) {
    db.prepare('UPDATE courses SET is_published=0,is_featured=0 WHERE id=?').run(id);
    return res.redirect('/admin/courses?notice='+encodeURIComponent('این دوره سابقه خرید دارد؛ به‌جای حذف، از سایت خارج شد تا سوابق سفارش‌ها حفظ شود.'));
  }
  const videos = db.prepare("SELECT video_url FROM course_sessions WHERE course_id=? AND video_url LIKE '/uploads/videos/%'").all(id);
  db.transaction(() => {
    db.prepare('DELETE FROM course_sessions WHERE course_id=?').run(id);
    db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  })();
  videos.forEach(v => removeUploadUrl(v.video_url));
  res.redirect('/admin/courses?notice='+encodeURIComponent('دوره و فایل‌های ویدیویی مستقل آن حذف شد.'));
});

// جلسات دوره — یا لینک ویدیو وارد کن یا فایل آپلود کن (اگر فایل بفرستی، اولویت با فایل است)
router.post('/courses/:id/sessions/new', safeUploadVideo, (req, res) => {
  const courseId = positiveId(req.params.id);
  if (!courseId) { removeUploadedFile(req.file); return res.redirect('/admin/courses?error=' + encodeURIComponent('شناسه دوره نامعتبر است.')); }
  const course = db.prepare('SELECT id FROM courses WHERE id=?').get(courseId);
  if (!course) { removeUploadedFile(req.file); return res.redirect('/admin/courses?error=' + encodeURIComponent('دوره موردنظر پیدا نشد.')); }
  const { title, phase, video_url, duration_seconds, is_free_preview } = req.body;
  const cleanTitle = String(title || '').trim().slice(0,180);
  if (!cleanTitle) { removeUploadedFile(req.file); return res.redirect(`/admin/courses/${courseId}/edit?error=` + encodeURIComponent('عنوان جلسه الزامی است.')); }
  const finalVideoUrl = req.file ? '/uploads/videos/' + req.file.filename : String(video_url || '').trim().slice(0,1000);
  if (!finalVideoUrl) { removeUploadedFile(req.file); return res.redirect(`/admin/courses/${courseId}/edit?error=` + encodeURIComponent('لینک ویدیو یا فایل ویدیو الزامی است.')); }
  db.prepare(`
    INSERT INTO course_sessions (course_id, title, phase, video_url, duration_seconds, is_free_preview, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order),0)+1 FROM course_sessions WHERE course_id=?))
  `).run(courseId, title, phase || null, finalVideoUrl, Math.max(0, intValue(duration_seconds, 0)), is_free_preview ? 1 : 0, courseId);
  db.prepare('UPDATE courses SET sessions_count=(SELECT COUNT(*) FROM course_sessions WHERE course_id=?) WHERE id=?').run(courseId, courseId);
  res.redirect(`/admin/courses/${courseId}/edit`);
});

router.get('/sessions/:sessionId/edit', (req, res) => {
  const sessionId = positiveId(req.params.sessionId);
  if (!sessionId) return res.redirect('/admin/courses?error=' + encodeURIComponent('شناسه جلسه نامعتبر است.'));
  const session = db.prepare('SELECT * FROM course_sessions WHERE id = ?').get(sessionId);
  if (!session) return res.redirect('/admin/courses?error=' + encodeURIComponent('جلسه موردنظر پیدا نشد.'));
  res.render('admin/session-form', { title: 'ویرایش جلسه', session });
});

router.post('/sessions/:sessionId/edit', safeUploadVideo, (req, res) => {
  const sessionId = positiveId(req.params.sessionId);
  if (!sessionId) { removeUploadedFile(req.file); return res.redirect('/admin/courses?error=' + encodeURIComponent('شناسه جلسه نامعتبر است.')); }
  const { title, phase, video_url, duration_seconds, is_free_preview } = req.body;
  const cleanTitle = String(title || '').trim().slice(0,180);
  const existing = db.prepare('SELECT video_url, course_id FROM course_sessions WHERE id = ?').get(sessionId);
  if (!existing) { removeUploadedFile(req.file); return res.redirect('/admin/courses?error=' + encodeURIComponent('جلسه موردنظر پیدا نشد.')); }
  if (!cleanTitle) { removeUploadedFile(req.file); return res.redirect(`/admin/sessions/${sessionId}/edit?error=` + encodeURIComponent('عنوان جلسه الزامی است.')); }
  const finalVideoUrl = req.file ? '/uploads/videos/' + req.file.filename : (String(video_url || '').trim().slice(0,1000) || existing.video_url);
  // Replacing an uploaded lesson video must also remove the old file from
  // persistent storage. Keep externally-hosted URLs untouched.
  db.prepare(`
    UPDATE course_sessions SET title=?, phase=?, video_url=?, duration_seconds=?, is_free_preview=? WHERE id=?
  `).run(cleanTitle, String(phase||'').trim().slice(0,120) || null, finalVideoUrl, Math.max(0, intValue(duration_seconds, 0)), is_free_preview ? 1 : 0, sessionId);
  if (req.file && existing.video_url && existing.video_url !== finalVideoUrl) {
    removeUploadUrl(existing.video_url);
  }
  db.prepare('UPDATE courses SET sessions_count=(SELECT COUNT(*) FROM course_sessions WHERE course_id=?) WHERE id=?').run(existing.course_id, existing.course_id);
  res.redirect(`/admin/courses/${existing.course_id}/edit`);
});

router.post('/sessions/:sessionId/move', (req, res) => {
  const { direction } = req.body; // 'up' | 'down'
  const current = db.prepare('SELECT * FROM course_sessions WHERE id = ?').get(req.params.sessionId);
  if (!current) return res.redirect('/admin/courses');
  const neighbor = direction === 'up'
    ? db.prepare('SELECT * FROM course_sessions WHERE course_id = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT 1').get(current.course_id, current.sort_order)
    : db.prepare('SELECT * FROM course_sessions WHERE course_id = ? AND sort_order > ? ORDER BY sort_order ASC LIMIT 1').get(current.course_id, current.sort_order);
  if (neighbor) {
    const swap = db.transaction(() => {
      db.prepare('UPDATE course_sessions SET sort_order = ? WHERE id = ?').run(neighbor.sort_order, current.id);
      db.prepare('UPDATE course_sessions SET sort_order = ? WHERE id = ?').run(current.sort_order, neighbor.id);
    });
    swap();
  }
  res.redirect(`/admin/courses/${current.course_id}/edit`);
});

router.post('/sessions/:sessionId/delete', (req, res) => {
  const sessionId = positiveId(req.params.sessionId);
  const s = db.prepare('SELECT course_id FROM course_sessions WHERE id = ?').get(sessionId);
  if (!s) return res.redirect('/admin/courses?error=' + encodeURIComponent('جلسه موردنظر پیدا نشد.'));
  db.prepare('DELETE FROM course_sessions WHERE id = ?').run(sessionId);
  db.prepare('UPDATE courses SET sessions_count=(SELECT COUNT(*) FROM course_sessions WHERE course_id=?) WHERE id=?').run(s.course_id, s.course_id);
  res.redirect(`/admin/courses/${s.course_id}/edit`);
});

// ---------- P1: Bundles ----------
router.get('/bundles',(req,res)=>{const bundles=db.prepare('SELECT b.*,COUNT(bi.id) course_count FROM bundles b LEFT JOIN bundle_items bi ON bi.bundle_id=b.id GROUP BY b.id ORDER BY b.created_at DESC').all();const courses=db.prepare('SELECT id,title,price,discount_price FROM courses ORDER BY title').all();res.render('admin/bundles',{title:'پکیج‌های فروش',bundles,courses});});
router.post('/bundles/new',(req,res)=>{const title=String(req.body.title||'').trim();const price=Math.max(0,parseInt(req.body.price||0));const rawIds=Array.isArray(req.body.course_ids)?req.body.course_ids:[req.body.course_ids];const ids=[...new Set(rawIds.map(Number).filter(Number.isInteger).filter(x=>x>0))];if(!title||price<=0)return res.redirect('/admin/bundles?error='+encodeURIComponent('عنوان و قیمت معتبر الزامی است'));if(!ids.length)return res.redirect('/admin/bundles?error='+encodeURIComponent('حداقل یک دوره برای پکیج انتخاب کن'));const valid=db.prepare(`SELECT id FROM courses WHERE id IN (${ids.map(()=>'?').join(',')})`).all(...ids).map(x=>Number(x.id));if(valid.length!==ids.length)return res.redirect('/admin/bundles?error='+encodeURIComponent('یکی از دوره‌های انتخاب‌شده معتبر نیست'));const slug=slugify(title)+'-'+Date.now().toString().slice(-5);const info=db.prepare('INSERT INTO bundles(title,slug,description,price,is_published) VALUES(?,?,?,?,?)').run(title,slug,String(req.body.description||'').slice(0,1000),price,req.body.is_published?1:0);const ins=db.prepare('INSERT OR IGNORE INTO bundle_items(bundle_id,course_id) VALUES(?,?)');ids.forEach(id=>ins.run(info.lastInsertRowid,id));res.redirect('/admin/bundles');});
router.post('/bundles/:id/delete',(req,res)=>{db.prepare('DELETE FROM bundles WHERE id=?').run(req.params.id);res.redirect('/admin/bundles');});
// ---------- P1: Flash sales ----------
router.get('/flash-sales',(req,res)=>{const sales=db.prepare('SELECT fs.*,c.title FROM flash_sales fs JOIN courses c ON c.id=fs.course_id ORDER BY fs.ends_at DESC').all();const courses=db.prepare('SELECT id,title,price,discount_price FROM courses ORDER BY title').all();res.render('admin/flash-sales',{title:'فروش فوری',sales,courses});});
router.post('/flash-sales/new',(req,res)=>{const cid=Number(req.body.course_id), sp=Math.max(1,parseInt(req.body.sale_price||0));const starts=String(req.body.starts_at||'').trim(), ends=String(req.body.ends_at||'').trim();const course=db.prepare('SELECT id FROM courses WHERE id=?').get(cid);if(!course||!sp||!starts||!ends)return res.redirect('/admin/flash-sales?error='+encodeURIComponent('اطلاعات فروش فوری ناقص است'));const startMs=Date.parse(starts),endMs=Date.parse(ends);if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<=startMs)return res.redirect('/admin/flash-sales?error='+encodeURIComponent('بازه زمانی فروش فوری نامعتبر است'));db.prepare('INSERT INTO flash_sales(course_id,sale_price,starts_at,ends_at,is_active) VALUES(?,?,?,?,1)').run(cid,sp,starts,ends);res.redirect('/admin/flash-sales');});
router.post('/flash-sales/:id/toggle',(req,res)=>{db.prepare('UPDATE flash_sales SET is_active=CASE WHEN is_active=1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);res.redirect('/admin/flash-sales');});
router.post('/flash-sales/:id/delete',(req,res)=>{db.prepare('DELETE FROM flash_sales WHERE id=?').run(req.params.id);res.redirect('/admin/flash-sales');});
// ---------- P1: Referral analytics ----------
router.get('/referrals',(req,res)=>{const rows=db.prepare(`SELECT rc.code,u.full_name,u.phone,COUNT(r.id) referred,COALESCE(SUM(CASE WHEN r.status='rewarded' THEN 1 ELSE 0 END),0) rewarded,COALESCE((SELECT SUM(rr.amount) FROM referral_rewards rr WHERE rr.referrer_id=u.id),0) reward_total FROM referral_codes rc JOIN users u ON u.id=rc.user_id LEFT JOIN referrals r ON r.referrer_id=u.id GROUP BY rc.user_id ORDER BY rewarded DESC,referred DESC LIMIT 100`).all();res.render('admin/referrals',{title:'معرفی دوستان',rows});});
// ---------- P1: Advanced analytics ----------
router.get('/analytics',requireRole('admin'),(req,res)=>{
  const range = [7,30,90].includes(Number(req.query.range)) ? Number(req.query.range) : 30;
  const days = range;
  const prevStart = `-${range * 2 - 1} days`;
  const currentStart = `-${range - 1} days`;
  const q = (sql, ...params) => db.prepare(sql).get(...params);
  const qa = (sql, ...params) => db.prepare(sql).all(...params);
  const money = v => Number(v || 0);
  const pct = (current, previous) => previous ? Math.round(((current - previous) / previous) * 1000) / 10 : (current > 0 ? 100 : 0);

  const total = money(q("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid'").v);
  const periodRevenue = money(q("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid' AND created_at>=date('now',?)", currentStart).v);
  const prevRevenue = money(q("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid' AND created_at>=date('now',?) AND created_at<date('now',?)", prevStart, currentStart).v);
  const periodOrders = Number(q("SELECT COUNT(*) c FROM orders WHERE status='paid' AND created_at>=date('now',?)", currentStart).c || 0);
  const prevOrders = Number(q("SELECT COUNT(*) c FROM orders WHERE status='paid' AND created_at>=date('now',?) AND created_at<date('now',?)", prevStart, currentStart).c || 0);
  const buyers = Number(q("SELECT COUNT(DISTINCT user_id) c FROM orders WHERE status='paid'").c || 0);
  const periodBuyers = Number(q("SELECT COUNT(DISTINCT user_id) c FROM orders WHERE status='paid' AND created_at>=date('now',?)", currentStart).c || 0);
  const prevBuyers = Number(q("SELECT COUNT(DISTINCT user_id) c FROM orders WHERE status='paid' AND created_at>=date('now',?) AND created_at<date('now',?)", prevStart, currentStart).c || 0);
  const users = Number(q("SELECT COUNT(*) c FROM users WHERE role='user'").c || 0);
  const periodUsers = Number(q("SELECT COUNT(*) c FROM users WHERE role='user' AND created_at>=date('now',?)", currentStart).c || 0);
  const prevUsers = Number(q("SELECT COUNT(*) c FROM users WHERE role='user' AND created_at>=date('now',?) AND created_at<date('now',?)", prevStart, currentStart).c || 0);
  const avg = periodOrders ? periodRevenue / periodOrders : 0;
  const prevAvg = prevOrders ? prevRevenue / prevOrders : 0;
  const conversion = users ? Math.round(buyers/users*1000)/10 : 0;
  const periodConversion = periodUsers ? Math.round(periodBuyers/periodUsers*1000)/10 : 0;
  const coupon = money(q("SELECT COALESCE(SUM(discount_amount),0) v FROM orders WHERE status='paid'").v);
  const returningBuyers = Number(q(`SELECT COUNT(*) c FROM (SELECT user_id FROM orders WHERE status='paid' GROUP BY user_id HAVING COUNT(*)>=2)`).c || 0);
  const retention = buyers ? Math.round(returningBuyers/buyers*1000)/10 : 0;

  const daily = qa(`SELECT date(created_at) d,COUNT(*) orders,COALESCE(SUM(amount),0) revenue FROM orders WHERE status='paid' AND created_at>=date('now',?) GROUP BY d ORDER BY d`, currentStart);
  const prevDaily = qa(`SELECT date(created_at) d,COUNT(*) orders,COALESCE(SUM(amount),0) revenue FROM orders WHERE status='paid' AND created_at>=date('now',?) AND created_at<date('now',?) GROUP BY d ORDER BY d`, prevStart, currentStart);
  const dailyMap = new Map(daily.map(x=>[x.d,x]));
  const chart = Array.from({length: days}, (_,i)=>{
    const dt = new Date(); dt.setHours(0,0,0,0); dt.setDate(dt.getDate()-(days-1-i));
    const iso = dt.toISOString().slice(0,10); const x=dailyMap.get(iso);
    return {d:iso, revenue:money(x?.revenue), orders:Number(x?.orders||0)};
  });

  const coursePerformance = qa(`
    SELECT c.id,c.title,COALESCE(cat.title,'بدون دسته') category,
      COALESCE((SELECT COUNT(*) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.course_id=c.id AND o.status='paid' AND o.created_at>=date('now',?)),0) sales,
      COALESCE((SELECT SUM(oi.price) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.course_id=c.id AND o.status='paid' AND o.created_at>=date('now',?)),0) revenue,
      COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.course_id=c.id AND r.is_approved=1),0) rating,
      COALESCE((SELECT COUNT(*) FROM reviews r WHERE r.course_id=c.id AND r.is_approved=1),0) reviews
    FROM courses c LEFT JOIN categories cat ON cat.id=c.category_id
    ORDER BY revenue DESC,sales DESC LIMIT 12`, currentStart, currentStart);

  const categoryPerformance = qa(`
    SELECT COALESCE(cat.title,'بدون دسته') category,
      COUNT(DISTINCT c.id) courses,
      COUNT(CASE WHEN o.id IS NOT NULL THEN oi.id END) sales,
      COALESCE(SUM(CASE WHEN o.id IS NOT NULL THEN oi.price ELSE 0 END),0) revenue
    FROM courses c
    LEFT JOIN categories cat ON cat.id=c.category_id
    LEFT JOIN order_items oi ON oi.course_id=c.id
    LEFT JOIN orders o ON o.id=oi.order_id AND o.status='paid' AND o.created_at>=date('now',?)
    GROUP BY c.category_id
    ORDER BY revenue DESC,sales DESC`, currentStart);

  const cohorts = qa(`
    SELECT strftime('%Y-%m', u.created_at) cohort,COUNT(DISTINCT u.id) users,
      COUNT(DISTINCT CASE WHEN o.status='paid' THEN u.id END) buyers,
      COALESCE(SUM(CASE WHEN o.status='paid' THEN o.amount ELSE 0 END),0) revenue
    FROM users u LEFT JOIN orders o ON o.user_id=u.id
    WHERE u.role='user' GROUP BY cohort ORDER BY cohort DESC LIMIT 12`).map(c=>({...c,rate:c.users?Math.round(c.buyers/c.users*1000)/10:0}));

  const latestOrders = qa(`SELECT o.id,o.amount,o.created_at,u.full_name FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='paid' ORDER BY o.created_at DESC LIMIT 6`);
  const metrics={total,avg,buyers,users,conversion,coupon,returningBuyers,retention,periodRevenue,periodOrders,periodBuyers,periodUsers,periodConversion,periodUsers,prevRevenue,prevOrders,prevBuyers,prevUsers,prevAvg,
    growthRevenue:pct(periodRevenue,prevRevenue),growthOrders:pct(periodOrders,prevOrders),growthBuyers:pct(periodBuyers,prevBuyers),growthUsers:pct(periodUsers,prevUsers),growthAvg:pct(avg,prevAvg)};
  res.render('admin/analytics',{title:'آنالیز هوشمند Pro',metrics,daily:chart,prevDaily,coursePerformance,categoryPerformance,cohorts,latestOrders,range});
});

router.get('/analytics/export.csv',requireRole('admin'),(req,res)=>{
  const rows=db.prepare(`SELECT date(o.created_at) date, COUNT(*) orders, COALESCE(SUM(o.amount),0) revenue FROM orders o WHERE o.status='paid' GROUP BY date(o.created_at) ORDER BY date(o.created_at) DESC LIMIT 365`).all();
  const esc=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
  const csv=['date,orders,revenue',...rows.map(r=>[r.date,r.orders,r.revenue].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename=glowup-analytics.csv'); res.send('\uFEFF'+csv);
});

// ---------- Categories ----------
router.get('/categories', (req, res) => {
  const categories = db.prepare(`
    SELECT categories.*, COUNT(courses.id) AS course_count
    FROM categories
    LEFT JOIN courses ON courses.category_id = categories.id
    GROUP BY categories.id
    ORDER BY categories.title COLLATE NOCASE
  `).all();
  res.render('admin/categories', { title: 'مدیریت دسته‌بندی‌ها', categories, notice: req.query.notice || '', error: req.query.error || '' });
});

router.post('/categories/new', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 100);
  if (!title) return res.redirect('/admin/categories?error=' + encodeURIComponent('عنوان دسته‌بندی را وارد کن.'));
  try {
    db.prepare('INSERT INTO categories (title, slug) VALUES (?, ?)').run(title, slugify(title));
    res.redirect('/admin/categories?notice=' + encodeURIComponent('دسته‌بندی با موفقیت اضافه شد.'));
  } catch (e) {
    console.error('Category create error:', e);
    res.redirect('/admin/categories?error=' + encodeURIComponent('این دسته‌بندی قبلاً وجود دارد یا اطلاعات آن نامعتبر است.'));
  }
});

router.post('/categories/:id/edit', (req, res) => {
  const id = Number(req.params.id);
  const title = String(req.body.title || '').trim().slice(0, 100);
  if (!id || !title) return res.redirect('/admin/categories?error=' + encodeURIComponent('عنوان دسته‌بندی نامعتبر است.'));
  try {
    db.prepare('UPDATE categories SET title=?, slug=? WHERE id=?').run(title, slugify(title), id);
    res.redirect('/admin/categories?notice=' + encodeURIComponent('دسته‌بندی به‌روزرسانی شد.'));
  } catch (e) {
    console.error('Category update error:', e);
    res.redirect('/admin/categories?error=' + encodeURIComponent('ویرایش دسته‌بندی انجام نشد.'));
  }
});

// ---------- Users ----------
router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const role = ['user','admin','editor','support'].includes(req.query.role) ? req.query.role : '';
  const where=[]; const params=[];
  if(q){ where.push('(full_name LIKE ? OR phone LIKE ? OR email LIKE ?)'); const like=`%${q}%`; params.push(like,like,like); }
  if(role){ where.push('role=?'); params.push(role); }
  const sql=`SELECT id, full_name, phone, email, role, created_at FROM users ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC LIMIT 300`;
  const users = db.prepare(sql).all(...params);
  const roleCounts = db.prepare("SELECT role, COUNT(*) c FROM users GROUP BY role").all().reduce((a,r)=>(a[r.role]=r.c,a),{});
  res.render('admin/users', { title: 'مدیریت کاربران', users, q, role, roleCounts });
});

router.get('/users/:id', (req,res)=>{
  const user=db.prepare('SELECT id,full_name,phone,email,role,created_at FROM users WHERE id=?').get(req.params.id);
  if(!user) return res.status(404).render('404',{title:'کاربر پیدا نشد'});
  const orders=db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(user.id);
  const courses=db.prepare(`SELECT c.*,e.created_at enrolled_at, COUNT(DISTINCT cs.id) total_sessions, COUNT(DISTINCT sp.session_id) completed_sessions FROM enrollments e JOIN courses c ON c.id=e.course_id LEFT JOIN course_sessions cs ON cs.course_id=c.id LEFT JOIN session_progress sp ON sp.user_id=e.user_id AND sp.course_id=c.id AND sp.session_id=cs.id WHERE e.user_id=? GROUP BY c.id ORDER BY e.created_at DESC`).all(user.id);
  const notifs=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(user.id);
  res.render('admin/user-detail',{title:'جزئیات کاربر',user,orders,courses,notifs});
});

router.post('/users/:id/role', (req, res) => {
  if(req.session.user?.role !== 'admin') return res.status(403).render('403',{title:'فقط Super Admin مجاز است'});
  const role = ['user','admin','editor','support'].includes(req.body.role) ? req.body.role : null;
  if (!role) return res.redirect('/admin/users?error='+encodeURIComponent('نقش انتخاب‌شده معتبر نیست.'));
  const target = db.prepare('SELECT id,role FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.redirect('/admin/users?error='+encodeURIComponent('کاربر موردنظر پیدا نشد.'));
  if (target.role === 'admin' && role !== 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c;
    if (adminCount <= 1) return res.redirect('/admin/users?error='+encodeURIComponent('آخرین Super Admin را نمی‌توان از نقش مدیریت خارج کرد.'));
  }
  if (Number(req.params.id) === Number(req.session.user.id) && role !== 'admin') return res.redirect('/admin/users?error='+encodeURIComponent('نمی‌توانی نقش حساب خودت را کاهش بدهی.'));
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  const id=Number(req.params.id);
  if(!Number.isInteger(id) || id < 1) return res.redirect('/admin/users?error=' + encodeURIComponent('شناسه کاربر نامعتبر است.'));
  if(id===Number(req.session.user.id)) return res.redirect('/admin/users?error=' + encodeURIComponent('نمی‌توانی حساب خودت را حذف کنی.'));
  const user=db.prepare('SELECT id,role FROM users WHERE id=?').get(id);
  if(!user) return res.redirect('/admin/users?error=' + encodeURIComponent('کاربر موردنظر پیدا نشد.'));
  if(user.role==='admin') return res.redirect('/admin/users?error=' + encodeURIComponent('حساب Super Admin را نمی‌توان حذف کرد؛ ابتدا نقش آن را تغییر بده.'));
  const deps=db.prepare('SELECT (SELECT COUNT(*) FROM orders WHERE user_id=?) + (SELECT COUNT(*) FROM enrollments WHERE user_id=?) AS c').get(id,id).c;
  if(deps>0) return res.redirect('/admin/users?error=' + encodeURIComponent('این کاربر سابقه سفارش یا دسترسی آموزشی دارد و برای حفظ سوابق قابل حذف نیست.'));
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.redirect('/admin/users?notice=' + encodeURIComponent('کاربر حذف شد.'));
});

// ---------- Orders ----------
router.get('/orders', (req, res) => {
  const q=String(req.query.q||'').trim().slice(0,80);
  const status=['pending','paid','failed','canceled'].includes(req.query.status)?req.query.status:'';
  const where=[]; const params=[];
  if(q){ where.push('(users.full_name LIKE ? OR users.phone LIKE ? OR orders.ref_id LIKE ? OR CAST(orders.id AS TEXT) LIKE ?)'); const like=`%${q}%`; params.push(like,like,like,like); }
  if(status){ where.push('orders.status=?'); params.push(status); }
  const orders=db.prepare(`SELECT orders.*, users.full_name, users.phone FROM orders JOIN users ON users.id=orders.user_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY orders.created_at DESC LIMIT 300`).all(...params);
  const statusCounts=db.prepare("SELECT status,COUNT(*) c FROM orders GROUP BY status").all().reduce((a,r)=>(a[r.status]=r.c,a),{});
  res.render('admin/orders',{title:'مدیریت سفارش‌ها',orders,q,status,statusCounts});
});

router.post('/orders/:id/status',(req,res)=>{
  if(req.session.user?.role!=='admin') return res.status(403).render('403',{title:'فقط Super Admin مجاز است'});
  const id=Number(req.params.id);
  const next=['pending','paid','failed','canceled'].includes(req.body.status)?req.body.status:null;
  if(!Number.isInteger(id)||id<1||!next) return res.redirect('/admin/orders?error='+encodeURIComponent('وضعیت سفارش نامعتبر است.'));
  const order=db.prepare('SELECT id,status FROM orders WHERE id=?').get(id);
  if(!order) return res.redirect('/admin/orders?error='+encodeURIComponent('سفارش پیدا نشد.'));
  if(order.status==='paid' && next!=='paid') return res.redirect('/admin/orders/'+id+'?error='+encodeURIComponent('سفارش پرداخت‌شده قابل برگشت به وضعیت غیرپرداختی نیست؛ برای حفظ دسترسی و سوابق مالی این وضعیت قفل است.'));
  const paidAt=next==='paid'?'CURRENT_TIMESTAMP': 'NULL';
  const tx=db.transaction(()=>{
    const changed=db.prepare(`UPDATE orders SET status=?, paid_at=${paidAt} WHERE id=? AND status<>?`).run(next,id,next);
    if(next==='paid' && changed.changes===1){
      const order=db.prepare('SELECT id,user_id FROM orders WHERE id=?').get(id);
      const items=db.prepare('SELECT course_id FROM order_items WHERE order_id=?').all(id);
      const enroll=db.prepare('INSERT OR IGNORE INTO enrollments(user_id,course_id,order_id) VALUES(?,?,?)');
      for(const item of items) enroll.run(order.user_id,item.course_id,id);
      const fullOrder=db.prepare('SELECT referral_id,amount FROM orders WHERE id=?').get(id);
      const referral=fullOrder?.referral_id ? db.prepare("SELECT id,referrer_id FROM referrals WHERE id=? AND referred_id=? AND status='pending' LIMIT 1").get(fullOrder.referral_id,order.user_id) : null;
      if(referral){
        const pctRow=db.prepare("SELECT value FROM settings WHERE key='referral_reward_percent'").get();
        const capRow=db.prepare("SELECT value FROM settings WHERE key='referral_reward_cap'").get();
        const pct=Math.max(0,Math.min(100,Number(pctRow?.value ?? 5)||0));
        const cap=Math.max(0,Number(capRow?.value ?? 100000)||0);
        const reward=Math.min(cap,Math.floor(Number(fullOrder.amount||0)*pct/100));
        const marked=db.prepare("UPDATE referrals SET status='rewarded',reward_amount=? WHERE id=? AND status='pending'").run(reward,referral.id);
        if(marked.changes===1){
          db.prepare("INSERT OR IGNORE INTO referral_rewards(referral_id,referrer_id,order_id,amount) VALUES(?,?,?,?)").run(referral.id,referral.referrer_id,id,reward);
          db.prepare("INSERT INTO notifications(user_id,title,body,type,link) VALUES(?,?,?,?,?)").run(referral.referrer_id,'معرفی موفق 🎉',`خرید دوستت تکمیل شد و ${reward.toLocaleString('fa-IR')} تومان پاداش معرفی برایت ثبت شد.`,'referral','/referral');
        }
      }
    }
    return changed.changes;
  });
  tx();
  res.redirect('/admin/orders/'+id+'?notice='+encodeURIComponent('وضعیت سفارش به‌روزرسانی شد.'));
});

router.get('/orders/:id', (req, res) => {
  const order = db.prepare(`
    SELECT orders.*, users.full_name, users.phone FROM orders
    JOIN users ON users.id = orders.user_id WHERE orders.id = ?
  `).get(req.params.id);
  if (!order) return res.redirect('/admin/orders?error=' + encodeURIComponent('سفارش موردنظر پیدا نشد.'));
  const items = db.prepare(`
    SELECT order_items.*, courses.title AS course_title FROM order_items
    JOIN courses ON courses.id = order_items.course_id WHERE order_id = ?
  `).all(req.params.id);
  res.render('admin/order-detail', { title: 'جزئیات سفارش', order, items });
});

// ---------- Blog ----------
router.get('/blog', (req, res) => {
  const posts = db.prepare('SELECT * FROM blog_posts ORDER BY created_at DESC').all();
  res.render('admin/blog', { title: 'مدیریت وبلاگ', posts });
});

router.get('/blog/new', (req, res) => {
  res.render('admin/blog-form', { title: 'مطلب جدید', post: null });
});

router.post('/blog/new', safeUpload, (req, res) => {
  const b = req.body;
  const title = String(b.title || '').trim().slice(0,180);
  if (!title) { removeUploadedFile(req.file); return res.redirect('/admin/blog/new?error=' + encodeURIComponent('عنوان مطلب الزامی است.')); }
  const cover = req.file ? '/uploads/' + req.file.filename : null;
  db.prepare(`
    INSERT INTO blog_posts (title, slug, cover_image, excerpt, content, is_published)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(title, slugify(title) + '-' + Date.now().toString().slice(-4), cover, b.excerpt, b.content, b.is_published ? 1 : 0);
  res.redirect('/admin/blog');
});

router.get('/blog/:id/edit', (req, res) => {
  const post = db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(req.params.id);
  if (!post) return res.redirect('/admin/blog?error=' + encodeURIComponent('مطلب موردنظر پیدا نشد.'));
  res.render('admin/blog-form', { title: 'ویرایش مطلب', post });
});

router.post('/blog/:id/edit', safeUpload, (req, res) => {
  const b = req.body;
  const title = String(b.title || '').trim().slice(0,180);
  const existing = db.prepare('SELECT cover_image FROM blog_posts WHERE id = ?').get(req.params.id);
  if (!existing) { removeUploadedFile(req.file); return res.redirect('/admin/blog?error=' + encodeURIComponent('مطلب موردنظر پیدا نشد.')); }
  if (!title) { removeUploadedFile(req.file); return res.redirect(`/admin/blog/${req.params.id}/edit?error=` + encodeURIComponent('عنوان مطلب الزامی است.')); }
  const cover = req.file ? '/uploads/' + req.file.filename : existing.cover_image;
  db.prepare('UPDATE blog_posts SET title=?, cover_image=?, excerpt=?, content=?, is_published=? WHERE id=?')
    .run(title, cover, String(b.excerpt||'').slice(0,500), String(b.content||'').slice(0,20000), b.is_published ? 1 : 0, req.params.id);
  if (req.file && existing.cover_image && existing.cover_image !== cover) removeUploadUrl(existing.cover_image);
  res.redirect('/admin/blog');
});

router.post('/blog/:id/delete', (req, res) => {
  const id=positiveId(req.params.id);
  const post=id ? db.prepare('SELECT cover_image FROM blog_posts WHERE id=?').get(id) : null;
  if (!post) return res.redirect('/admin/blog?error='+encodeURIComponent('مطلب موردنظر پیدا نشد.'));
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id);
  removeUploadUrl(post.cover_image);
  res.redirect('/admin/blog?notice='+encodeURIComponent('مطلب و کاور آن حذف شد.'));
});


// ---------- Reviews ----------
router.get('/reviews', (req,res)=>{
  const status=req.query.status||'all';
  const where=status==='pending'?'WHERE r.is_approved=0':status==='approved'?'WHERE r.is_approved=1':'';
  const reviews=db.prepare(`SELECT r.*,u.full_name,u.phone,c.title AS course_title FROM reviews r JOIN users u ON u.id=r.user_id JOIN courses c ON c.id=r.course_id ${where} ORDER BY r.created_at DESC LIMIT 200`).all();
  const counts={all:db.prepare('SELECT COUNT(*) c FROM reviews').get().c,pending:db.prepare('SELECT COUNT(*) c FROM reviews WHERE is_approved=0').get().c,approved:db.prepare('SELECT COUNT(*) c FROM reviews WHERE is_approved=1').get().c};
  res.render('admin/reviews',{title:'مدیریت نظرات',reviews,counts,status});
});
router.post('/reviews/:id/approve',(req,res)=>{ db.prepare('UPDATE reviews SET is_approved=1 WHERE id=?').run(req.params.id); res.redirect('/admin/reviews'); });
router.post('/reviews/:id/reject',(req,res)=>{ db.prepare('UPDATE reviews SET is_approved=0 WHERE id=?').run(req.params.id); res.redirect('/admin/reviews'); });
router.post('/reviews/:id/delete',(req,res)=>{ db.prepare('DELETE FROM reviews WHERE id=?').run(req.params.id); res.redirect('/admin/reviews'); });

// ---------- P2-7: Marketing Intelligence ----------
router.get('/marketing', requireRole('admin'), (req,res)=>{
  const q=(sql,...args)=>db.prepare(sql).get(...args);
  const qa=(sql,...args)=>db.prepare(sql).all(...args);
  const paidOrders=Number(q("SELECT COUNT(*) c FROM orders WHERE status='paid'").c||0);
  const revenue=Number(q("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid'").v||0);
  const buyers=Number(q("SELECT COUNT(DISTINCT user_id) c FROM orders WHERE status='paid'").c||0);
  const users=Number(q("SELECT COUNT(*) c FROM users WHERE role='user'").c||0);
  const coupons=qa(`SELECT cp.code,cp.type,cp.value,cp.max_uses,COUNT(o.id) used_count
    FROM coupons cp LEFT JOIN orders o ON o.coupon_id=cp.id AND o.status='paid'
    GROUP BY cp.id ORDER BY used_count DESC,cp.created_at DESC LIMIT 8`);
  const activeSales=qa(`SELECT fs.id,fs.sale_price,fs.starts_at,fs.ends_at,c.title,c.price
    FROM flash_sales fs JOIN courses c ON c.id=fs.course_id
    WHERE fs.is_active=1 ORDER BY fs.ends_at ASC LIMIT 8`);
  const referrals=q(`SELECT COUNT(*) referred,COALESCE(SUM(CASE WHEN status='rewarded' THEN 1 ELSE 0 END),0) rewarded FROM referrals`);
  const topCourses=qa(`SELECT c.id,c.title,COUNT(oi.id) sales,COALESCE(SUM(oi.price),0) revenue
    FROM order_items oi JOIN courses c ON c.id=oi.course_id JOIN orders o ON o.id=oi.order_id AND o.status='paid'
    WHERE o.created_at>=date('now','-30 days') GROUP BY c.id ORDER BY sales DESC,revenue DESC LIMIT 6`);
  const recentCampaigns=qa(`SELECT action,meta,created_at FROM activity_logs WHERE action LIKE '/marketing%' ORDER BY id DESC LIMIT 8`);
  const conversion=users?Math.round(buyers/users*1000)/10:0;
  res.render('admin/marketing',{title:'مرکز بازاریابی هوشمند',stats:{paidOrders,revenue,buyers,users,conversion},coupons,activeSales,referrals,topCourses,recentCampaigns,notice:req.query.notice||'',error:req.query.error||''});
});

router.post('/marketing/log', requireRole('admin'), (req,res)=>{
  const channel=String(req.body.channel||'').trim().slice(0,40);
  const campaign=String(req.body.campaign||'').trim().slice(0,100);
  if(!channel||!campaign) return res.redirect('/admin/marketing?error='+encodeURIComponent('نام کمپین و کانال الزامی است'));
  db.prepare('INSERT INTO activity_logs(user_id,action,entity,entity_id,meta) VALUES(?,?,?,?,?)')
    .run(req.session.user.id,'/marketing/campaign_logged','marketing',null,JSON.stringify({campaign,channel,source:String(req.body.source||'').slice(0,80),medium:String(req.body.medium||'').slice(0,80)}));
  res.redirect('/admin/marketing?notice='+encodeURIComponent('کمپین در مرکز بازاریابی ثبت شد.'));
});

// ---------- P2-8: Customer Intelligence & CRM Pro ----------
router.get('/crm', requireRole('admin'), (req,res)=>{
  const q=(sql,...args)=>db.prepare(sql).get(...args);
  const qa=(sql,...args)=>db.prepare(sql).all(...args);
  const totalUsers=Number(q("SELECT COUNT(*) c FROM users WHERE role='user'").c||0);
  const buyers=Number(q("SELECT COUNT(DISTINCT user_id) c FROM orders WHERE status='paid'").c||0);
  const repeatBuyers=Number(q("SELECT COUNT(*) c FROM (SELECT user_id FROM orders WHERE status='paid' GROUP BY user_id HAVING COUNT(*)>=2)").c||0);
  const dormant=Number(q("SELECT COUNT(*) c FROM users u WHERE u.role='user' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.status='paid' AND o.created_at>=date('now','-45 days'))").c||0);
  const neverBought=Number(q("SELECT COUNT(*) c FROM users u WHERE u.role='user' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id AND o.status='paid')").c||0);
  const vip=Number(q("SELECT COUNT(*) c FROM (SELECT user_id FROM orders WHERE status='paid' GROUP BY user_id HAVING COALESCE(SUM(amount),0)>=3000000)").c||0);
  const avgOrder=Number(q("SELECT COALESCE(AVG(amount),0) v FROM orders WHERE status='paid'").v||0);
  const segments=[
    {key:'vip',label:'VIP / ارزشمند',count:vip,desc:'مجموع خرید حداقل ۳ میلیون تومان',tone:'gold'},
    {key:'repeat',label:'مشتری تکراری',count:repeatBuyers,desc:'حداقل ۲ سفارش موفق',tone:'green'},
    {key:'dormant',label:'در معرض ریزش',count:dormant,desc:'بدون خرید موفق در ۴۵ روز اخیر',tone:'red'},
    {key:'lead',label:'ثبت‌نام کرده، بدون خرید',count:neverBought,desc:'کاربرانی که هنوز خریدی نداشته‌اند',tone:'blue'}
  ];
  const customers=qa(`
    SELECT u.id,u.full_name,u.phone,u.created_at,
      COUNT(CASE WHEN o.status='paid' THEN o.id END) orders,
      COALESCE(SUM(CASE WHEN o.status='paid' THEN o.amount ELSE 0 END),0) spend,
      MAX(CASE WHEN o.status='paid' THEN o.created_at END) last_order,
      CASE
        WHEN COALESCE(SUM(CASE WHEN o.status='paid' THEN o.amount ELSE 0 END),0)>=3000000 THEN 'vip'
        WHEN COUNT(CASE WHEN o.status='paid' THEN o.id END)>=2 THEN 'repeat'
        WHEN COUNT(CASE WHEN o.status='paid' THEN o.id END)=0 THEN 'lead'
        WHEN MAX(CASE WHEN o.status='paid' THEN o.created_at END) < date('now','-45 days') THEN 'dormant'
        ELSE 'active'
      END segment
    FROM users u LEFT JOIN orders o ON o.user_id=u.id
    WHERE u.role='user'
    GROUP BY u.id
    ORDER BY spend DESC,last_order DESC LIMIT 100`).all();
  const selected=['vip','repeat','dormant','lead'].includes(req.query.segment)?req.query.segment:'all';
  const filtered=selected==='all'?customers:customers.filter(c=>c.segment===selected);
  const recent=qa(`SELECT a.action,a.meta,a.created_at,u.full_name FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.action='/crm/outreach' ORDER BY a.id DESC LIMIT 8`);
  res.render('admin/crm',{title:'هوش مشتری و CRM Pro',totalUsers,buyers,repeatBuyers,dormant,neverBought,vip,avgOrder,segments,customers:filtered,recent,selected});
});

router.post('/crm/outreach', requireRole('admin'), (req,res)=>{
  const segment=String(req.body.segment||'').slice(0,30);
  const channel=String(req.body.channel||'').slice(0,30);
  if(!segment||!channel) return res.redirect('/admin/crm?error='+encodeURIComponent('سگمنت و کانال ارتباطی الزامی است'));
  db.prepare('INSERT INTO activity_logs(user_id,action,entity,entity_id,meta) VALUES(?,?,?,?,?)')
    .run(req.session.user.id,'/crm/outreach','crm',null,JSON.stringify({segment,channel}));
  res.redirect('/admin/crm?notice='+encodeURIComponent('اقدام ارتباطی در Activity Log ثبت شد.'));
});

// ---------- Analytics / Reports ----------
router.get('/reports', (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || 30), 7), 365);
  const revenue = db.prepare(`
    SELECT date(created_at) AS d, COALESCE(SUM(amount),0) AS total, COUNT(*) AS orders
    FROM orders WHERE status='paid' AND created_at >= date('now', ?)
    GROUP BY d ORDER BY d
  `).all(`-${days - 1} days`);
  const topCourses = db.prepare(`
    SELECT c.id, c.title, COUNT(oi.id) sales, COALESCE(SUM(oi.price),0) revenue
    FROM order_items oi JOIN courses c ON c.id=oi.course_id
    JOIN orders o ON o.id=oi.order_id AND o.status='paid'
    GROUP BY c.id ORDER BY sales DESC LIMIT 10
  `).all();
  const completion = db.prepare(`
    SELECT c.id, c.title, COUNT(DISTINCT e.user_id) learners,
      COUNT(DISTINCT CASE WHEN sp.cnt >= cs.total THEN e.user_id END) completed
    FROM courses c
    LEFT JOIN enrollments e ON e.course_id=c.id
    LEFT JOIN (SELECT course_id, COUNT(*) total FROM course_sessions GROUP BY course_id) cs ON cs.course_id=c.id
    LEFT JOIN (SELECT user_id, course_id, COUNT(*) cnt FROM session_progress GROUP BY user_id, course_id) sp
      ON sp.course_id=c.id AND sp.user_id=e.user_id
    GROUP BY c.id ORDER BY learners DESC LIMIT 10
  `).all();
  res.render('admin/reports', { title:'گزارش‌ها و آنالیز', revenue, topCourses, completion, days });
});

// ---------- Coupons ----------
router.get('/coupons', (req, res) => {
  const coupons = db.prepare(`
    SELECT cp.*, COUNT(o.id) used_count
    FROM coupons cp LEFT JOIN orders o ON o.coupon_id=cp.id
    GROUP BY cp.id ORDER BY cp.created_at DESC
  `).all();
  res.render('admin/coupons', { title:'کدهای تخفیف', coupons });
});
router.post('/coupons/new', (req, res) => {
  const b=req.body;
  const code=(b.code||'').trim().toUpperCase();
  const type=b.type==='percent'?'percent':'fixed';
  const rawValue=parseInt(b.value||0);
  const value=type==='percent'?Math.min(100,Math.max(1,rawValue)):Math.max(1,rawValue);
  if(!code || !Number.isFinite(value) || value<1) return res.redirect('/admin/coupons?error='+encodeURIComponent('کد و مقدار تخفیف الزامی است'));
  try {
    db.prepare(`INSERT INTO coupons (code,type,value,max_uses,expires_at,is_active) VALUES (?,?,?,?,?,1)`)
      .run(code,type,value,b.max_uses?Math.max(1,parseInt(b.max_uses)):null,b.expires_at||null);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) return res.redirect('/admin/coupons?error='+encodeURIComponent('این کد تخفیف قبلاً ثبت شده است'));
    throw e;
  }
  res.redirect('/admin/coupons?notice='+encodeURIComponent('کد تخفیف با موفقیت ساخته شد.'));
});
router.post('/coupons/:id/toggle', (req,res)=>{
  db.prepare('UPDATE coupons SET is_active=CASE WHEN is_active=1 THEN 0 ELSE 1 END WHERE id=?').run(req.params.id);
  res.redirect('/admin/coupons');
});
router.post('/coupons/:id/delete', (req,res)=>{
  db.prepare('DELETE FROM coupons WHERE id=?').run(req.params.id); res.redirect('/admin/coupons');
});

// ---------- P1: Bundles ----------

router.post('/categories/:id/delete', (req,res)=>{
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS c FROM courses WHERE category_id=?').get(id).c;
  if (used > 0) {
    db.transaction(() => {
      db.prepare('UPDATE courses SET category_id=NULL WHERE category_id=?').run(id);
      db.prepare('DELETE FROM categories WHERE id=?').run(id);
    })();
  } else {
    db.prepare('DELETE FROM categories WHERE id=?').run(id);
  }
  res.redirect('/admin/categories?notice=' + encodeURIComponent('دسته‌بندی حذف شد.'));
});

// ---------- Automation & Smart Alerts ----------
router.get('/automation', requireRole('admin'), (req,res)=>{
  const getSetting=(key, fallback)=>{ const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? row.value : fallback; };
  const pendingThreshold=Math.max(1, Number(getSetting('automation_pending_threshold','5'))||5);
  const reviewThreshold=Math.max(1, Number(getSetting('automation_review_threshold','3'))||3);
  const rules={
    pending: getSetting('automation_pending_enabled','1') === '1',
    reviews: getSetting('automation_reviews_enabled','1') === '1',
    noSales: getSetting('automation_no_sales_enabled','1') === '1'
  };
  const metrics={
    pendingOrders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('pending','pending_payment')").get().c,
    unapprovedReviews: db.prepare('SELECT COUNT(*) c FROM reviews WHERE is_approved=0').get().c,
    todayOrders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid' AND date(created_at)=date('now','localtime')").get().c,
    todayRevenue: db.prepare("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid' AND date(created_at)=date('now','localtime')").get().v
  };
  const recent=db.prepare("SELECT action,entity,meta,created_at FROM activity_logs WHERE action LIKE 'automation_%' ORDER BY id DESC LIMIT 20").all();
  res.render('admin/automation',{title:'مرکز اتوماسیون هوشمند',rules,metrics,pendingThreshold,reviewThreshold,recent});
});

router.post('/automation/settings', requireRole('admin'), (req,res)=>{
  const up=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const bool=v=>v==='1'?'1':'0';
  const pending=Math.min(999,Math.max(1,Number.parseInt(req.body.pending_threshold,10)||5));
  const reviews=Math.min(999,Math.max(1,Number.parseInt(req.body.review_threshold,10)||3));
  const tx=db.transaction(()=>{
    up.run('automation_pending_enabled',bool(req.body.pending_enabled));
    up.run('automation_reviews_enabled',bool(req.body.reviews_enabled));
    up.run('automation_no_sales_enabled',bool(req.body.no_sales_enabled));
    up.run('automation_pending_threshold',String(pending));
    up.run('automation_review_threshold',String(reviews));
  });
  tx();
  res.redirect('/admin/automation?notice='+encodeURIComponent('تنظیمات اتوماسیون ذخیره شد.'));
});

router.post('/automation/run', requireRole('admin'), (req,res)=>{
  const getSetting=(key, fallback)=>{ const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? row.value : fallback; };
  const threshold=Math.max(1,Number(getSetting('automation_pending_threshold','5'))||5);
  const reviewThreshold=Math.max(1,Number(getSetting('automation_review_threshold','3'))||3);
  const alerts=[];
  const admins=db.prepare("SELECT id FROM users WHERE role='admin'").all();
  const notify=db.prepare('INSERT INTO notifications(user_id,title,body,type,link) VALUES(?,?,?,?,?)');
  const log=db.prepare("INSERT INTO activity_logs(user_id,action,entity,entity_id,meta) VALUES(?,?,?,?,?)");
  const pending=db.prepare("SELECT COUNT(*) c FROM orders WHERE status IN ('pending','pending_payment')").get().c;
  const reviews=db.prepare('SELECT COUNT(*) c FROM reviews WHERE is_approved=0').get().c;
  const todayOrders=db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid' AND date(created_at)=date('now','localtime')").get().c;
  if(getSetting('automation_pending_enabled','1')==='1' && pending>=threshold) alerts.push({key:'pending',title:'هشدار سفارش‌های معلق',body:`${pending.toLocaleString('fa-IR')} سفارش در انتظار بررسی یا پرداخت است.`,link:'/admin/orders'});
  if(getSetting('automation_reviews_enabled','1')==='1' && reviews>=reviewThreshold) alerts.push({key:'reviews',title:'نظرات منتظر تأیید',body:`${reviews.toLocaleString('fa-IR')} نظر برای بررسی مدیر باقی مانده است.`,link:'/admin/reviews'});
  if(getSetting('automation_no_sales_enabled','1')==='1' && todayOrders===0) alerts.push({key:'no_sales',title:'هشدار فروش امروز',body:'تا این لحظه سفارش موفقی امروز ثبت نشده است؛ وضعیت کمپین‌ها و ورودی سایت را بررسی کن.',link:'/admin/analytics'});
  const tx=db.transaction(()=>{
    alerts.forEach(a=>admins.forEach(admin=>notify.run(admin.id,a.title,a.body,'automation',a.link)));
    alerts.forEach(a=>log.run(req.session.user.id,'automation_alert','automation',null,JSON.stringify({key:a.key})));
    log.run(req.session.user.id,'automation_run','automation',null,JSON.stringify({alerts:alerts.length,pending,reviews,todayOrders}));
  });
  tx();
  const msg=alerts.length ? `${alerts.length} هشدار ایجاد شد.` : 'در حال حاضر هشدار فعالی پیدا نشد.';
  res.redirect('/admin/automation?notice='+encodeURIComponent(msg));
});

// ---------- Activity Log ----------
router.get('/activity', (req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,120);
  const action=String(req.query.action||'').trim().slice(0,80);
  const entity=String(req.query.entity||'').trim().slice(0,80);
  const page=Math.max(1,intValue(req.query.page,1));
  const perPage=40;
  const where=[]; const params={};
  if(q){where.push(`(a.action LIKE @q OR a.entity LIKE @q OR a.meta LIKE @q OR u.full_name LIKE @q)`);params.q=`%${q}%`;}
  if(action){where.push('a.action=@action');params.action=action;}
  if(entity){where.push('a.entity=@entity');params.entity=entity;}
  const whereSql=where.length?'WHERE '+where.join(' AND '):'';
  const total=db.prepare(`SELECT COUNT(*) c FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id ${whereSql}`).get(params).c;
  const pages=Math.max(1,Math.ceil(total/perPage)); const safePage=Math.min(page,pages);
  const logs=db.prepare(`SELECT a.*,u.full_name FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id ${whereSql} ORDER BY a.created_at DESC LIMIT @limit OFFSET @offset`).all({...params,limit:perPage,offset:(safePage-1)*perPage});
  const actions=db.prepare("SELECT DISTINCT action FROM activity_logs WHERE action IS NOT NULL AND action<>'' ORDER BY action LIMIT 80").all().map(x=>x.action);
  const entities=db.prepare("SELECT DISTINCT entity FROM activity_logs WHERE entity IS NOT NULL AND entity<>'' ORDER BY entity LIMIT 80").all().map(x=>x.entity);
  res.render('admin/activity',{title:'گزارش فعالیت‌ها',logs,actions,entities,filters:{q,action,entity,page:safePage,pages,total}});
});

router.get('/activity/export.csv',(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,120), action=String(req.query.action||'').trim().slice(0,80), entity=String(req.query.entity||'').trim().slice(0,80);
  const where=[]; const params={};
  if(q){where.push(`(a.action LIKE @q OR a.entity LIKE @q OR a.meta LIKE @q OR u.full_name LIKE @q)`);params.q=`%${q}%`;}
  if(action){where.push('a.action=@action');params.action=action;}
  if(entity){where.push('a.entity=@entity');params.entity=entity;}
  const whereSql=where.length?'WHERE '+where.join(' AND '):'';
  const rows=db.prepare(`SELECT a.created_at,u.full_name,a.action,a.entity,a.entity_id,a.meta FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id ${whereSql} ORDER BY a.created_at DESC LIMIT 5000`).all(params);
  const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const csv=['date,admin,action,entity,entity_id,meta',...rows.map(r=>[r.created_at,r.full_name||'سیستم',r.action,r.entity,r.entity_id,r.meta].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="activity-log.csv"');
  res.send('\ufeff'+csv);
});

// ---------- Notifications ----------
router.get('/notifications',(req,res)=>{
  const users=db.prepare('SELECT id,full_name,phone FROM users ORDER BY full_name').all();
  const recent=db.prepare(`SELECT n.*,u.full_name FROM notifications n LEFT JOIN users u ON u.id=n.user_id ORDER BY n.created_at DESC LIMIT 80`).all();
  res.render('admin/notifications',{title:'مرکز اعلان‌ها',users,recent});
});
router.post('/notifications/send',(req,res)=>{
  const title=String(req.body.title||'').trim().slice(0,120), body=String(req.body.body||'').trim().slice(0,500), link=safeNavUrl(req.body.link,'/dashboard');
  if(!title) return res.redirect('/admin/notifications?error='+encodeURIComponent('عنوان اعلان الزامی است'));
  const target=req.body.user_id==='all'?'all':Number(req.body.user_id);
  const stmt=db.prepare('INSERT INTO notifications(user_id,title,body,type,link) VALUES(?,?,?,?,?)');
  if(target==='all'){ const users=db.prepare("SELECT id FROM users WHERE role='user'").all(); const tx=db.transaction(()=>users.forEach(u=>stmt.run(u.id,title,body,'admin',link))); tx(); } else if(target){ stmt.run(target,title,body,'admin',link); }
  res.redirect('/admin/notifications');
});

// ---------- Settings ----------
router.get('/settings', requireRole('admin'), (req,res)=>{
  const rows=db.prepare('SELECT key,value FROM settings').all();
  const settings=Object.fromEntries(rows.map(r=>[r.key,r.value]));
  res.render('admin/settings',{title:'تنظیمات آکادمی',settings});
});
router.post('/settings', requireRole('admin'), (req,res)=>{
  const allowed=['academy_name','support_phone','support_email','instagram','telegram','home_headline','home_subheadline','announcement'];
  const up=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx=db.transaction(()=>allowed.forEach(k=>up.run(k,String(req.body[k]||'').trim().slice(0,2000))));
  tx();
  res.redirect('/admin/settings?notice='+encodeURIComponent('تنظیمات ذخیره شد.'));
});

// ---------- Security Center & Admin Password ----------
router.get('/security', requireRole('admin'), (req,res)=>{
  const admins=db.prepare("SELECT id,full_name,phone,created_at FROM users WHERE role='admin' ORDER BY created_at").all();
  const recent=db.prepare(`SELECT a.created_at,a.action,a.entity,a.entity_id,u.full_name FROM activity_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.action LIKE '/security%' OR a.action='/settings/password' ORDER BY a.created_at DESC LIMIT 30`).all();
  res.render('admin/security',{title:'مرکز امنیت',admins,recent});
});

router.post('/settings/password', requireRole('admin'), (req,res)=>{
  const current=String(req.body.current_password||'');
  const next=String(req.body.new_password||'');
  const confirm=String(req.body.confirm_password||'');
  if(next.length < 8 || next.length > 200) return res.redirect('/admin/settings?error='+encodeURIComponent('رمز جدید باید بین ۸ تا ۲۰۰ کاراکتر باشد.'));
  if(next !== confirm) return res.redirect('/admin/settings?error='+encodeURIComponent('تکرار رمز جدید با رمز مطابقت ندارد.'));
  const row=db.prepare("SELECT password_hash FROM users WHERE id=? AND role=\'admin\'").get(req.session.user.id);
  if(!row || !bcrypt.compareSync(current,row.password_hash)) return res.redirect('/admin/settings?error='+encodeURIComponent('رمز فعلی صحیح نیست.'));
  if(bcrypt.compareSync(next,row.password_hash)) return res.redirect('/admin/settings?error='+encodeURIComponent('رمز جدید باید با رمز قبلی متفاوت باشد.'));
  const hash=bcrypt.hashSync(next,12);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,req.session.user.id);
  try { db.prepare('INSERT INTO activity_logs(user_id,action,entity,entity_id,meta) VALUES(?,?,?,?,?)').run(req.session.user.id,'/security/password_changed','user',req.session.user.id,JSON.stringify({method:'admin-settings'})); } catch(e) {}
  // Rotate the session after a credential change while preserving the authenticated identity.
  const identity={...req.session.user};
  req.session.regenerate(err=>{
    if(err) return res.redirect('/admin/settings?error='+encodeURIComponent('رمز تغییر کرد اما بازسازی نشست انجام نشد؛ دوباره وارد شو.'));
    req.session.user=identity;
    req.session.save(saveErr=> saveErr ? res.redirect('/admin/settings?error='+encodeURIComponent('رمز تغییر کرد؛ نشست را دوباره باز کن.')) : res.redirect('/admin/settings?notice='+encodeURIComponent('رمز ادمین با موفقیت تغییر کرد.')));
  });
});

// ---------- Export ----------
router.get('/export/orders.csv',(req,res)=>{
  const rows=db.prepare(`
    SELECT o.id,o.created_at,u.full_name,u.phone,o.amount,o.status,o.ref_id
    FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created_at DESC
  `).all();
  const esc=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const csv=['id,date,customer,phone,amount,status,ref_id',...rows.map(r=>[r.id,r.created_at,r.full_name,r.phone,r.amount,r.status,r.ref_id].map(esc).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="orders.csv"');
  res.send('\ufeff'+csv);
});


// ========================= P3 ADMIN PRO =========================
// Course Builder: drag/drop reorder and bulk session ordering.
router.post('/courses/:id/sessions/reorder', (req,res) => {
  const courseId = positiveId(req.params.id);
  const ids = Array.isArray(req.body.session_ids) ? req.body.session_ids.map(Number).filter(Number.isInteger) : [];
  if (!courseId || !ids.length) return res.status(400).json({error:'ترتیب نامعتبر است'});

  const all = db.prepare('SELECT id,phase,sort_order FROM course_sessions WHERE course_id=? ORDER BY sort_order,id').all(courseId);
  const wanted = [...new Set(ids)];
  const valid = new Set(all.map(x=>x.id));
  if (wanted.length !== ids.length || wanted.some(id=>!valid.has(id))) return res.status(400).json({error:'جلسه‌ای متعلق به این دوره نیست یا ترتیب تکراری است'});

  // The builder renders one sortable list per phase. Reordering only that list must
  // still produce one unique global order, otherwise phases can get duplicate sort_order
  // values and the student playlist can appear in the wrong sequence.
  const phaseOf = new Map(all.map(x=>[x.id, x.phase || '']));
  const targetPhase = phaseOf.get(wanted[0]);
  if (wanted.some(id=>phaseOf.get(id)!==targetPhase)) return res.status(400).json({error:'جلسات چند فاز را همزمان جابه‌جا نکن'});

  const groups = new Map();
  for (const row of all) {
    const key = row.phase || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.id);
  }
  groups.set(targetPhase, wanted);
  const finalIds = [...groups.values()].flat();
  const update = db.prepare('UPDATE course_sessions SET sort_order=? WHERE id=? AND course_id=?');
  db.transaction(() => finalIds.forEach((id,i)=>update.run(i+1,id,courseId)))();
  res.json({ok:true});
});

router.get('/homepage', (req,res) => {
  const sections = db.prepare('SELECT * FROM homepage_sections ORDER BY sort_order,id').all();
  const testimonials = db.prepare('SELECT * FROM testimonials ORDER BY sort_order,id').all();
  const faqs = db.prepare('SELECT * FROM faqs ORDER BY sort_order,id').all();
  res.render('admin/homepage', {title:'مدیریت صفحه اصلی', sections, testimonials, faqs});
});
router.post('/homepage/section', (req,res) => {
  const b=req.body, key=String(b.section_key||'').trim().slice(0,60);
  if(!key) return res.redirect('/admin/homepage?error='+encodeURIComponent('کلید بخش الزامی است'));
  db.prepare(`INSERT INTO homepage_sections(section_key,title,subtitle,content,image,cta_text,cta_url,is_enabled,sort_order,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(section_key) DO UPDATE SET title=excluded.title,subtitle=excluded.subtitle,content=excluded.content,image=excluded.image,cta_text=excluded.cta_text,cta_url=excluded.cta_url,is_enabled=excluded.is_enabled,sort_order=excluded.sort_order,updated_at=CURRENT_TIMESTAMP`)
    .run(key,String(b.title||'').slice(0,160),String(b.subtitle||'').slice(0,300),String(b.content||'').slice(0,3000),String(b.image||'').slice(0,300),String(b.cta_text||'').slice(0,80),safeNavUrl(b.cta_url,'/courses'),b.is_enabled?1:0,Number(b.sort_order)||0);
  res.redirect('/admin/homepage');
});
router.post('/homepage/section/:id/delete',(req,res)=>{db.prepare('DELETE FROM homepage_sections WHERE id=?').run(req.params.id);res.redirect('/admin/homepage');});
router.post('/homepage/section/:id/toggle',(req,res)=>{db.prepare('UPDATE homepage_sections SET is_enabled=1-is_enabled,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);res.redirect('/admin/homepage');});

router.post('/testimonials/new',(req,res)=>{
  const b=req.body; if(!String(b.name||'').trim()||!String(b.quote||'').trim()) return res.redirect('/admin/homepage?error='+encodeURIComponent('نام و متن نظر الزامی است'));
  db.prepare('INSERT INTO testimonials(name,role,quote,rating,is_published,sort_order) VALUES(?,?,?,?,?,?)').run(String(b.name).trim().slice(0,80),String(b.role||'').slice(0,100),String(b.quote).trim().slice(0,800),Math.max(1,Math.min(5,Number(b.rating)||5)),b.is_published?1:0,Number(b.sort_order)||0);
  res.redirect('/admin/homepage');
});
router.post('/testimonials/:id/toggle',(req,res)=>{db.prepare('UPDATE testimonials SET is_published=1-is_published WHERE id=?').run(req.params.id);res.redirect('/admin/homepage');});
router.post('/testimonials/:id/delete',(req,res)=>{db.prepare('DELETE FROM testimonials WHERE id=?').run(req.params.id);res.redirect('/admin/homepage');});

router.post('/faqs/new',(req,res)=>{
  const b=req.body; if(!String(b.question||'').trim()||!String(b.answer||'').trim()) return res.redirect('/admin/homepage?error='+encodeURIComponent('سؤال و پاسخ الزامی است'));
  db.prepare('INSERT INTO faqs(question,answer,is_published,sort_order) VALUES(?,?,?,?)').run(String(b.question).trim().slice(0,300),String(b.answer).trim().slice(0,1200),b.is_published?1:0,Number(b.sort_order)||0);
  res.redirect('/admin/homepage');
});
router.post('/faqs/:id/toggle',(req,res)=>{db.prepare('UPDATE faqs SET is_published=1-is_published WHERE id=?').run(req.params.id);res.redirect('/admin/homepage');});
router.post('/faqs/:id/delete',(req,res)=>{db.prepare('DELETE FROM faqs WHERE id=?').run(req.params.id);res.redirect('/admin/homepage');});

// Media Library: disk-backed uploads (no in-memory buffering) with a 1 GiB ceiling.
// Images remain intentionally smaller for safety/performance; large assets are mainly video/audio/PDF.
const maxMediaMB = Math.max(1, Math.min(Number(process.env.MAX_MEDIA_MB) || 1024, 1024));
const MAX_MEDIA_BYTES = maxMediaMB * 1024 * 1024;
const mediaAllowedMimes = new Set(Object.keys(mimeExt));
const mediaUpload = multer({
  storage,
  limits:{fileSize:MAX_MEDIA_BYTES, files:1},
  fileFilter:(req,file,cb)=>{
    if(mediaAllowedMimes.has(file.mimetype)) return cb(null,true);
    return cb(new Error('MEDIA_TYPE_NOT_ALLOWED'));
  }
});

router.get('/media',(req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,120);
  const type=String(req.query.type||'').trim();
  const page=Math.max(1, Math.min(10000, Number.parseInt(req.query.page,10) || 1));
  const pageSize=36;
  const allowedTypes=new Set(['image','video','audio','pdf','other']);
  const where=[]; const args=[];
  if(q){ where.push('(filename LIKE ? OR alt_text LIKE ?)'); args.push('%'+q+'%','%'+q+'%'); }
  if(allowedTypes.has(type)){
    if(type==='image') where.push("mime_type LIKE 'image/%'");
    else if(type==='video') where.push("mime_type LIKE 'video/%'");
    else if(type==='audio') where.push("mime_type LIKE 'audio/%'");
    else if(type==='pdf') where.push("mime_type='application/pdf'");
    else where.push("mime_type NOT LIKE 'image/%' AND mime_type NOT LIKE 'video/%' AND mime_type NOT LIKE 'audio/%' AND mime_type!='application/pdf'");
  }
  const whereSql=where.length?'WHERE '+where.join(' AND '):'';
  const summary=db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes,
    SUM(CASE WHEN mime_type LIKE 'image/%' THEN 1 ELSE 0 END) AS images,
    SUM(CASE WHEN mime_type LIKE 'video/%' THEN 1 ELSE 0 END) AS videos,
    SUM(CASE WHEN mime_type LIKE 'audio/%' THEN 1 ELSE 0 END) AS audio,
    SUM(CASE WHEN mime_type='application/pdf' THEN 1 ELSE 0 END) AS pdfs
    FROM media_assets ${whereSql}`).get(...args);
  const totalPages=Math.max(1, Math.ceil(Number(summary.total||0)/pageSize));
  const safePage=Math.min(page,totalPages);
  const offset=(safePage-1)*pageSize;
  const assets=db.prepare(`SELECT * FROM media_assets ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args,pageSize,offset);
  res.render('admin/media',{title:'کتابخانه رسانه',assets,q,type,page:safePage,totalPages,summary,maxMediaMB});
});

router.post('/media/upload',(req,res,next)=>mediaUpload.single('file')(req,res,(err)=>{
  if(err){
    console.warn('⚠️ Media upload rejected:', err.code || err.message);
    const msg=err.code==='LIMIT_FILE_SIZE'
      ? 'حجم فایل بیشتر از سقف ۱ گیگابایت است.'
      : err.message==='MEDIA_TYPE_NOT_ALLOWED'
        ? 'فرمت این فایل در کتابخانه رسانه پشتیبانی نمی‌شود.'
        : 'آپلود فایل انجام نشد؛ دوباره تلاش کن.';
    return res.redirect('/admin/media?error='+encodeURIComponent(msg));
  }
  if (csrfRejected(req)) return rejectCsrf(req, res, req.file);
  if(!req.file) return res.redirect('/admin/media?error='+encodeURIComponent('فایل معتبر انتخاب نشده'));
  try{
    const url='/uploads/'+req.file.filename;
    db.prepare('INSERT INTO media_assets(filename,url,mime_type,size,alt_text) VALUES(?,?,?,?,?)')
      .run(req.file.originalname,url,req.file.mimetype,req.file.size,String(req.body.alt_text||'').slice(0,200));
    return res.redirect('/admin/media?notice='+encodeURIComponent('فایل با موفقیت به کتابخانه اضافه شد'));
  }catch(e){
    try{ fs.unlinkSync(req.file.path); }catch(_e){}
    console.error('❌ Media DB insert failed:',e);
    return res.redirect('/admin/media?error='+encodeURIComponent('فایل ذخیره شد اما ثبت اطلاعات آن در کتابخانه ناموفق بود.'));
  }
}));
router.post('/media/:id/delete',(req,res)=>{
  const id=positiveId(req.params.id);
  const asset=id ? db.prepare('SELECT * FROM media_assets WHERE id=?').get(id) : null;
  if(!asset) return res.redirect('/admin/media?error='+encodeURIComponent('رسانه پیدا نشد'));
  const refs = db.prepare(`SELECT
    (SELECT COUNT(*) FROM courses WHERE cover_image=?) +
    (SELECT COUNT(*) FROM blog_posts WHERE cover_image=?) +
    (SELECT COUNT(*) FROM homepage_banners WHERE image=?) +
    (SELECT COUNT(*) FROM homepage_sections WHERE image=?) AS c`).get(asset.url,asset.url,asset.url,asset.url).c;
  if (refs > 0) return res.redirect('/admin/media?error='+encodeURIComponent('این رسانه هنوز در سایت استفاده می‌شود؛ ابتدا ارجاع‌های آن را حذف یا تغییر بده.'));
  db.prepare('DELETE FROM media_assets WHERE id=?').run(asset.id);
  removeUploadUrl(asset.url);
  res.redirect('/admin/media?notice='+encodeURIComponent('رسانه و فایل آن حذف شد'));
});

// System health endpoint used by the Admin Pro dashboard.
router.get('/health', (req,res)=>{
  const dbOk = !!db.prepare('SELECT 1 AS ok').get().ok;
  const counts={users:db.prepare('SELECT COUNT(*) c FROM users').get().c,courses:db.prepare('SELECT COUNT(*) c FROM courses').get().c,orders:db.prepare('SELECT COUNT(*) c FROM orders').get().c};
  res.json({ok:dbOk,uptime:Math.round(process.uptime()),node:process.version,counts});
});


// ========================= P4 PREMIUM CONTROL =========================
router.get('/dashboard/live', (req,res)=>{
  const revenue=db.prepare("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid'").get().v;
  const todayRevenue=db.prepare("SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='paid' AND date(created_at)=date('now')").get().v;
  const todayOrders=db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid' AND date(created_at)=date('now')").get().c;
  const activeUsers=db.prepare("SELECT COUNT(*) c FROM users WHERE role='user' AND created_at>=datetime('now','-24 hours')").get().c;
  const pending=db.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending'").get().c;
  res.json({ok:true,revenue,todayRevenue,todayOrders,activeUsers,pending,uptime:Math.round(process.uptime()),now:new Date().toISOString()});
});

router.get('/banners',(req,res)=>{
  const banners=db.prepare('SELECT * FROM homepage_banners ORDER BY sort_order,id').all();
  res.render('admin/banners',{title:'بنرهای صفحه اصلی',banners});
});
router.post('/banners/new',(req,res)=>{
  const b=req.body; const title=String(b.title||'').trim().slice(0,160);
  if(!title) return res.redirect('/admin/banners?error='+encodeURIComponent('عنوان بنر الزامی است'));
  db.prepare('INSERT INTO homepage_banners(eyebrow,title,subtitle,cta_text,cta_url,image,accent,starts_at,ends_at,is_published,sort_order,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
    .run(String(b.eyebrow||'').slice(0,80),title,String(b.subtitle||'').slice(0,300),String(b.cta_text||'').slice(0,80),safeNavUrl(b.cta_url,'/courses'),String(b.image||'').slice(0,300),String(b.accent||'gold').slice(0,20),b.starts_at||null,b.ends_at||null,b.is_published?1:0,Number(b.sort_order)||0);
  res.redirect('/admin/banners');
});
router.post('/banners/:id/toggle',(req,res)=>{db.prepare('UPDATE homepage_banners SET is_published=1-is_published,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);res.redirect('/admin/banners');});
router.post('/banners/:id/delete',(req,res)=>{db.prepare('DELETE FROM homepage_banners WHERE id=?').run(req.params.id);res.redirect('/admin/banners');});
router.post('/banners/reorder',(req,res)=>{
  const ids=Array.isArray(req.body.ids)?[...new Set(req.body.ids.map(Number).filter(Number.isInteger).filter(id=>id>0))]:[];
  if(!ids.length) return res.status(400).json({ok:false,error:'لیست مرتب‌سازی نامعتبر است.'});
  const count=db.prepare(`SELECT COUNT(*) AS c FROM homepage_banners WHERE id IN (${ids.map(()=>'?').join(',')})`).get(...ids).c;
  if(count!==ids.length) return res.status(400).json({ok:false,error:'یکی از بنرها پیدا نشد.'});
  const stmt=db.prepare('UPDATE homepage_banners SET sort_order=? WHERE id=?');
  db.transaction(()=>ids.forEach((id,i)=>stmt.run(i+1,id)))();
  res.json({ok:true});
});

router.get('/menu',(req,res)=>{const items=db.prepare('SELECT * FROM site_menu_items ORDER BY location,sort_order,id').all();res.render('admin/menu',{title:'منوی سایت',items});});
router.post('/menu/new',(req,res)=>{const label=String(req.body.label||'').trim().slice(0,80),url=safeNavUrl(req.body.url,'');if(!label||!url)return res.redirect('/admin/menu?error='+encodeURIComponent('عنوان و لینک الزامی است'));db.prepare('INSERT INTO site_menu_items(label,url,location,is_published,sort_order) VALUES(?,?,?,?,?)').run(label,url,String(req.body.location||'header'),req.body.is_published?1:0,Number(req.body.sort_order)||0);res.redirect('/admin/menu');});
router.post('/menu/:id/toggle',(req,res)=>{db.prepare('UPDATE site_menu_items SET is_published=1-is_published WHERE id=?').run(req.params.id);res.redirect('/admin/menu');});
router.post('/menu/:id/delete',(req,res)=>{db.prepare('DELETE FROM site_menu_items WHERE id=?').run(req.params.id);res.redirect('/admin/menu');});
router.post('/menu/reorder',(req,res)=>{const ids=Array.isArray(req.body.ids)?[...new Set(req.body.ids.map(Number).filter(Number.isInteger).filter(id=>id>0))]:[];if(!ids.length)return res.status(400).json({ok:false,error:'لیست مرتب‌سازی نامعتبر است.'});const count=db.prepare(`SELECT COUNT(*) AS c FROM site_menu_items WHERE id IN (${ids.map(()=>'?').join(',')})`).get(...ids).c;if(count!==ids.length)return res.status(400).json({ok:false,error:'یکی از آیتم‌های منو پیدا نشد.'});const stmt=db.prepare('UPDATE site_menu_items SET sort_order=? WHERE id=?');db.transaction(()=>ids.forEach((id,i)=>stmt.run(i+1,id)))();res.json({ok:true});});

router.post('/homepage/reorder',(req,res)=>{const ids=Array.isArray(req.body.ids)?[...new Set(req.body.ids.map(Number).filter(Number.isInteger).filter(id=>id>0))]:[];if(!ids.length)return res.status(400).json({ok:false,error:'لیست مرتب‌سازی نامعتبر است.'});const count=db.prepare(`SELECT COUNT(*) AS c FROM homepage_sections WHERE id IN (${ids.map(()=>'?').join(',')})`).get(...ids).c;if(count!==ids.length)return res.status(400).json({ok:false,error:'یکی از بخش‌ها پیدا نشد.'});const stmt=db.prepare('UPDATE homepage_sections SET sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');db.transaction(()=>ids.forEach((id,i)=>stmt.run(i+1,id)))();res.json({ok:true});});



router.get('/system',(req,res)=>{
  const dbFile = db.name || path.join(__dirname,'../db/glowup.db');
  const stat=fs.existsSync(dbFile)?fs.statSync(dbFile):null;
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  let dbOk=false; try{db.prepare('SELECT 1').get();dbOk=true;}catch(e){}
  const checks={database:dbOk,uploads:fs.existsSync(uploadsDir),videos:fs.existsSync(videosDir),csrf:fs.existsSync(path.join(__dirname,'../middleware/auth.js'))};
  res.render('admin/system',{title:'وضعیت سیستم',dbSize:stat?.size||0,uptime:Math.round(process.uptime()),node:process.version,tables,checks});
});

router.get('/system/health',(req,res)=>{
  let database=false; try{db.prepare('SELECT 1').get();database=true;}catch(e){}
  res.json({ok:database,uptime:Math.round(process.uptime()),node:process.version,memory:process.memoryUsage().rss,checks:{database,uploads:fs.existsSync(uploadsDir),videos:fs.existsSync(videosDir)}});
});


// ---------- Backup & Recovery Center ----------
fs.mkdirSync(backupsDir, { recursive: true });
function activeDbPath() { return DB_PATH; }
function backupFiles() {
  return fs.readdirSync(backupsDir)
    .filter(name => /^glowup-[0-9TZ_.-]+\.db$/.test(name))
    .map(name => {
      const filePath = path.join(backupsDir, name);
      const stat = fs.statSync(filePath);
      return { name, size: stat.size, created_at: stat.mtime };
    })
    .sort((a,b) => b.created_at - a.created_at);
}
function safeBackupName(name) {
  const value = String(name || '');
  return /^glowup-[0-9TZ_.-]+\.db$/.test(value) ? value : null;
}
function pruneBackups(keep=20) {
  const files = backupFiles();
  files.slice(keep).forEach(f => { try { fs.unlinkSync(path.join(backupsDir, f.name)); } catch (_) {} });
}

router.get('/backups', requireRole('admin'), (req,res)=>{
  const dbPath = activeDbPath();
  let dbStat=null; try { if(fs.existsSync(dbPath)) dbStat=fs.statSync(dbPath); } catch (_) {}
  res.render('admin/backups', {
    title:'مرکز بکاپ و بازیابی',
    backups: backupFiles(),
    dbSize: dbStat?.size || 0,
    dbPath: path.basename(dbPath),
    keep: intValue(process.env.BACKUP_KEEP,20)
  });
});

router.post('/backups/create', requireRole('admin'), (req,res)=>{
  const source = activeDbPath();
  if(!fs.existsSync(source)) return res.redirect('/admin/backups?error='+encodeURIComponent('فایل دیتابیس پیدا نشد.'));
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const target = path.join(backupsDir, `glowup-${stamp}.db`);
  try {
    db.backup(target).then(()=>{
      pruneBackups(intValue(process.env.BACKUP_KEEP,20));
      try { db.prepare('INSERT INTO activity_logs(user_id,action,entity,meta) VALUES(?,?,?,?)').run(req.session.user.id,'/backups/create','backup',JSON.stringify({file:path.basename(target)})); } catch (_) {}
      res.redirect('/admin/backups?notice='+encodeURIComponent('بکاپ با موفقیت ساخته شد.'));
    }).catch(err=>res.redirect('/admin/backups?error='+encodeURIComponent('ساخت بکاپ ناموفق بود: '+err.message.slice(0,120))));
  } catch (err) {
    res.redirect('/admin/backups?error='+encodeURIComponent('ساخت بکاپ ناموفق بود.'));
  }
});

router.get('/backups/download/:name', requireRole('admin'), (req,res)=>{
  const name = safeBackupName(req.params.name);
  if(!name) return res.status(400).render('admin/error',{title:'بکاپ نامعتبر',message:'نام فایل بکاپ معتبر نیست.'});
  const filePath = path.join(backupsDir,name);
  if(!fs.existsSync(filePath)) return res.status(404).render('admin/error',{title:'بکاپ پیدا نشد',message:'فایل بکاپ دیگر وجود ندارد.'});
  res.download(filePath,name);
});

router.post('/backups/:name/delete', requireRole('admin'), (req,res)=>{
  const name=safeBackupName(req.params.name);
  if(!name) return res.redirect('/admin/backups?error='+encodeURIComponent('بکاپ نامعتبر است.'));
  const filePath=path.join(backupsDir,name);
  if(!fs.existsSync(filePath)) return res.redirect('/admin/backups?error='+encodeURIComponent('بکاپ پیدا نشد.'));
  try { fs.unlinkSync(filePath); } catch (_) { return res.redirect('/admin/backups?error='+encodeURIComponent('حذف بکاپ ناموفق بود.')); }
  res.redirect('/admin/backups?notice='+encodeURIComponent('بکاپ حذف شد.'));
});

// Restore is intentionally an explicit, destructive operation. The process exits after
// swapping the DB file so the app restarts cleanly with the restored snapshot.
router.post('/backups/:name/restore', requireRole('admin'), (req,res)=>{
  const name=safeBackupName(req.params.name);
  if(!name) return res.redirect('/admin/backups?error='+encodeURIComponent('بکاپ نامعتبر است.'));
  const backupPath=path.join(backupsDir,name), source=activeDbPath();
  if(!fs.existsSync(backupPath)) return res.redirect('/admin/backups?error='+encodeURIComponent('بکاپ پیدا نشد.'));
  if(path.resolve(backupPath)===path.resolve(source)) return res.redirect('/admin/backups?error='+encodeURIComponent('این فایل، دیتابیس فعال است.'));
  const emergency = path.join(backupsDir, `before-restore-${new Date().toISOString().replace(/[:.]/g,'-')}.db`);
  try {
    // Snapshot the live database through SQLite first (important with WAL mode), then
    // close the handle before replacing the live file. A raw copy of glowup.db can be
    // stale while glowup.db-wal still contains committed transactions.
    db.backup(emergency).then(() => {
      db.close();
      fs.copyFileSync(backupPath, source);
      // Keep the HTTP response simple; process manager will reopen the restored DB.
    res.status(200).send('<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>بازیابی انجام شد</title><style>body{font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#0a0a0a;color:#eee}.box{padding:32px;border:1px solid #5f4b20;border-radius:20px;max-width:560px;text-align:center}.gold{color:#d8b15a}</style><div class="box"><h1 class="gold">بازیابی موفق بود ✓</h1><p>دیتابیس بازیابی شد. سرور اکنون برای بارگذاری نسخه بازیابی‌شده Restart می‌شود.</p></div></html>');
    // The SQLite handle is closed above; keeping the HTTP process alive would leave
    // the app serving requests against a closed database. Let the process manager
    // reopen the restored database cleanly.
      setTimeout(() => process.exit(0), 250);
    }).catch((err) => {
      // The SQLite handle is closed by the time replacement can fail. Restore the
      // emergency snapshot and terminate so the process manager starts cleanly.
      try { if (fs.existsSync(emergency)) fs.copyFileSync(emergency, source); } catch (_) {}
      try { res.status(500).render('admin/error',{title:'بازیابی ناموفق',message:'بازیابی انجام نشد؛ نسخه قبلی حفظ شد و سرور Restart می‌شود.'}); } catch (_) {}
      setTimeout(() => process.exit(1), 250);
    });
  } catch (err) {
    res.status(500).render('admin/error',{title:'بازیابی ناموفق',message:'بازیابی انجام نشد.'});
  }
});

function friendlyAdminDbError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(msg)) return 'این مقدار قبلاً ثبت شده است. یک مقدار متفاوت وارد کن.';
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || /FOREIGN KEY constraint failed/i.test(msg)) return 'این تغییر به اطلاعات دیگری وابسته است و قابل ذخیره نیست.';
  if (/NOT NULL constraint failed/i.test(msg)) return 'یکی از فیلدهای الزامی خالی است.';
  if (/no such column/i.test(msg)) return 'ساختار دیتابیس این نسخه کامل نیست؛ برنامه را یک‌بار ببند و دوباره اجرا کن تا مهاجرت‌ها انجام شوند.';
  if (/database is locked/i.test(msg)) return 'دیتابیس موقتاً درگیر است؛ چند ثانیه صبر کن و دوباره ذخیره کن.';
  if (/CHECK constraint failed/i.test(msg)) return 'یکی از مقادیر واردشده خارج از محدوده مجاز است.';
  return 'ذخیره انجام نشد. اطلاعات فرم را بررسی کن و دوباره تلاش کن.';
}

// ---------- Admin safety net ----------
// Old bookmarks and accidental URLs should never expose a raw Express 404 page.
router.use((req, res) => {
  res.status(404).render('admin/error', {
    title: 'صفحه مدیریت پیدا نشد',
    message: 'این بخش از پنل وجود ندارد یا آدرس آن تغییر کرده است.'
  });
});

// Convert predictable database/upload failures into a friendly admin response.
router.use((err, req, res, next) => {
  console.error('❌ Admin route error:', err);
  if (res.headersSent) return next(err);
  const message = err?.code === 'LIMIT_FILE_SIZE'
    ? 'حجم فایل بیشتر از حد مجاز است.'
    : friendlyAdminDbError(err);
  const back = safeAdminRedirect(req, res, '/admin');
  if (back.startsWith('/admin')) {
    const sep = back.includes('?') ? '&' : '?';
    return res.redirect(back + sep + 'error=' + encodeURIComponent(message));
  }
  return res.status(400).render('admin/error', { title: 'عملیات انجام نشد', message });
});

module.exports = router;
