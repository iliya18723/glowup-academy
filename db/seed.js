// اجرای این فایل: npm run seed
// یک ادمین پیش‌فرض و چند دوره نمونه می‌سازد.
const bcrypt = require('bcryptjs');
const db = require('./index');

function upsertCategory(title, slug) {
  const existing = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO categories (title, slug) VALUES (?, ?)').run(title, slug);
  return info.lastInsertRowid;
}


function ensureCourseSessions(courseId, count) {
  const target = Math.max(0, Number(count) || 0);
  const current = db.prepare('SELECT COUNT(*) c FROM course_sessions WHERE course_id=?').get(courseId).c;
  if (current >= target) return;
  const ins = db.prepare(`INSERT INTO course_sessions (course_id,title,phase,video_url,duration_seconds,sort_order,is_free_preview)
    VALUES (?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    for (let i = current + 1; i <= target; i++) {
      ins.run(courseId, `جلسه ${i}`, `فاز ${Math.ceil(i / 5)}`, null, 0, i, i === 1 ? 1 : 0);
    }
  });
  tx();
}

function upsertCourse(c) {
  const existing = db.prepare('SELECT id FROM courses WHERE slug = ?').get(c.slug);
  if (existing) return existing.id;
  const info = db.prepare(`
    INSERT INTO courses (title, slug, subtitle, description, cover_image, price, discount_price, sessions_count, category_id, is_featured)
    VALUES (@title, @slug, @subtitle, @description, @cover_image, @price, @discount_price, @sessions_count, @category_id, @is_featured)
  `).run(c);
  return info.lastInsertRowid;
}

// --- Admin ---
const isProduction = process.env.NODE_ENV === 'production';
const adminPhone = String(process.env.ADMIN_INITIAL_PHONE || (isProduction ? '' : '09120000000')).trim();
const adminPassword = String(process.env.ADMIN_INITIAL_PASSWORD || (isProduction ? '' : 'Admin@123'));
if (isProduction && (!/^09\d{9}$/.test(adminPhone) || adminPassword.length < 12)) {
  throw new Error('In production, ADMIN_INITIAL_PHONE and ADMIN_INITIAL_PASSWORD (12+ chars) are required to seed the first admin.');
}
if (adminPhone) {
  const adminExists = db.prepare('SELECT id FROM users WHERE phone = ?').get(adminPhone);
  if (!adminExists) {
    const hash = bcrypt.hashSync(adminPassword, 12);
    db.prepare(`
      INSERT INTO users (full_name, phone, email, password_hash, role)
      VALUES (?, ?, ?, ?, 'admin')
    `).run('مدیر سایت', adminPhone, 'admin@glowup.academy', hash);
    console.log(`✅ کاربر ادمین ساخته شد -> شماره: ${adminPhone}`);
  }
}

// --- Categories ---
const catFitness = upsertCategory('تناسب اندام', 'fitness');
const catStyle = upsertCategory('استایل و ظاهر', 'style');
const catMind = upsertCategory('ذهن و روان', 'mind');

// --- Courses ---
const seededCourse1 = upsertCourse({
  title: 'بدنتو بساز',
  slug: 'body-transformation',
  subtitle: 'برنامه تمرینی و رژیم حرفه‌ای',
  description: 'یک برنامه کامل تمرینی و تغذیه برای ساخت بدنی متناسب و قدرتمند.',
  cover_image: '/uploads/course-body.jpg',
  price: 890000,
  discount_price: 690000,
  sessions_count: 30,
  category_id: catFitness,
  is_featured: 1
});
ensureCourseSessions(seededCourse1, 30);

const seededCourse2 = upsertCourse({
  title: 'خط و فک و صورت مردانه',
  slug: 'face-jawline',
  subtitle: 'چهره‌ای جذاب و متناسب',
  description: 'تمرینات و تکنیک‌های تخصصی برای بهبود ظاهر خط فک و صورت.',
  cover_image: '/uploads/course-face.jpg',
  price: 450000,
  discount_price: null,
  sessions_count: 15,
  category_id: catStyle,
  is_featured: 1
});
ensureCourseSessions(seededCourse2, 15);

const seededCourse3 = upsertCourse({
  title: 'دوره کامل گلو آپ در ۳۰ روز',
  slug: 'full-glowup-30days',
  subtitle: 'برنامه جامع تغییر در ۴ فاز',
  description: 'مسیر کامل تحول ظاهری و ذهنی در یک برنامه ۳۰ روزه و چهار فازی.',
  cover_image: '/uploads/course-full.jpg',
  price: 1490000,
  discount_price: 1190000,
  sessions_count: 30,
  category_id: catStyle,
  is_featured: 1
});
ensureCourseSessions(seededCourse3, 30);

const seededCourse4 = upsertCourse({
  title: 'استایل و جذابیت',
  slug: 'style-charisma',
  subtitle: 'تیپ، اعتماد به نفس، زبان بدن',
  description: 'اصول استایل شخصی، پوشش مناسب و افزایش جذابیت ظاهری.',
  cover_image: '/uploads/course-style.jpg',
  price: 590000,
  discount_price: null,
  sessions_count: 12,
  category_id: catStyle,
  is_featured: 1
});
ensureCourseSessions(seededCourse4, 12);

const seededCourse5 = upsertCourse({
  title: 'ذهن قدرتمند',
  slug: 'strong-mind',
  subtitle: 'تمرکز، عادت‌سازی، دیسیپلین',
  description: 'ساخت ذهنی قوی از طریق تمرکز، نظم و عادت‌های سازنده.',
  cover_image: '/uploads/course-mind.jpg',
  price: 650000,
  discount_price: 520000,
  sessions_count: 18,
  category_id: catMind,
  is_featured: 1
});
ensureCourseSessions(seededCourse5, 18);

console.log('✅ دوره‌های نمونه ساخته شدند.');
