// اتصال به درگاه پرداخت زرین‌پال (Zarinpal)
// مستندات: https://docs.zarinpal.com
// برای فعال‌سازی واقعی: مقدار ZARINPAL_MERCHANT_ID را در فایل .env قرار بده
// و ZARINPAL_SANDBOX را در محیط تست روی true بگذار.

const fetch = require('node-fetch');

const MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID || 'YOUR-MERCHANT-ID-HERE';
const SANDBOX = process.env.ZARINPAL_SANDBOX === 'true';
const CURRENCY = String(process.env.ZARINPAL_CURRENCY || 'IRT').toUpperCase();
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.ZARINPAL_TIMEOUT_MS) || 15000);

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (_) {
      return { ok: false, error: { message: 'پاسخ نامعتبر از درگاه پرداخت', status: res.status } };
    }
    if (!res.ok) return { ok: false, error: data?.errors || data || { status: res.status } };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: { message: err?.name === 'AbortError' ? 'درگاه پرداخت پاسخ نداد.' : 'ارتباط با درگاه پرداخت برقرار نشد.' } };
  } finally { clearTimeout(timer); }
}
function gatewayAmount(toman) {
  const value = Math.max(0, Math.round(Number(toman) || 0));
  return CURRENCY === 'IRR' ? value : value * 10;
}

const BASE = SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/v4/payment'
  : 'https://api.zarinpal.com/pg/v4/payment';

const STARTPAY = SANDBOX
  ? 'https://sandbox.zarinpal.com/pg/StartPay/'
  : 'https://www.zarinpal.com/pg/StartPay/';

// مرحله ۱: درخواست پرداخت و گرفتن Authority
async function requestPayment({ amount, description, callbackUrl, mobile, email }) {
  const result = await fetchJson(`${BASE}/request.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchant_id: MERCHANT_ID, amount: gatewayAmount(amount), description, callback_url: callbackUrl, metadata: { mobile, email } })
  });
  if (!result.ok) return result;
  const data = result.data;
  if (data?.data?.code === 100 && data.data.authority) {
    return { ok: true, authority: data.data.authority, payUrl: STARTPAY + data.data.authority };
  }
  return { ok: false, error: data?.errors || data };
}

// مرحله ۲: تایید پرداخت پس از بازگشت کاربر از درگاه
async function verifyPayment({ amount, authority }) {
  const result = await fetchJson(`${BASE}/verify.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchant_id: MERCHANT_ID, amount: gatewayAmount(amount), authority })
  });
  if (!result.ok) return result;
  const data = result.data;
  if ((data?.data?.code === 100 || data?.data?.code === 101) && data.data.ref_id) {
    return { ok: true, refId: data.data.ref_id };
  }
  return { ok: false, error: data?.errors || data };
}

module.exports = { requestPayment, verifyPayment };
