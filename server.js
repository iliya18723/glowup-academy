require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db');
const { attachUser } = require('./middleware/auth');
const { DB_PATH, SESSION_DB_PATH, UPLOADS_DIR, VIDEOS_DIR } = require('./config');

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');

const app = express();
app.disable('x-powered-by');
app.set('query parser', 'simple');

// Basic security headers without adding another runtime dependency.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
function csrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

app.use(session({
  store: new SQLiteStore({ db: path.basename(SESSION_DB_PATH), dir: path.dirname(SESSION_DB_PATH) }),
  secret: process.env.SESSION_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required in production');
    return 'dev-only-change-me';
  })(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' ? process.env.COOKIE_SECURE === 'true' : false } // 30 روز
}));

app.use(attachUser(db));

// Paid course videos uploaded to /public/uploads/videos must not be publicly reachable.
// Stream them only after checking the logged-in user owns the course (or the lesson is a free preview).
const videoMime = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska'
};
function streamProtectedCourseVideo(req, res, next) {
  const filename = path.basename(String(req.params.filename || ''));
  if (!filename || filename !== String(req.params.filename || '') || filename.includes('..')) {
    return res.status(404).end();
  }
  if (!req.session.user?.id) return res.status(401).end();

  const videoUrl = '/uploads/videos/' + filename;
  const rows = db.prepare(`
    SELECT cs.id, cs.video_url, cs.is_free_preview, c.id AS course_id
    FROM course_sessions cs
    JOIN courses c ON c.id=cs.course_id
    WHERE cs.video_url=? AND c.is_published=1
  `).all(videoUrl);
  // A video URL must map to exactly one published lesson. Ambiguous mappings
  // could otherwise authorize a user against the wrong course.
  if (rows.length !== 1) return res.status(404).end();
  const row = rows[0];

  const owned = !!db.prepare('SELECT 1 FROM enrollments WHERE user_id=? AND course_id=?')
    .get(req.session.user.id, row.course_id);
  if (!owned && !row.is_free_preview) return res.status(403).end();

  const filePath = path.join(VIDEOS_DIR, filename);
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return res.status(404).end(); }
  if (!stat.isFile()) return res.status(404).end();

  const contentType = videoMime[path.extname(filename).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'HEAD') return res.status(200).setHeader('Content-Length', stat.size).end();

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
  let start = match[1] === '' ? Math.max(0, stat.size - Number(match[2] || 0)) : Number(match[1]);
  let end = match[2] === '' ? stat.size - 1 : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    return res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end();
  }
  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader('Content-Length', chunkSize);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  return fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get('/uploads/videos/:filename', streamProtectedCourseVideo);
app.head('/uploads/videos/:filename', streamProtectedCourseVideo);

// Mutable uploads live outside the application bundle so they survive deploys on persistent storage.
app.use('/uploads', express.static(UPLOADS_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag: true
}));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag: true
}));

app.use((req, res, next) => {
  const token = csrfToken(req);
  res.locals.csrfToken = token;
  res.locals.csrfField = `<input type="hidden" name="_csrf" value="${token}">`;
  // Admin pages must never be cached: a cached form can contain an expired CSRF token
  // after login/password/session rotation and makes a perfectly valid Save look broken.
  if (req.path.startsWith('/admin')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // multipart/form-data is parsed by route-level multer middleware, which runs
    // after this global middleware. Defer CSRF validation for multipart requests
    // to the upload wrapper after multer has populated req.body.
    if (String(req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')) return next();
    const supplied = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
    const expected = String(req.session.csrfToken || '');
    const crypto = require('crypto');
    if (!supplied || !expected || supplied.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      console.warn('⚠️ CSRF rejected:', req.method, req.originalUrl, '| session:', req.sessionID);
      if (req.path.startsWith('/admin')) {
        const back = req.get('referer');
        let target = '/admin';
        try {
          const u = back ? new URL(back) : null;
          if (u && u.origin === `${req.protocol}://${req.get('host')}` && u.pathname.startsWith('/admin')) target = u.pathname + u.search;
        } catch (_) {}
        const sep = target.includes('?') ? '&' : '?';
        return res.redirect(target + sep + 'error=' + encodeURIComponent('فرم قدیمی یا منقضی شده بود. صفحه را تازه کن و دوباره ذخیره کن.'));
      }
      return res.status(403).render('403', { title: 'درخواست نامعتبر' });
    }
  }
  next();
});

app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const dbFile = DB_PATH;
    res.json({ ok: true, service: 'glowup-academy', database: fs.existsSync(dbFile) ? 'sqlite' : 'initializing', uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'database_unavailable' });
  }
});

app.use((req,res,next)=>{
  try {
    res.locals.siteNav = db.prepare("SELECT * FROM site_menu_items WHERE location='header' AND is_published=1 ORDER BY sort_order,id").all();
    if (req.session.user?.id) {
      const uid = req.session.user.id;
      res.locals.notificationUnreadCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0').get(uid).c;
      res.locals.notificationPreview = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 5').all(uid);
    } else {
      res.locals.notificationUnreadCount = 0;
      res.locals.notificationPreview = [];
    }
  } catch(e) { res.locals.siteNav = []; res.locals.notificationUnreadCount = 0; res.locals.notificationPreview = []; }
  next();
});

app.use('/', publicRoutes);
app.use('/', authRoutes);
app.use('/payment', paymentRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('404', { title: 'صفحه پیدا نشد' });
});

// خطاگیر سراسری — تا یک خطا در یک صفحه کل سایت را از کار نیندازد
app.use((err, req, res, next) => {
  console.error('❌ خطای سرور:', err);
  if (res.headersSent) return next(err);
  res.status(500).send('یک خطای غیرمنتظره رخ داد. لطفاً صفحه را رفرش کنید یا بعداً دوباره امتحان کنید.');
});

// محافظت نهایی در برابر کرش کامل برنامه به‌خاطر خطاهای پیش‌بینی‌نشده
process.on('uncaughtException', (err) => {
  console.error('❌ خطای مدیریت‌نشده (uncaughtException):', err);
  // Do not keep a potentially corrupted process alive in production.
  if (process.env.NODE_ENV === 'production') process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ خطای مدیریت‌نشده (unhandledRejection):', err);
});

const PORT = Number(process.env.PORT || 3000);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT must be a valid TCP port');
const server = app.listen(PORT, () => {
  console.log(`🚀 GlowUp Academy در حال اجرا روی port ${PORT}`);
});

function shutdown(signal) {
  console.log(`\n🛑 ${signal}: shutting down gracefully...`);
  server.close(() => {
    try { db.close(); } catch (e) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

