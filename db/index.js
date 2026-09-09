const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../config');
const isNew = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema on first launch (or whenever tables are missing)
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// مهاجرت‌های سبک برای نصب‌های قبلی که ستون‌های جدید را ندارند
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some(c => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`✅ ستون ${column} به جدول ${table} اضافه شد.`);
  }
}
ensureColumn('course_sessions', 'phase', 'TEXT');
ensureColumn('orders', 'coupon_id', 'INTEGER');
ensureColumn('orders', 'discount_amount', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'referral_id', 'INTEGER');
// P0-5 XP ledger protects gamification from duplicate rewards on repeated completion.
db.exec(`CREATE TABLE IF NOT EXISTS xp_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, session_id INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 25, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,session_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(session_id) REFERENCES course_sessions(id) ON DELETE CASCADE); CREATE INDEX IF NOT EXISTS idx_xp_events_user ON xp_events(user_id,created_at);`);
// P0-4 referral reward ledger is created by schema.sql; these indexes are safe on upgrades.
db.exec(`CREATE INDEX IF NOT EXISTS idx_referral_rewards_order ON referral_rewards(order_id);`);
// P0 tables are created by schema.sql above; indexes keep common lookups fast.
const p4Schema = fs.readFileSync(path.join(__dirname, 'schema-p4.sql'), 'utf-8');
db.exec(p4Schema);
// Seed a small editable default navigation only when the site has none.
// P0-4 referral reward defaults. Stored in settings so admins can tune policy later.
const referralSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
referralSetting.run('referral_reward_percent','5');
referralSetting.run('referral_reward_cap','100000');
referralSetting.run('referral_discount_cap','100000');

if (db.prepare('SELECT COUNT(*) c FROM site_menu_items').get().c === 0) {
  const ins = db.prepare('INSERT INTO site_menu_items(label,url,location,is_published,sort_order) VALUES(?,?,?,?,?)');
  const tx = db.transaction(() => [
    ['خانه','/','header',1,1],['دوره‌ها','/courses','header',1,2],['جستجو','/search','header',1,3],['وبلاگ','/blog','header',1,4],['درباره','/#about','header',1,5],['تماس با ما','/#contact','header',1,6]
  ].forEach(x=>ins.run(...x))); tx();
}

db.exec(`CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
); CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id,created_at);`);
ensureColumn('password_reset_tokens', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS auth_throttle (throttle_key TEXT PRIMARY KEY, first_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_auth_throttle_updated ON auth_throttle(updated_at);`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_course_approved ON reviews(course_id,is_approved); CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id,is_read); CREATE INDEX IF NOT EXISTS idx_wishlists_user ON wishlists(user_id); CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status,created_at); CREATE INDEX IF NOT EXISTS idx_order_items_course ON order_items(course_id); CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);`);

// Default gamification badges are required by the progress endpoint. Keep them idempotent.
const badgeSeed = [
  ['first-step','اولین قدم','🚀','اولین جلسه را کامل کردی'],
  ['on-fire','روی فرم','🔥','سه روز متوالی فعال بودی'],
  ['finisher','تمام‌کننده','🏆','یک دوره را کامل کردی']
];
const badgeInsert = db.prepare('INSERT OR IGNORE INTO badges(slug,title,icon,description) VALUES(?,?,?,?)');
db.transaction(() => badgeSeed.forEach(b => badgeInsert.run(...b)))();

if (isNew) {
  console.log('✅ دیتابیس جدید ساخته شد و اسکیمای اولیه اجرا شد.');
}

module.exports = db;
