const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

// Persistent throttling: counters live in SQLite so restarts and multiple app workers
// do not reset the protection. Keys are scoped by purpose + IP + normalized phone.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const RESET_WINDOW_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const RESET_CODE_MAX_ATTEMPTS = 8;
function throttleKey(req) { return `login|${req.ip}|${normalizePhone(req.body?.phone)}`; }
function resetKey(req) { return `reset-request|${req.ip}|${normalizePhone(req.body?.phone || req.query?.phone)}`; }
function resetCodeKey(req) { return `reset-code|${req.ip}|${normalizePhone(req.body?.phone)}`; }
function isDbThrottled(key, windowMs, max) {
  const now=Date.now();
  const item=db.prepare('SELECT first_at,count FROM auth_throttle WHERE throttle_key=?').get(key);
  if(!item) return false;
  if(now-Number(item.first_at)>windowMs){ db.prepare('DELETE FROM auth_throttle WHERE throttle_key=?').run(key); return false; }
  return Number(item.count)>=max;
}
function recordDbFailure(key, windowMs) {
  const now=Date.now();
  const tx=db.transaction(()=>{
    const item=db.prepare('SELECT first_at,count FROM auth_throttle WHERE throttle_key=?').get(key);
    if(!item || now-Number(item.first_at)>windowMs) db.prepare('INSERT OR REPLACE INTO auth_throttle(throttle_key,first_at,count,updated_at) VALUES(?,?,?,?)').run(key,now,1,now);
    else db.prepare('UPDATE auth_throttle SET count=count+1,updated_at=? WHERE throttle_key=?').run(now,key);
  });
  tx();
}
function clearDbFailures(key) { db.prepare('DELETE FROM auth_throttle WHERE throttle_key=?').run(key); }
function isThrottled(req) { return isDbThrottled(throttleKey(req), WINDOW_MS, MAX_ATTEMPTS); }
function recordFailure(req) { recordDbFailure(throttleKey(req), WINDOW_MS); }
function clearFailures(req) { clearDbFailures(throttleKey(req)); }
function isResetThrottled(req) { return isDbThrottled(resetKey(req), RESET_WINDOW_MS, RESET_MAX_ATTEMPTS); }
function recordResetAttempt(req) { recordDbFailure(resetKey(req), RESET_WINDOW_MS); }
function isResetCodeThrottled(req) { return isDbThrottled(resetCodeKey(req), RESET_WINDOW_MS, RESET_CODE_MAX_ATTEMPTS); }
function recordResetCodeFailure(req) { recordDbFailure(resetCodeKey(req), RESET_WINDOW_MS); }
function clearResetCodeFailures(req) { clearDbFailures(resetCodeKey(req)); }
setInterval(() => {
  const cutoff=Date.now()-Math.max(WINDOW_MS,RESET_WINDOW_MS);
  try { db.prepare('DELETE FROM auth_throttle WHERE updated_at < ?').run(cutoff); } catch (_) {}
}, 5*60*1000).unref();

function normalizeDigits(value) {
  return String(value || '').replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
function normalizePhone(value) {
  let raw = normalizeDigits(value).replace(/[\s-]/g, '');
  if (raw.startsWith('+98')) raw = '0' + raw.slice(3);
  else if (raw.startsWith('0098')) raw = '0' + raw.slice(4);
  return raw;
}
router.get('/login', (req, res) => {
  res.render('login', { title: 'ورود', error: null });
});

router.post('/login', (req, res, next) => {
  if (isThrottled(req)) return res.status(429).render('login', { title: 'ورود', error: 'تعداد تلاش‌های ورود زیاد است. لطفاً چند دقیقه بعد دوباره امتحان کنید.' });
  const phone = normalizePhone(req.body?.phone);
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !password || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(req);
    return res.render('login', { title: 'ورود', error: 'شماره یا رمز عبور اشتباه است.' });
  }
  clearFailures(req);
  const rawDest = String(req.session.returnTo || '');
  const dest = /^\/(?!\/)/.test(rawDest) && !rawDest.startsWith('/\\') ? rawDest : (['admin','editor','support'].includes(user.role) ? '/admin' : '/');
  const oldCart = Array.isArray(req.session.cart) ? req.session.cart : [];
  const oldBundleCart = Array.isArray(req.session.bundleCart) ? req.session.bundleCart : [];
  const referralCode = String(req.session.referralCode || '').trim().toUpperCase();
  delete req.session.returnTo;
  // Prevent session fixation after authentication while preserving the user's
  // intended shopping/referral state from the anonymous session.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
    req.session.cart = oldCart;
    req.session.bundleCart = oldBundleCart;
    if (referralCode) req.session.referralCode = referralCode;
    req.session.user = { id: user.id, full_name: user.full_name, phone: user.phone, role: user.role };
    req.session.save((saveErr) => saveErr ? next(saveErr) : res.redirect(dest));
  });
});

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { title: 'فراموشی رمز عبور', error: null, success: null, phone: '' });
});

router.post('/forgot-password', (req, res) => {
  const phone = normalizePhone(req.body?.phone).slice(0, 30);
  if (isResetThrottled(req)) {
    return res.status(429).render('forgot-password', { title: 'فراموشی رمز عبور', error: 'تعداد درخواست‌ها زیاد است. لطفاً چند دقیقه بعد دوباره تلاش کن.', success: null, phone });
  }
  recordResetAttempt(req);
  const generic = 'اگر این شماره در گلو‌آپ آکادمی ثبت شده باشد، کد بازیابی برای آن ایجاد شد.';
  if (!/^09\d{9}$/.test(phone)) {
    return res.render('forgot-password', { title: 'فراموشی رمز عبور', error: 'شماره موبایل را به شکل 09xxxxxxxxx وارد کن.', success: null, phone });
  }
  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  let devCode = null;
  if (user) {
    db.prepare('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL').run(user.id);
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    db.prepare("INSERT INTO password_reset_tokens(user_id, phone, code_hash, expires_at) VALUES(?,?,?,datetime('now','+10 minutes'))")
      .run(user.id, phone, codeHash);
    if (process.env.NODE_ENV !== 'production' || process.env.PASSWORD_RESET_DEV_MODE === 'true') devCode = code;
    console.log(`🔐 Password reset code generated for user ${user.id}${devCode ? `: ${devCode}` : ''}`);
  }
  res.render('forgot-password', { title: 'فراموشی رمز عبور', error: null, success: generic, phone, devCode });
});

router.get('/reset-password', (req, res) => {
  const phone = normalizePhone(req.query?.phone || '').slice(0, 30);
  res.render('reset-password', { title: 'تغییر رمز عبور', error: null, success: null, phone });
});

router.post('/reset-password', (req, res) => {
  const phone = normalizePhone(req.body?.phone).slice(0, 30);
  const code = normalizeDigits(req.body?.code).replace(/\D/g, '').slice(0, 6);
  const password = String(req.body?.password || '');
  const render = (error) => res.status(error ? 400 : 200).render('reset-password', { title: 'تغییر رمز عبور', error, success: null, phone });
  if (!/^09\d{9}$/.test(phone) || !/^\d{6}$/.test(code)) return render('شماره موبایل یا کد بازیابی معتبر نیست.');
  if (isResetCodeThrottled(req)) return res.status(429).render('reset-password', { title: 'تغییر رمز عبور', error: 'تعداد تلاش برای کد بازیابی زیاد است. لطفاً چند دقیقه بعد دوباره تلاش کن.', success: null, phone });
  if (!password || password.length < 6 || password.length > 200) return render('رمز جدید باید بین ۶ تا ۲۰۰ کاراکتر باشد.');
  const user = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (!user) return render('کد بازیابی معتبر نیست یا منقضی شده است.');
  const token = db.prepare("SELECT id,code_hash,attempts FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1").get(user.id);
  if (!token || Number(token.attempts||0) >= RESET_CODE_MAX_ATTEMPTS) return render('کد بازیابی معتبر نیست یا منقضی شده است.');
  const hash = crypto.createHash('sha256').update(code).digest('hex');
  const hashesMatch = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(token.code_hash, 'hex'));
  if (!hashesMatch) { recordResetCodeFailure(req); db.prepare("UPDATE password_reset_tokens SET attempts=attempts+1 WHERE id=? AND used_at IS NULL").run(token.id); return render('کد بازیابی اشتباه است.'); }
  clearResetCodeFailures(req);
  const passwordHash = bcrypt.hashSync(password, 12);
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
    const consumed = db.prepare("UPDATE password_reset_tokens SET used_at=CURRENT_TIMESTAMP WHERE id=? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP").run(token.id);
    if (consumed.changes !== 1) throw new Error('RESET_TOKEN_ALREADY_USED');
  });
  try { tx(); } catch (e) {
    if (e.message === 'RESET_TOKEN_ALREADY_USED') return render('کد بازیابی منقضی شده یا قبلاً استفاده شده است.');
    throw e;
  }
  // Invalidate an already-authenticated session after a password reset so a stolen
  // old session cannot remain usable after the credential has changed.
  if (req.session.user?.id === user.id) {
    return req.session.destroy(() => res.render('reset-password', { title: 'تغییر رمز عبور', error: null, success: 'رمز عبور با موفقیت تغییر کرد. حالا می‌توانی وارد حساب شوی.', phone }));
  }
  res.render('reset-password', { title: 'تغییر رمز عبور', error: null, success: 'رمز عبور با موفقیت تغییر کرد. حالا می‌توانی وارد حساب شوی.', phone });
});

router.get('/register', (req, res) => {
  res.render('register', { title: 'ثبت‌نام', error: null });
});

router.post('/register', (req, res) => {
  const full_name = String(req.body?.full_name || '').trim().slice(0, 120);
  const phone = normalizePhone(req.body?.phone).slice(0, 30);
  const password = String(req.body?.password || '');
  if (!full_name || !phone || !password || password.length < 6 || password.length > 200) {
    return res.render('register', { title: 'ثبت‌نام', error: 'همه فیلدها الزامی است و رمز باید بین ۶ تا ۲۰۰ کاراکتر باشد.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
  if (existing) return res.render('register', { title: 'ثبت‌نام', error: 'این شماره قبلاً ثبت‌نام کرده است.' });
  const referralCode = String(req.session.referralCode || '').trim().toUpperCase();
  const referral = referralCode ? db.prepare('SELECT user_id,code FROM referral_codes WHERE code=?').get(referralCode) : null;
  const hash = bcrypt.hashSync(password, 12);
  let info;
  try {
    info = db.prepare('INSERT INTO users (full_name, phone, password_hash) VALUES (?, ?, ?)').run(full_name, phone, hash);
  } catch (err) {
    if (String(err?.code || '').includes('SQLITE_CONSTRAINT')) {
      return res.render('register', { title: 'ثبت‌نام', error: 'این شماره قبلاً ثبت‌نام کرده است.' });
    }
    throw err;
  }
  if (referral && referral.user_id !== Number(info.lastInsertRowid)) {
    db.prepare('INSERT OR IGNORE INTO referrals(referrer_id,referred_id,code,reward_amount,status) VALUES(?,?,?,?,?)')
      .run(referral.user_id, info.lastInsertRowid, referral.code, 0, 'pending');
  }
  // Rotate the session after registration as well, while carrying over only the intended cart state.
  const oldCart = Array.isArray(req.session.cart) ? req.session.cart : [];
  const oldBundleCart = Array.isArray(req.session.bundleCart) ? req.session.bundleCart : [];
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('register', { title: 'ثبت‌نام', error: 'ساخت حساب انجام نشد. دوباره تلاش کن.' });
    req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
    req.session.cart = oldCart;
    req.session.bundleCart = oldBundleCart;
    req.session.user = { id: info.lastInsertRowid, full_name, phone, role: 'user' };
    req.session.save((saveErr) => saveErr ? res.status(500).render('register', { title: 'ثبت‌نام', error: 'ساخت حساب انجام نشد. دوباره تلاش کن.' }) : res.redirect('/'));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

module.exports = router;
