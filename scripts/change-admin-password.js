const bcrypt = require('bcryptjs');
const db = require('../db');

const phone = String(process.env.ADMIN_PHONE || '').trim();
const password = String(process.env.ADMIN_PASSWORD || '');
if (!/^09\d{9}$/.test(phone)) throw new Error('ADMIN_PHONE must be a valid Iranian mobile number (09xxxxxxxxx).');
if (password.length < 12 || password.length > 200) throw new Error('ADMIN_PASSWORD must be 12 to 200 characters.');

const admin = db.prepare("SELECT id FROM users WHERE phone=? AND role='admin'").get(phone);
if (!admin) throw new Error('Admin account not found.');
const hash = bcrypt.hashSync(password, 12);
db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, admin.id);
console.log('✅ Admin password updated successfully.');
try { db.close(); } catch (_) {}
