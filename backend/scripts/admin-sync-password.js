require('dotenv').config();

const path = require('node:path');
const { createDatabase, hashPassword } = require('../db');

async function syncAdminPassword() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This password-sync command is for local development only.');
  }

  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD in .env first.');
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters and no more than 72 UTF-8 bytes.');
  }

  const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, '..', '..', 'data', 'messmate.sqlite'));
  const db = createDatabase(databasePath);
  try {
    const admin = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND role = 'admin'").get(username);
    if (!admin) throw new Error(`No admin account named "${username}" exists in this database.`);

    const passwordHash = await hashPassword(password);
    const updateAdmin = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, admin.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id);
    });
    updateAdmin();
    console.log('The local admin password now matches ADMIN_PASSWORD. Existing admin sessions were signed out.');
  } finally {
    db.close();
  }
}

syncAdminPassword().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
