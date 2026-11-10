require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { createDatabase, ensureBootstrapAdmin, hashPassword, seedDefaultMenu, verifyPassword } = require('./db');

const SESSION_COOKIE = 'messmate_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const studentIdPattern = /^[AB]\d{6}$/;
const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const staticFiles = [
  '/',
  '/index.html',
  '/script.js',
  '/styles.css',
  '/auth.css',
  '/admin.css',
  '/menu-upload.css',
  '/menu-ocr.js',
  '/readability.css',
  '/1000111778.jpg'
];

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signToken(token, secret) {
  return crypto.createHmac('sha256', secret).update(token).digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  for (const entry of cookies.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) return entry.slice(separator + 1).trim();
  }
  return '';
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 12 && Buffer.byteLength(password, 'utf8') <= 72;
}

function spreadsheetCellText(cell) {
  const value = cell.value;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (value && typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map(part => part.text).join('').trim();
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text.trim();
  return '';
}

function normalizedHeader(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function validateStudentImport(worksheet, db) {
  const headerRow = worksheet.getRow(1);
  const headers = new Map();
  headerRow.eachCell({ includeEmpty: false }, (cell, column) => {
    const header = normalizedHeader(spreadsheetCellText(cell));
    if (header) headers.set(header, column);
  });
  const studentIdColumn = headers.get('studentid');
  const emailColumn = headers.get('studentemailid') || headers.get('studentemail') || headers.get('emailid') || headers.get('email');
  if (!studentIdColumn || !emailColumn || studentIdColumn === emailColumn) {
    return { rows: [], errors: ['Row 1: Include separate "Student ID" and "Student Email ID" column headers.'] };
  }

  const rows = [];
  const errors = [];
  const seenStudentIds = new Set();
  const seenEmails = new Set();
  const existingUsers = await db.prepare('SELECT username, email FROM users').all();
  const existingStudentIds = new Set(existingUsers.map(user => user.username.toLowerCase()));
  const existingEmails = new Set(existingUsers.filter(user => user.email).map(user => user.email.toLowerCase()));
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const studentId = spreadsheetCellText(row.getCell(studentIdColumn)).toUpperCase();
    const email = spreadsheetCellText(row.getCell(emailColumn)).toLowerCase();
    if (!studentId && !email) continue;

    const rowErrors = [];
    if (!studentIdPattern.test(studentId)) rowErrors.push('student ID must be A or B followed by 6 digits');
    if (Buffer.byteLength(email, 'utf8') > 254 || !emailPattern.test(email)) rowErrors.push('enter a valid student email address');
    if (studentId && seenStudentIds.has(studentId)) rowErrors.push('student ID is duplicated in this spreadsheet');
    if (email && seenEmails.has(email)) rowErrors.push('email address is duplicated in this spreadsheet');
    if (studentIdPattern.test(studentId) && existingStudentIds.has(studentId.toLowerCase())) rowErrors.push('student ID already has an account');
    if (emailPattern.test(email) && existingEmails.has(email.toLowerCase())) rowErrors.push('email address is already assigned to an account');

    if (studentId) seenStudentIds.add(studentId);
    if (email) seenEmails.add(email);
    if (rowErrors.length) {
      errors.push(`Row ${rowNumber}: ${rowErrors.join('; ')}.`);
    } else {
      rows.push({ studentId, email });
    }
  }

  if (!rows.length && !errors.length) errors.push('The worksheet has no student rows to import.');
  if (!errors.length && rows.length > 5000) errors.push('Import at most 5,000 student rows per spreadsheet.');
  return { rows, errors };
}

function imageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '';
}

async function insertReturningId(db, sql, ...params) {
  if (db.isPostgres) {
    const result = await db.prepare(`${sql} RETURNING id`).run(...params);
    return result.lastInsertRowid;
  }
  return db.prepare(sql).run(...params).lastInsertRowid;
}

function createApp({ db, sessionSecret, uploadDir, secureCookies = false, blobStorage, serveStatic = true, trustProxy = process.env.TRUST_PROXY === '1' }) {
  if (!db) throw new Error('A database connection is required.');
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  if (!blobStorage && !uploadDir) throw new Error('An uploads directory is required.');
  if (!blobStorage) fs.mkdirSync(uploadDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  app.use((req, _res, next) => {
    if (req.url && !req.url.startsWith('/api') && !req.url.startsWith('/uploads') && req.url !== '/healthz') {
      const isStaticRoute = serveStatic && staticFiles.includes(req.path);
      if (!isStaticRoute) {
        req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
      }
    }
    next();
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.public.blob.vercel-storage.com'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        workerSrc: ["'self'", 'blob:', 'https://cdn.jsdelivr.net'],
        connectSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://tessdata.projectnaptha.com']
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(async (req, _res, next) => {
    const signedCookie = getCookie(req, SESSION_COOKIE);
    const [token, signature, extra] = signedCookie.split('.');
    if (!token || !signature || extra !== undefined || !safeEqual(signature, signToken(token, sessionSecret))) {
      next();
      return;
    }

    const tokenHash = hashToken(token);
    const session = await db.prepare(`
      SELECT sessions.token_hash, sessions.csrf_token, sessions.expires_at,
             users.id, users.username, users.role, users.active
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(tokenHash);
    if (!session || session.expires_at <= Date.now() || !session.active) {
      if (session) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      next();
      return;
    }

    req.auth = {
      tokenHash,
      csrfToken: session.csrf_token,
      user: { id: session.id, username: session.username, role: session.role }
    };
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' }
  });

  function requireAuth(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'Please sign in to continue.' });
    next();
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (!req.auth) return res.status(401).json({ error: 'Please sign in to continue.' });
      if (req.auth.user.role !== role) return res.status(403).json({ error: 'You do not have permission to do that.' });
      next();
    };
  }

  function requireCsrf(req, res, next) {
    const supplied = req.get('x-csrf-token') || '';
    if (!req.auth || !safeEqual(supplied, req.auth.csrfToken)) {
      return res.status(403).json({ error: 'Your session has expired. Refresh the page and try again.' });
    }
    next();
  }

  function setSessionCookie(res, token) {
    const signature = signToken(token, sessionSecret);
    const secure = secureCookies ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION_MS / 1000}${secure}`);
  }

  function clearSessionCookie(res) {
    const secure = secureCookies ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  }

  async function createSession(userId, res) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    await db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, csrfToken, expiresAt);
    setSessionCookie(res, token);
    return csrfToken;
  }

  app.get(['/healthz', '/api/healthz'], (_req, res) => res.json({ status: 'ok' }));

  app.post('/api/login', loginLimiter, async (req, res) => {
    const username = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password || username.length > 32 || password.length > 256) {
      return res.status(400).json({ error: 'Enter your username and password.' });
    }

    const user = await db.prepare('SELECT id, username, password_hash, role, active FROM users WHERE LOWER(username) = LOWER(?)').get(username);
    const passwordMatches = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !user.active || !passwordMatches) {
      return res.status(401).json({ error: 'That username or student ID and password combination does not match. Please try again.' });
    }

    if (req.auth) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.auth.tokenHash);
    const csrfToken = await createSession(user.id, res);
    res.json({ user: { id: user.id, username: user.username, role: user.role }, csrfToken });
  });

  app.get('/api/session', (req, res) => {
    res.json({
      user: req.auth?.user || null,
      csrfToken: req.auth?.csrfToken || null
    });
  });

  app.post('/api/logout', requireAuth, requireCsrf, async (req, res) => {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.auth.tokenHash);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.put('/api/password', requireAuth, requireCsrf, async (req, res) => {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: 'Use a password of at least 12 characters and no more than 72 UTF-8 bytes.' });
    }
    const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.auth.user.id);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'Your current password is incorrect.' });
    }
    const passwordHash = await hashPassword(newPassword);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.auth.user.id);
    await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.auth.user.id, req.auth.tokenHash);
    res.json({ ok: true });
  });

  app.get('/api/menu', async (_req, res) => {
    const schedule = await db.prepare('SELECT id, day, meal, service_time AS time, dish FROM menu_items ORDER BY sort_order, id').all();
    const menuImage = (await db.prepare("SELECT value FROM settings WHERE key = 'menu_image'").get())?.value || null;
    res.json({ schedule, menuImageUrl: menuImage ? (menuImage.startsWith('https://') ? menuImage : `/uploads/${menuImage}`) : null });
  });

  app.put('/api/menu', requireRole('admin'), requireCsrf, async (req, res) => {
    const schedule = req.body?.schedule;
    if (!Array.isArray(schedule) || schedule.length > 100) {
      return res.status(400).json({ error: 'The menu must contain between 0 and 100 meals.' });
    }
    for (const meal of schedule) {
      if (!meal || !weekDays.includes(meal.day) ||
          typeof meal.meal !== 'string' || !meal.meal.trim() || meal.meal.length > 60 ||
          typeof meal.time !== 'string' || !meal.time.trim() || meal.time.length > 60 ||
          typeof meal.dish !== 'string' || !meal.dish.trim() || meal.dish.length > 500) {
        return res.status(400).json({ error: 'Each meal needs a valid day, meal name, service time and menu description.' });
      }
    }
    if (db.isPostgres) {
      await db.transaction(async tx => {
        await tx.prepare('DELETE FROM menu_items').run();
        const insert = tx.prepare('INSERT INTO menu_items (day, meal, service_time, dish, sort_order) VALUES (?, ?, ?, ?, ?)');
        for (const [index, meal] of schedule.entries()) {
          await insert.run(meal.day, meal.meal.trim(), meal.time.trim(), meal.dish.trim(), index);
        }
      });
    } else {
      db.transaction(() => {
        db.prepare('DELETE FROM menu_items').run();
        const insert = db.prepare('INSERT INTO menu_items (day, meal, service_time, dish, sort_order) VALUES (?, ?, ?, ?, ?)');
        schedule.forEach((meal, index) => insert.run(meal.day, meal.meal.trim(), meal.time.trim(), meal.dish.trim(), index));
      })();
    }
    const savedSchedule = await db.prepare('SELECT id, day, meal, service_time AS time, dish FROM menu_items ORDER BY sort_order, id').all();
    res.json({ schedule: savedSchedule });
  });

  const menuUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
  }).single('menuImage');

  app.post('/api/menu/image', requireRole('admin'), requireCsrf, (req, res, next) => {
    menuUpload(req, res, error => {
      if (error) return next(error);
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a JPG, PNG or WebP menu screenshot.' });
    const extension = imageExtension(req.file.buffer);
    if (!extension) return res.status(400).json({ error: 'The uploaded file is not a valid JPG, PNG or WebP image.' });

    const filename = `${crypto.randomUUID()}${extension}`;
    const filepath = uploadDir ? path.join(uploadDir, filename) : null;
    const storedImage = blobStorage
      ? await blobStorage.put(`menu/${filename}`, req.file.buffer, { access: 'public', addRandomSuffix: false })
      : null;
    if (filepath) await fs.promises.writeFile(filepath, req.file.buffer, { flag: 'wx', mode: 0o640 });
    const previous = (await db.prepare("SELECT value FROM settings WHERE key = 'menu_image'").get())?.value;
    const imageValue = storedImage?.url || filename;
    try {
      await db.prepare("INSERT INTO settings (key, value) VALUES ('menu_image', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(imageValue);
    } catch (error) {
      if (storedImage) await blobStorage.del(storedImage.url);
      if (filepath) await fs.promises.unlink(filepath);
      throw error;
    }
    if (previous && previous !== imageValue) {
      if (previous.startsWith('https://')) await blobStorage?.del(previous);
      else if (uploadDir) await fs.promises.unlink(path.join(uploadDir, previous));
    }
    res.status(201).json({ menuImageUrl: storedImage?.url || `/uploads/${filename}` });
  });

  app.delete('/api/menu/image', requireRole('admin'), requireCsrf, async (_req, res) => {
    const previous = (await db.prepare("SELECT value FROM settings WHERE key = 'menu_image'").get())?.value;
    if (previous?.startsWith('https://')) {
      try {
        await blobStorage?.del(previous);
      } catch (_delError) {}
    } else if (previous && uploadDir) {
      try {
        await fs.promises.unlink(path.join(uploadDir, previous));
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
    if (db.isPostgres) {
      await db.transaction(async tx => {
        await tx.prepare("DELETE FROM settings WHERE key = 'menu_image'").run();
        await tx.prepare('DELETE FROM menu_items').run();
        await tx.prepare("INSERT INTO settings (key, value) VALUES ('default_menu_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
      });
    } else {
      db.transaction(() => {
        db.prepare("DELETE FROM settings WHERE key = 'menu_image'").run();
        db.prepare('DELETE FROM menu_items').run();
        db.prepare("INSERT INTO settings (key, value) VALUES ('default_menu_seeded', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
      })();
    }
    res.json({ ok: true });
  });

  app.get('/uploads/:filename', async (req, res, next) => {
    if (!/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(req.params.filename)) return res.sendStatus(404);
    const current = (await db.prepare("SELECT value FROM settings WHERE key = 'menu_image'").get())?.value;
    if (current !== req.params.filename) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(uploadDir, req.params.filename), error => {
      if (error && !res.headersSent) next(error);
    });
  });

  app.get('/api/feedback', requireRole('admin'), async (_req, res) => {
    const feedback = await db.prepare('SELECT id, student_id AS studentId, rating, comment, created_at AS createdAt FROM feedback ORDER BY created_at DESC, id DESC').all();
    res.json({ feedback });
  });

  app.post('/api/feedback', requireRole('student'), requireCsrf, async (req, res) => {
    const rating = Number.isInteger(req.body?.rating) ? req.body.rating : 0;
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
    if (rating < 0 || rating > 5 || comment.length > 1000 || (!rating && !comment)) {
      return res.status(400).json({ error: 'Add a comment or choose a star rating before sending.' });
    }
    const insertedId = await insertReturningId(db, 'INSERT INTO feedback (student_id, rating, comment) VALUES (?, ?, ?)',
      req.auth.user.username, rating, comment);
    const entry = await db.prepare('SELECT id, student_id AS studentId, rating, comment, created_at AS createdAt FROM feedback WHERE id = ?')
      .get(insertedId);
    res.status(201).json({ feedback: entry });
  });

  app.delete('/api/feedback/:id', requireRole('admin'), requireCsrf, async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid feedback entry.' });
    const result = await db.prepare('DELETE FROM feedback WHERE id = ?').run(Number(req.params.id));
    if (!result.changes) return res.status(404).json({ error: 'That feedback entry no longer exists.' });
    res.json({ ok: true });
  });

  app.get('/api/admin/students', requireRole('admin'), async (_req, res) => {
    const students = await db.prepare("SELECT id, username, email, active, created_at AS createdAt FROM users WHERE role = 'student' ORDER BY username").all();
    res.json({ students: students.map(student => ({ ...student, active: Boolean(student.active) })) });
  });

  app.post('/api/admin/students', requireRole('admin'), requireCsrf, async (req, res) => {
    const studentId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim().toUpperCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!studentIdPattern.test(studentId)) return res.status(400).json({ error: 'Enter A or B followed by exactly 6 digits.' });
    if (!isValidPassword(password)) return res.status(400).json({ error: 'Use a password of at least 12 characters and no more than 72 UTF-8 bytes.' });
    const passwordHash = await hashPassword(password);
    try {
      const studentIdNumber = await insertReturningId(db, "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'student')", studentId, passwordHash);
      res.status(201).json({ student: { id: studentIdNumber, username: studentId, active: true } });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === '23505') return res.status(409).json({ error: 'An account with that student ID already exists.' });
      throw error;
    }
  });

  app.patch('/api/admin/students/:id', requireRole('admin'), requireCsrf, async (req, res) => {
    const active = req.body?.active;
    if (!/^\d+$/.test(req.params.id) || typeof active !== 'boolean') {
      return res.status(400).json({ error: 'Choose whether to activate or deactivate this student account.' });
    }
    let updated;
    if (db.isPostgres) {
      updated = await db.transaction(async tx => {
        const result = await tx.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'student'").run(Number(active), Number(req.params.id));
        if (!result.changes) return false;
        if (!active) await tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(req.params.id));
        return true;
      });
    } else {
      updated = db.transaction(() => {
        const result = db.prepare("UPDATE users SET active = ? WHERE id = ? AND role = 'student'").run(Number(active), Number(req.params.id));
        if (!result.changes) return false;
        if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(req.params.id));
        return true;
      })();
    }
    if (!updated) return res.status(404).json({ error: 'That student account no longer exists.' });
    res.json({ ok: true });
  });

  app.put('/api/admin/students/:id/password', requireRole('admin'), requireCsrf, async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid student account.' });
    if (!isValidPassword(password)) return res.status(400).json({ error: 'Use a password of at least 12 characters and no more than 72 UTF-8 bytes.' });
    const passwordHash = await hashPassword(password);
    let reset;
    if (db.isPostgres) {
      reset = await db.transaction(async tx => {
        const student = await tx.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
        if (!student) return false;
        await tx.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, student.id);
        await tx.prepare('DELETE FROM sessions WHERE user_id = ?').run(student.id);
        return true;
      });
    } else {
      reset = db.transaction(() => {
        const student = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
        if (!student) return false;
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, student.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(student.id);
        return true;
      })();
    }
    if (!reset) return res.status(404).json({ error: 'That student account no longer exists.' });
    res.json({ ok: true });
  });

  const spreadsheetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, callback) => {
      if (path.extname(file.originalname).toLowerCase() !== '.xlsx') {
        return callback(new Error('Choose an .xlsx Excel workbook.'));
      }
      callback(null, true);
    }
  }).single('studentSpreadsheet');

  app.get('/api/admin/students/template.xlsx', requireRole('admin'), async (_req, res) => {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Messmate';
    const worksheet = workbook.addWorksheet('Students');
    worksheet.addRow(['Student ID', 'Student Email ID']);
    worksheet.getRow(1).font = { bold: true };
    worksheet.columns = [{ width: 20 }, { width: 36 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="messmate-students-template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  });

  app.post('/api/admin/students/import', requireRole('admin'), requireCsrf, (req, res, next) => {
    spreadsheetUpload(req, res, error => {
      if (error) return next(error);
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an .xlsx student spreadsheet to import.' });

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(req.file.buffer);
    } catch (error) {
      if (error instanceof Error) return res.status(400).json({ error: 'Could not read the Excel workbook. Check that the file is a valid, unencrypted .xlsx spreadsheet.' });
      throw error;
    }
    const worksheet = workbook.worksheets[0];
    if (!worksheet) return res.status(400).json({ error: 'The spreadsheet does not contain a worksheet.' });
    if (worksheet.rowCount > 5001) {
      return res.status(400).json({ error: 'Import at most 5,000 student rows per spreadsheet.' });
    }

    const validation = await validateStudentImport(worksheet, db);
    if (validation.errors.length) {
      return res.status(400).json({
        error: 'No accounts were imported. Fix the spreadsheet issues and try again.',
        details: validation.errors.slice(0, 100),
        issueCount: validation.errors.length
      });
    }

    const studentsWithHashes = [];
    for (let index = 0; index < validation.rows.length; index += 8) {
      const batch = await Promise.all(validation.rows.slice(index, index + 8).map(async student => ({
        ...student,
        passwordHash: await hashPassword(student.email)
      })));
      studentsWithHashes.push(...batch);
    }
    try {
      if (db.isPostgres) {
        await db.transaction(async tx => {
          for (let index = 0; index < studentsWithHashes.length; index += 250) {
            const batch = studentsWithHashes.slice(index, index + 250);
            const values = batch.map(() => "(?, ?, ?, 'student')").join(', ');
            const params = batch.flatMap(student => [student.studentId, student.email, student.passwordHash]);
            await tx.prepare(`INSERT INTO users (username, email, password_hash, role) VALUES ${values}`).run(...params);
          }
        });
      } else {
        db.transaction(() => {
          const insert = db.prepare("INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'student')");
          for (const student of studentsWithHashes) {
            insert.run(student.studentId, student.email, student.passwordHash);
          }
        })();
      }
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === '23505') {
        return res.status(409).json({
          error: 'The student accounts changed while the spreadsheet was being imported. No accounts were imported; refresh the list and retry.',
          details: [],
          issueCount: 0
        });
      }
      throw error;
    }
    res.status(201).json({ created: studentsWithHashes.length });
  });

  if (serveStatic) {
    for (const route of staticFiles) {
      app.get(route, (req, res, next) => {
        const filename = route === '/' ? 'index.html' : route.slice(1);
        res.sendFile(path.join(__dirname, '..', 'frontend', filename), error => {
          if (error && !res.headersSent) next(error);
        });
      });
    }
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'That API endpoint does not exist.' }));
  app.use((req, res) => {
    if (req.accepts('html')) return res.status(404).send('Page not found');
    res.status(404).json({ error: 'Not found.' });
  });
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE'
        ? error.field === 'studentSpreadsheet'
          ? 'The Excel workbook must be 4 MB or smaller.'
          : 'The menu screenshot must be 4 MB or smaller.'
        : error.field === 'studentSpreadsheet'
          ? 'Could not process that Excel workbook.'
          : 'Could not process that menu screenshot.';
      return res.status(400).json({ error: message });
    }
    if (error.message === 'Choose an .xlsx Excel workbook.') {
      return res.status(400).json({ error: error.message });
    }
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error('Request failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'The server could not complete that request. Please try again.' });
  });

  return app;
}

async function startServer() {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('Set SESSION_SECRET to a random value of at least 32 characters before starting the server.');
  }
  const projectRoot = path.join(__dirname, '..');
  const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'messmate.sqlite'));
  const uploadDir = path.resolve(process.env.UPLOADS_PATH || path.join(projectRoot, 'uploads'));
  const db = createDatabase(databasePath);
  seedDefaultMenu(db);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  await ensureBootstrapAdmin(db, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);

  const app = createApp({
    db,
    sessionSecret,
    uploadDir,
    secureCookies: process.env.NODE_ENV === 'production'
  });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
  const server = app.listen(port, () => console.log(`Messmate is listening on http://localhost:${port}`));
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  startServer().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createApp, startServer };
