const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const test = require('node:test');
const { createDatabase, seedDefaultMenu } = require('../db');
const { createApp } = require('../server');

test('database initialization adds email support without removing existing users', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'messmate-migration-test-'));
  const databasePath = path.join(directory, 'messmate.sqlite');
  const oldDatabase = new Database(databasePath);
  oldDatabase.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO users (username, password_hash, role) VALUES ('B123456', 'legacy-hash', 'student');
  `);
  oldDatabase.close();

  const migratedDatabase = createDatabase(databasePath);
  t.after(() => {
    migratedDatabase.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const user = migratedDatabase.prepare('SELECT username, email FROM users WHERE username = ?').get('B123456');
  assert.deepEqual(user, { username: 'B123456', email: null });
});

test('authenticated roles can use persistent menu, feedback, uploads, and account management', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'messmate-test-'));
  const uploadDir = path.join(directory, 'uploads');
  const db = createDatabase(path.join(directory, 'messmate.sqlite'));
  seedDefaultMenu(db);
  const adminHash = await bcrypt.hash('AdminTestPassword!2026', 4);
  const studentHash = await bcrypt.hash('StudentTestPassword!2026', 4);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(adminHash);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('B423012', ?, 'student')").run(studentHash);
  const server = createApp({
    db,
    sessionSecret: 'test-only-session-secret-with-more-than-32-characters',
    uploadDir
  }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function request(url, { method = 'GET', body, cookie, csrf } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body instanceof FormData) {
      headers.Accept = 'application/json';
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${baseUrl}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
    });
    const payload = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : null;
    return { response, payload };
  }

  const homepage = await request('/');
  assert.equal(homepage.response.status, 200);
  assert.match(homepage.response.headers.get('content-type'), /text\/html/);
  const frontendScript = await request('/script.js');
  assert.equal(frontendScript.response.status, 200);
  assert.match(frontendScript.response.headers.get('content-type'), /javascript/);

  const publicMenu = await request('/api/menu');
  assert.equal(publicMenu.response.status, 200);
  assert.equal(publicMenu.payload.schedule.length, 21);

  const studentLogin = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'b423012', password: 'StudentTestPassword!2026' }
  });
  assert.equal(studentLogin.response.status, 200);
  const studentCookie = studentLogin.response.headers.get('set-cookie').split(';')[0];
  const studentCsrf = studentLogin.payload.csrfToken;

  const forbidden = await request('/api/admin/students', { cookie: studentCookie });
  assert.equal(forbidden.response.status, 403);

  const feedback = await request('/api/feedback', {
    method: 'POST',
    cookie: studentCookie,
    csrf: studentCsrf,
    body: { rating: 5, comment: 'Great lunch today.' }
  });
  assert.equal(feedback.response.status, 201);
  assert.equal(feedback.payload.feedback.studentId, 'B423012');

  const adminLogin = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'admin', password: 'AdminTestPassword!2026' }
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.get('set-cookie').split(';')[0];
  const adminCsrf = adminLogin.payload.csrfToken;

  const noCsrf = await request('/api/menu', {
    method: 'PUT',
    cookie: adminCookie,
    body: { schedule: [] }
  });
  assert.equal(noCsrf.response.status, 403);

  const updatedMenu = await request('/api/menu', {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { schedule: [{ day: 'Monday', meal: 'Breakfast', time: '8:00 AM', dish: 'Oats & fruit' }] }
  });
  assert.equal(updatedMenu.response.status, 200);
  assert.equal(updatedMenu.payload.schedule[0].dish, 'Oats & fruit');
  assert.equal((await request('/api/menu')).payload.schedule.length, 1);

  const adminFeedback = await request('/api/feedback', { cookie: adminCookie });
  assert.equal(adminFeedback.payload.feedback.length, 1);

  const createdStudent = await request('/api/admin/students', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { studentId: 'A423013', password: 'NewStudentPassword!2026' }
  });
  assert.equal(createdStudent.response.status, 201);

  const template = await request('/api/admin/students/template.xlsx', { cookie: adminCookie });
  assert.equal(template.response.status, 200);
  assert.match(template.response.headers.get('content-type'), /spreadsheetml\.sheet/);

  async function studentWorkbook(rows) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Students');
    worksheet.addRow(['Student ID', 'Student Email ID']);
    rows.forEach(row => worksheet.addRow(row));
    return workbook.xlsx.writeBuffer();
  }

  const duplicateWorkbook = new FormData();
  duplicateWorkbook.append('studentSpreadsheet', new Blob([
    await studentWorkbook([
      ['B111111', 'first.student@example.edu'],
      ['A111111', 'first.student@example.edu']
    ])
  ], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'students.xlsx');
  const duplicateImport = await request('/api/admin/students/import', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: duplicateWorkbook
  });
  assert.equal(duplicateImport.response.status, 400);
  assert.match(duplicateImport.payload.details.join(' '), /duplicated in this spreadsheet/);

  const oversizedWorkbook = new FormData();
  oversizedWorkbook.append('studentSpreadsheet', new Blob([Buffer.alloc(4 * 1024 * 1024 + 1)]), 'large.xlsx');
  const rejectedWorkbook = await request('/api/admin/students/import', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: oversizedWorkbook
  });
  assert.equal(rejectedWorkbook.response.status, 400);
  assert.match(rejectedWorkbook.payload.error, /Excel workbook must be 4 MB or smaller/);

  const validWorkbook = new FormData();
  const longEmail = `${'x'.repeat(64)}@example.edu`;
  validWorkbook.append('studentSpreadsheet', new Blob([
    await studentWorkbook([
      ['B111111', 'first.student@example.edu'],
      ['A111111', longEmail]
    ])
  ], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'students.xlsx');
  const imported = await request('/api/admin/students/import', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: validWorkbook
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.payload.created, 2);

  const importedLogin = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'B111111', password: 'first.student@example.edu' }
  });
  assert.equal(importedLogin.response.status, 200);
  const importedCookie = importedLogin.response.headers.get('set-cookie').split(';')[0];
  const passwordChanged = await request('/api/password', {
    method: 'PUT',
    cookie: importedCookie,
    csrf: importedLogin.payload.csrfToken,
    body: { currentPassword: 'first.student@example.edu', newPassword: 'ChangedStudentPassword!2026' }
  });
  assert.equal(passwordChanged.response.status, 200);

  const oldImportedPassword = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'B111111', password: 'first.student@example.edu' }
  });
  assert.equal(oldImportedPassword.response.status, 401);
  const changedImportedPassword = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'B111111', password: 'ChangedStudentPassword!2026' }
  });
  assert.equal(changedImportedPassword.response.status, 200);
  const longEmailLogin = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'A111111', password: longEmail }
  });
  assert.equal(longEmailLogin.response.status, 200);

  const resetPassword = await request(`/api/admin/students/${createdStudent.payload.student.id}/password`, {
    method: 'PUT',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { password: 'ResetStudentPassword!2026' }
  });
  assert.equal(resetPassword.response.status, 200);
  const oldPasswordLogin = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'A423013', password: 'NewStudentPassword!2026' }
  });
  assert.equal(oldPasswordLogin.response.status, 401);

  const imageForm = new FormData();
  imageForm.append('menuImage', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0x00])], { type: 'image/jpeg' }), 'menu.jpg');
  const image = await request('/api/menu/image', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: imageForm
  });
  assert.equal(image.response.status, 201);
  const servedImage = await request(image.payload.menuImageUrl);
  assert.equal(servedImage.response.status, 200);

  const oversizedImage = new FormData();
  oversizedImage.append('menuImage', new Blob([Buffer.alloc(4 * 1024 * 1024 + 1)]), 'large.jpg');
  const rejectedImage = await request('/api/menu/image', {
    method: 'POST',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: oversizedImage
  });
  assert.equal(rejectedImage.response.status, 400);
  assert.match(rejectedImage.payload.error, /menu screenshot must be 4 MB or smaller/);

  const deactivated = await request(`/api/admin/students/${createdStudent.payload.student.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { active: false }
  });
  assert.equal(deactivated.response.status, 200);
  const disabledLogin = await request('/api/login', {
    method: 'POST',
    body: { studentId: 'A423013', password: 'ResetStudentPassword!2026' }
  });
  assert.equal(disabledLogin.response.status, 401);

  const removedImage = await request('/api/menu/image', {
    method: 'DELETE',
    cookie: adminCookie,
    csrf: adminCsrf
  });
  assert.equal(removedImage.response.status, 200);
  assert.equal((await request('/api/menu')).payload.menuImageUrl, null);
});

test('menu images use persistent Blob URLs when Blob storage is configured', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'messmate-blob-test-'));
  const db = createDatabase(path.join(directory, 'messmate.sqlite'));
  seedDefaultMenu(db);
  const adminHash = await bcrypt.hash('AdminTestPassword!2026', 4);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(adminHash);
  const deletedUrls = [];
  const blobStorage = {
    async put(_pathname, _buffer, options) {
      assert.equal(options.access, 'public');
      return { url: 'https://store.public.blob.vercel-storage.com/menu.jpg' };
    },
    async del(url) {
      deletedUrls.push(url);
    }
  };
  const server = createApp({
    db,
    sessionSecret: 'test-only-session-secret-with-more-than-32-characters',
    blobStorage
  }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: 'admin', password: 'AdminTestPassword!2026' })
  });
  const login = await loginResponse.json();
  const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
  const formData = new FormData();
  formData.append('menuImage', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0x00])], { type: 'image/jpeg' }), 'menu.jpg');
  const uploadResponse = await fetch(`${baseUrl}/api/menu/image`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Token': login.csrfToken },
    body: formData
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.menuImageUrl, 'https://store.public.blob.vercel-storage.com/menu.jpg');

  const menuResponse = await fetch(`${baseUrl}/api/menu`);
  assert.equal((await menuResponse.json()).menuImageUrl, uploaded.menuImageUrl);

  const deleteResponse = await fetch(`${baseUrl}/api/menu/image`, {
    method: 'DELETE',
    headers: { Cookie: cookie, 'X-CSRF-Token': login.csrfToken }
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deletedUrls, [uploaded.menuImageUrl]);
});
