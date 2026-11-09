const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const meals = ['Breakfast', 'Lunch', 'Dinner'];
const serviceTimes = ['7:30 – 9:00 AM', '12:30 – 2:30 PM', '7:30 – 9:00 PM'];
const sampleMenu = {
  Monday: ['Poha + Matar Curry + Jalebi', 'Rice/Roti + Dalma + Chole + Onion Salad', 'Rice/Roti + Paneer Masala'],
  Tuesday: ['Idli, Sambar, Chutney', 'Rice/Roti + Dal + Rajma + Dahi boondi + Fryums + Sambar', 'Rice/Roti + Alu ful kobi kasa + Egg Curry'],
  Wednesday: ['Veg Sandwich + Boiled egg / Banana', 'Rice/Roti + Dal + chicken 3pcs curry/Paneer Curry + Salad', 'Rice/Roti + Egg Tadka + Chilli Soybean + Gulab Jamun'],
  Thursday: ['Upma + Matar Curry + Tea/Coffee', 'Rice/Roti + Moong Dal + Aloo Mushroom + Aloo Bharta + Fryums', 'Chole bhature + curd + achar'],
  Friday: ['Uttapam/Masala Chakuli + Sambar + Chutney', 'Rice/Roti + Arhar Dal + Fish Curry / Palak Paneer + Salad', 'Rice/Roti + Paneer + Chicken Kasa (3pcs)'],
  Saturday: ['Khakra/Kakera + Aloo Chop + Matar Curry', 'Rice/Roti + Egg Curry + Navratna Korma + Papad', 'Rice/Roti + Chilli Kobi'],
  Sunday: ['Vada + Matar Curry', 'Chicken/Veg Biryani (Veg) + Raita + Gulab Jamun', 'Rice/Roti + Chicken Kasa (3pcs) / Paneer Hyderabadi']
};

function createDatabase(databasePath = path.join(__dirname, '..', 'data', 'messmate.sqlite')) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      email TEXT COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY,
      day TEXT NOT NULL,
      meal TEXT NOT NULL,
      service_time TEXT NOT NULL,
      dish TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY,
      student_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some(column => column.name === 'email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE');
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_student_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL");
  return db;
}

function passwordDigest(password) {
  return `mm$${crypto.createHash('sha256').update(password, 'utf8').digest('hex')}`;
}

async function hashPassword(password) {
  return `prehash$${await bcrypt.hash(passwordDigest(password), 12)}`;
}

async function verifyPassword(password, storedHash) {
  if (storedHash.startsWith('prehash$')) {
    return bcrypt.compare(passwordDigest(password), storedHash.slice('prehash$'.length));
  }
  return bcrypt.compare(password, storedHash);
}

function seedDefaultMenu(db) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM menu_items').get().count;
  if (count) return;

  const insert = db.prepare(
    'INSERT INTO menu_items (day, meal, service_time, dish, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  const seed = db.transaction(() => {
    weekDays.forEach((day, dayIndex) => {
      meals.forEach((meal, mealIndex) => {
        insert.run(day, meal, serviceTimes[mealIndex], sampleMenu[day][mealIndex], dayIndex * 3 + mealIndex);
      });
    });
  });
  seed();
}

async function ensureBootstrapAdmin(db, username, password) {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) return;

  if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Set ADMIN_USERNAME to a 3–32 character username using letters, numbers, dots, underscores or hyphens.');
  }
  if (!password || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Set ADMIN_PASSWORD to a unique password between 12 and 72 UTF-8 bytes.');
  }

  const passwordHash = await hashPassword(password);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, passwordHash);
}

module.exports = { createDatabase, ensureBootstrapAdmin, hashPassword, seedDefaultMenu, verifyPassword };
