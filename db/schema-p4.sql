-- P4 Premium Experience / Content Control
CREATE TABLE IF NOT EXISTS homepage_banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eyebrow TEXT,
  title TEXT NOT NULL,
  subtitle TEXT,
  cta_text TEXT,
  cta_url TEXT,
  image TEXT,
  accent TEXT DEFAULT 'gold',
  starts_at DATETIME,
  ends_at DATETIME,
  is_published INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'header',
  is_published INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_banners_active ON homepage_banners(is_published,sort_order);
CREATE INDEX IF NOT EXISTS idx_menu_location ON site_menu_items(location,is_published,sort_order);
