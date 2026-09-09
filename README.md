# GlowUp Academy — سایت کامل فروش دوره + پنل ادمین

کلون کامل طراحی سایت آکادمی گلو آپ با بک‌اند واقعی، دیتابیس، پنل ادمین کامل و اتصال به درگاه پرداخت زرین‌پال.

## امکانات
- صفحه اصلی، لیست دوره‌ها، صفحه جزئیات دوره، وبلاگ — دقیقاً با تم تیره/طلایی طرح اصلی
- ثبت‌نام / ورود کاربران با شماره موبایل و رمز عبور (رمزنگاری bcrypt)
- سبد خرید و پرداخت آنلاین با **درگاه زرین‌پال** (Sandbox و Production)
- بعد از پرداخت موفق، دوره خودکار به حساب کاربر اضافه می‌شود (Enrollment)
- **پنل ادمین کامل**:
  - داشبورد آماری (تعداد کاربران، دوره‌ها، سفارش‌ها، درآمد)
  - مدیریت دوره‌ها (افزودن، ویرایش، حذف، آپلود تصویر، مدیریت جلسات هر دوره)
  - مدیریت دسته‌بندی‌ها
  - مدیریت کاربران (تغییر نقش به ادمین، حذف کاربر)
  - مدیریت سفارش‌ها و مشاهده جزئیات هر تراکنش
  - مدیریت وبلاگ (افزودن/ویرایش/حذف مطالب)

## نصب و اجرا (روی سیستم خودت یا سرور)

```bash
# 1) نصب پکیج‌ها
npm install

# 2) کپی فایل تنظیمات
cp .env.example .env
# سپس مقدار SESSION_SECRET و ZARINPAL_MERCHANT_ID را در .env وارد کن

# 3) ساخت دیتابیس + داده‌های نمونه
npm run seed

# 4) اجرای سایت
npm start
```

سایت روی `http://localhost:3000` بالا می‌آید.

## ورود به پنل ادمین
در محیط توسعه، `npm run seed` برای راحتی حساب نمونه `09120000000` را با رمز `Admin@123` می‌سازد. **این اطلاعات فقط برای توسعه محلی هستند.**

در Production، `npm run seed` بدون `ADMIN_INITIAL_PHONE` و `ADMIN_INITIAL_PASSWORD` متوقف می‌شود و دیگر رمز پیش‌فرض ساخته نمی‌شود. رمز اولیه باید حداقل ۱۲ کاراکتر باشد.

برای تغییر رمز یک ادمین موجود بدون ورود به پنل: `ADMIN_PHONE=09xxxxxxxxx ADMIN_PASSWORD='یک-رمز-۱۲-کاراکتری-قوی' npm run admin:password` (در PowerShell مقدار متغیرها را قبل از اجرای دستور تنظیم کن).

## اتصال درگاه پرداخت زرین‌پال (برای پرداخت واقعی)
1. در سایت [zarinpal.com](https://www.zarinpal.com) ثبت‌نام و یک "مرچنت کد" بگیر.
2. مقدار `ZARINPAL_MERCHANT_ID` را در فایل `.env` قرار بده.
3. برای تست از `ZARINPAL_SANDBOX=true` استفاده کن؛ برای پرداخت واقعی آن را `false` کن.
4. سایت باید روی دامنه واقعی با HTTPS اجرا شود تا زرین‌پال callback را بپذیرد.

## دیپلوی روی هاست/سرور
این پروژه یک اپلیکیشن Node.js استاندارد است و روی هر سروری قابل اجراست:
- **لیارا / آرون / کاپسول** (هاست‌های ایرانی مناسب Node.js)
- **یک VPS ساده** با PM2 برای اجرای دائمی: `pm2 start server.js --name glowup`
- پشت آن یک **دامنه با SSL** (مثلاً از طریق Nginx + Let's Encrypt) قرار بده.

## ساختار پروژه
```
glowup-academy/
├── server.js              # نقطه ورود اصلی
├── db/                     # اسکیمای دیتابیس SQLite + seed
├── routes/                 # مسیرهای عمومی، احراز هویت، پرداخت، ادمین
├── middleware/auth.js       # کنترل دسترسی کاربر/ادمین
├── utils/zarinpal.js        # اتصال به درگاه پرداخت
├── views/                  # قالب‌های EJS (سایت عمومی + پنل ادمین)
└── public/                 # CSS، تصاویر آپلودی
```

## نکات مهم امنیتی قبل از استفاده واقعی
- `SESSION_SECRET` را حتماً به یک رشته تصادفی طولانی تغییر بده.
- رمز کاربر ادمین پیش‌فرض را فوراً عوض کن.
- برای تولید واقعی، `ZARINPAL_SANDBOX` را `false` کن و مرچنت‌کد واقعی بگذار.
- بک‌آپ‌گیری منظم از فایل `db/glowup.db` را فراموش نکن.


## P2 Premium
- Fixed CSRF on all POST forms with server-rendered hidden tokens.
- Added 3D premium course-card interactions, spotlight and shine.
- Added admin control center and bulk course actions.
- Expanded admin navigation for analytics, bundles, flash sales and referrals.

## P3 Premium Admin Pro
- CMS صفحه اصلی: sections, testimonials, FAQ
- Media Library با upload/delete
- Course Builder با drag & drop برای مرتب‌سازی جلسات
- نقش‌های Admin / Editor / Support
- Admin Pro role chip و navigation
- Health endpoint برای مانیتورینگ پنل
- Dynamic homepage content from CMS

برای اجرای نسخه جدید:
```bash
npm install
npm run seed
npm start
```

## P4 Ultimate
- Live Admin Monitor (auto refresh)
- Homepage campaign banners with scheduling
- Editable site navigation with drag/drop ordering
- Homepage CMS section ordering
- Media URL copy action
- Safer Super Admin role management
- Premium animated homepage banner experience

## P10 — Production Ready

P10 adds runtime health checks, safer authentication, upload validation, security headers, graceful shutdown, Render configuration and SQLite backup tooling. See `P10-RELEASE-NOTES.txt`.

### Environment
Copy `.env.example` to `.env` for local development. In production set a long random `SESSION_SECRET`, `COOKIE_SECURE=true`, and `TRUST_PROXY=1` when running behind a trusted HTTPS proxy.

### Health check
`GET /health` returns a small JSON status used by deployment platforms.

### SQLite backup
Run `npm run backup` to create a consistent SQLite backup in `backups/`.
