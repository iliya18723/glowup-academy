const path = require('path');
const fs = require('fs');

// DATA_DIR is the single source of truth for mutable production data.
// On Render set it to the mounted persistent disk (for example /var/data).
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'db'));
const DB_DIR = DATA_DIR;
const DB_PATH = path.join(DATA_DIR, 'glowup.db');
const SESSION_DB_PATH = path.join(DATA_DIR, 'sessions.db');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

for (const dir of [DATA_DIR, UPLOADS_DIR, VIDEOS_DIR, BACKUPS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { DATA_DIR, DB_DIR, DB_PATH, SESSION_DB_PATH, UPLOADS_DIR, VIDEOS_DIR, BACKUPS_DIR };
