const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');

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

function createPostgresDatabase(connectionString) {
  if (!connectionString) throw new Error('Set DATABASE_URL to your Neon PostgreSQL connection string.');
  const pool = new Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000
  });

  async function initialize() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS menu_items (
        id SERIAL PRIMARY KEY,
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
        id SERIAL PRIMARY KEY,
        student_id TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
        comment TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      );
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users (LOWER(username));
      CREATE UNIQUE INDEX IF NOT EXISTS users_student_email ON users (LOWER(email)) WHERE email IS NOT NULL;
    `);
  }

  function prepare(sql) {
    let parameterIndex = 0;
    const statement = sql.replace(/\?/g, () => `$${++parameterIndex}`);
    const query = async params => pool.query(statement, params);
    return {
      async get(...params) {
        const result = await query(params);
        return result.rows[0];
      },
      async all(...params) {
        const result = await query(params);
        return result.rows;
      },
      async run(...params) {
        const result = await query(params);
        return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
      }
    };
  }

  async function transaction(callback) {
    const client = await pool.connect();
    const tx = {
      prepare(sql) {
        let parameterIndex = 0;
        const statement = sql.replace(/\?/g, () => `$${++parameterIndex}`);
        const query = async params => client.query(statement, params);
        return {
          async get(...params) {
            const result = await query(params);
            return result.rows[0];
          },
          async all(...params) {
            const result = await query(params);
            return result.rows;
          },
          async run(...params) {
            const result = await query(params);
            return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
          }
        };
      }
    };

    try {
      await client.query('BEGIN');
      const result = await callback(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    isPostgres: true,
    initialize,
    prepare,
    transaction,
    close: () => pool.end()
  };
}

function passwordDigest(password) {
  return `mm$${crypto.createHash('sha256').update(password, 'utf8').digest('hex')}`;
}

async function hashPassword(password) {
  return `prehash$${await bcrypt.hash(passwordDigest(password), 12)}`;
}

async function seedDefaultMenu(db) {
  await db.transaction(async tx => {
    await tx.prepare('SELECT pg_advisory_xact_lock(824731)').get();
    const alreadySeeded = await tx.prepare("SELECT value FROM settings WHERE key = 'default_menu_seeded'").get();
    if (alreadySeeded) return;

    const count = await tx.prepare('SELECT COUNT(*) AS count FROM menu_items').get();
    if (Number(count.count)) {
      await tx.prepare("INSERT INTO settings (key, value) VALUES ('default_menu_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
      return;
    }

    const insert = tx.prepare(
      'INSERT INTO menu_items (day, meal, service_time, dish, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    for (const [dayIndex, day] of weekDays.entries()) {
      for (const [mealIndex, meal] of meals.entries()) {
        await insert.run(day, meal, serviceTimes[mealIndex], sampleMenu[day][mealIndex], dayIndex * 3 + mealIndex);
      }
    }
    await tx.prepare("INSERT INTO settings (key, value) VALUES ('default_menu_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  });
}

async function ensureBootstrapAdmin(db, username, password) {
  const existingAdmin = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) return;

  if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Set ADMIN_USERNAME to a 3–32 character username using letters, numbers, dots, underscores or hyphens.');
  }
  if (!password || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Set ADMIN_PASSWORD to a unique password between 12 and 72 UTF-8 bytes.');
  }

  const passwordHash = await hashPassword(password);
  try {
    await db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, passwordHash);
  } catch (error) {
    if (error.code !== '23505') throw error;
    const adminAfterRace = await db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (!adminAfterRace) throw error;
  }
}

module.exports = { createPostgresDatabase, ensureBootstrapAdmin, seedDefaultMenu };
