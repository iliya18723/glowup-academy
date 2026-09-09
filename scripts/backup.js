const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();
const { DB_PATH, BACKUPS_DIR } = require('../config');

const source = DB_PATH;
const backupDir = BACKUPS_DIR;
fs.mkdirSync(backupDir, { recursive: true });
if (!fs.existsSync(source)) {
  console.error('No SQLite database found:', source);
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(backupDir, `glowup-${stamp}.db`);
const db = new Database(source, { readonly: false });
try {
  db.backup(target).then(() => {
    db.close();
    console.log(`Backup created: ${target}`);
  }).catch((err) => {
    try { db.close(); } catch (_) {}
    console.error(err);
    process.exit(1);
  });
} catch (err) {
  try { db.close(); } catch (_) {}
  console.error(err);
  process.exit(1);
}
