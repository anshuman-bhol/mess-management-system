const weekDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const maxUploadBytes = 4 * 1024 * 1024;
let menuImage = '';
let feedbackEntries = [];
let menuSchedule = [];
let scheduleDraft = null;
let activeUser = null;
let csrfToken = '';

const backdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalKicker = document.getElementById('modal-kicker');
const modalContent = document.getElementById('modal-content');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');
let toastTimer;
let modalAction = null;
function getErrorMessage(error, fallback) {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message;
    if (typeof error.error === 'string' && error.error.trim()) return error.error;
    if (error.error && typeof error.error === 'object') return getErrorMessage(error.error, fallback);
    if (typeof error.code === 'string' && error.code.trim()) return `${fallback} (${error.code})`;
  }
  return fallback;
}

function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  const isFormData = options.body instanceof FormData;
  if (options.body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  return fetch(path, { ...options, headers, credentials: 'same-origin' }).then(async response => {
    let payload;
    try {
      payload = await response.json();
    } catch (parseError) {
      const error = new Error(`The server returned an invalid response (HTTP ${response.status}).`);
      error.cause = parseError;
      throw error;
    }
    if (!response.ok) {
      const fallback = `The server could not complete that request (HTTP ${response.status}).`;
      const error = new Error(getErrorMessage(payload?.error || payload, fallback));
      error.status = response.status;
      error.details = payload.details || [];
      error.issueCount = payload.issueCount || error.details.length;
      throw error;
    }
    return payload;
  });
}

function setSignedIn(user) {
  activeUser = user;
  document.body.classList.remove('is-admin');
  document.body.classList.remove('is-logged-out');
  document.getElementById('login-error').textContent = '';
  document.querySelector('.welcome-row h1').innerHTML = `Good morning, ${escapeHtml(user.username)} <span class="wave">✳</span>`;
  document.getElementById('profile-student-id').textContent = user.username;
  document.querySelector('.profile-copy strong').textContent = user.username;
  const initials = user.username.slice(0, 2).toUpperCase();
  document.querySelector('.avatar').textContent = initials;
  document.querySelector('.top-avatar').textContent = initials;
}

function setAdminSignedIn(user) {
  activeUser = user;
  document.body.classList.remove('is-logged-out');
  document.body.classList.add('is-admin');
  document.querySelector('.admin-user strong').textContent = user.username;
}

document.getElementById('login-form').addEventListener('submit', event => {
  event.preventDefault();
  const studentId = document.getElementById('login-student-id').value.trim();
  const password = document.getElementById('login-password').value;
  const error = document.getElementById('login-error');
  error.textContent = '';
  api('/api/login', { method: 'POST', body: JSON.stringify({ studentId, password }) })
    .then(async result => {
      activeUser = result.user;
      csrfToken = result.csrfToken;
      document.getElementById('login-password').value = '';
      if (activeUser.role === 'admin') {
        setAdminSignedIn(activeUser);
      } else {
        setSignedIn(activeUser);
      }
      try {
        if (activeUser.role === 'admin') await loadAdminData();
        else await loadMenu();
        showToast('You’re signed in.');
      } catch (loadError) {
        showToast(`Signed in, but could not load app data: ${loadError.message}`);
      }
    })
    .catch(loginError => {
      error.textContent = loginError.message;
      document.getElementById('login-password').focus();
    });
});

document.querySelectorAll('.password-toggle').forEach(button => {
  button.addEventListener('click', () => {
    const input = button.closest('.login-input-wrap').querySelector('input');
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    button.textContent = reveal ? 'Hide' : 'Show';
    button.setAttribute('aria-label', `${reveal ? 'Hide' : 'Show'} password`);
  });
});

document.querySelector('label[for="login-student-id"]').textContent = 'Student ID or admin username';
document.getElementById('login-student-id').placeholder = 'Student ID or username';
document.getElementById('login-student-id').title = 'Enter your student ID or configured admin username.';
document.querySelector('.login-hint p').textContent = 'Student accounts and initial passwords are provided by your mess administrator.';
document.querySelector('.login-privacy').textContent = 'Admin credentials are configured securely by the system administrator.';

function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function closeModal() {
  backdrop.classList.remove('open');
  backdrop.setAttribute('aria-hidden', 'true');
}

function openModal(title, kicker, content, doneLabel = 'Sounds good') {
  modalTitle.textContent = title;
  modalKicker.textContent = kicker;
  modalContent.innerHTML = content;
  document.getElementById('modal-done').innerHTML = `${doneLabel} <span>✓</span>`;
  modalAction = null;
  backdrop.classList.add('open');
  backdrop.setAttribute('aria-hidden', 'false');
  document.getElementById('modal-close').focus();
}

document.getElementById('modal-done').addEventListener('click', () => {
  if (modalAction) modalAction();
  else closeModal();
});

async function logOut() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (error) {
    if (error.status !== 401) {
      showToast(error.message);
      return;
    }
  }
  closeModal();
  activeUser = null;
  csrfToken = '';
  menuSchedule = [];
  feedbackEntries = [];
  menuImage = '';
  document.body.classList.remove('is-admin');
  document.body.classList.add('is-logged-out');
  document.getElementById('login-form').reset();
  document.getElementById('login-error').textContent = '';
  showToast('You’ve been signed out.');
}

async function loadMenu() {
  const result = await api('/api/menu');
  menuSchedule = result.schedule;
  scheduleDraft = null;
  menuImage = result.menuImageUrl || '';
  updatePosterPreview();
  renderScheduleRows();
  refreshStudentMenu();
}

async function loadAdminData() {
  const [menu, feedback, students] = await Promise.all([
    api('/api/menu'),
    api('/api/feedback'),
    api('/api/admin/students')
  ]);
  menuSchedule = menu.schedule;
  scheduleDraft = null;
  menuImage = menu.menuImageUrl || '';
  feedbackEntries = feedback.feedback;
  updatePosterPreview();
  renderScheduleRows();
  refreshStudentMenu();
  renderFeedback();
  renderStudents(students.students);
}

function escapeHtml(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value).replace(/[&<>"']/g, character => replacements[character]);
}

function renderScheduleRows() {
  const rows = document.getElementById('schedule-rows');
  if (!rows) return;
  const schedule = scheduleDraft === null ? menuSchedule : scheduleDraft;
  const mealOrder = ['Breakfast', 'Lunch', 'Dinner'];
  const ordered = schedule.map((meal, index) => ({ meal, index })).sort((a, b) => {
    const dayOrder = weekDays.indexOf(a.meal.day) - weekDays.indexOf(b.meal.day);
    if (dayOrder) return dayOrder;
    return mealOrder.indexOf(a.meal.meal) - mealOrder.indexOf(b.meal.meal);
  });
  rows.innerHTML = ordered.map(({ meal, index }) => {
    const options = weekDays.map(day => '<option ' + (day === meal.day ? 'selected' : '') + '>' + day + '</option>').join('');
    return '<tr data-row-index="' + index + '"><td><select class="schedule-field day-field" aria-label="Day">' + options + '</select></td><td><input class="schedule-field meal-field" aria-label="Meal" value="' + escapeHtml(meal.meal) + '"></td><td><input class="schedule-field time-field" aria-label="Service time" value="' + escapeHtml(meal.time) + '"></td><td><input class="schedule-field menu-field" aria-label="Menu" value="' + escapeHtml(meal.dish) + '"></td><td><div class="row-actions"><button class="row-save" type="button" data-schedule-action="save">Save</button><button class="row-delete" type="button" data-schedule-action="delete" aria-label="Delete meal">×</button></div></td></tr>';
  }).join('');
  document.getElementById('schedule-count').textContent = schedule.length + (schedule.length === 1 ? ' meal' : ' meals');
  document.getElementById('schedule-empty').hidden = schedule.length > 0;
  document.querySelector('.schedule-scroll').hidden = schedule.length === 0;
  document.getElementById('save-detected-schedule').hidden = scheduleDraft === null;
  document.getElementById('cancel-detected-schedule').hidden = scheduleDraft === null;
}

async function persistSchedule(schedule, message) {
  try {
    const result = await api('/api/menu', {
      method: 'PUT',
      body: JSON.stringify({ schedule })
    });
    menuSchedule = result.schedule;
    scheduleDraft = null;
    document.getElementById('last-saved').textContent = message;
    renderScheduleRows();
    refreshStudentMenu();
  } catch (error) {
    showToast(error.message);
  }
}

function readScheduleRow(row) {
  return {
    day: row.querySelector('.day-field').value,
    meal: row.querySelector('.meal-field').value.trim(),
    time: row.querySelector('.time-field').value.trim(),
    dish: row.querySelector('.menu-field').value.trim()
  };
}

document.getElementById('schedule-rows').addEventListener('click', event => {
  const button = event.target.closest('[data-schedule-action]');
  if (!button) return;
  const row = button.closest('tr');
  const index = Number(row.dataset.rowIndex);
  if (scheduleDraft !== null) {
    if (button.dataset.scheduleAction === 'delete') {
      scheduleDraft = scheduleDraft.filter((_, mealIndex) => mealIndex !== index);
    } else {
      const updated = readScheduleRow(row);
      if (!updated.meal || !updated.time || !updated.dish) {
        showToast('Add a meal name, time and menu before saving.');
        return;
      }
      scheduleDraft = scheduleDraft.map((meal, mealIndex) => mealIndex === index ? updated : meal);
    }
    renderScheduleRows();
    return;
  }
  if (button.dataset.scheduleAction === 'delete') {
    const updatedSchedule = menuSchedule.filter((_, mealIndex) => mealIndex !== index);
    persistSchedule(updatedSchedule, 'Meal removed from this week');
    return;
  }
  const updated = readScheduleRow(row);
  if (!updated.meal || !updated.time || !updated.dish) {
    showToast('Add a meal name, time and menu before saving.');
    return;
  }
  const updatedSchedule = menuSchedule.map((meal, mealIndex) => mealIndex === index ? updated : meal);
  persistSchedule(updatedSchedule, 'Meal changes saved just now');
});

document.getElementById('add-meal').addEventListener('click', () => {
  const updatedSchedule = [...(scheduleDraft === null ? menuSchedule : scheduleDraft), { day: 'Monday', meal: 'New meal', time: '12:00 – 1:00 PM', dish: 'Add menu details' }];
  if (scheduleDraft !== null) {
    scheduleDraft = updatedSchedule;
    renderScheduleRows();
  } else {
    persistSchedule(updatedSchedule, 'Meal added — edit the new row to finish');
  }
});

document.getElementById('save-detected-schedule').addEventListener('click', () => {
  if (scheduleDraft === null) return;
  persistSchedule([...scheduleDraft], 'Detected menu saved just now');
});

document.getElementById('cancel-detected-schedule').addEventListener('click', () => {
  scheduleDraft = null;
  renderScheduleRows();
});

function updatePosterPreview() {
  const poster = document.getElementById('uploaded-poster');
  const image = document.getElementById('uploaded-poster-image');
  if (!poster || !image) return;
  poster.hidden = !menuImage;
  if (menuImage) image.src = menuImage;
  else image.removeAttribute('src');
}

document.getElementById('schedule-upload').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > maxUploadBytes) {
    showToast('The menu screenshot must be 4 MB or smaller.');
    event.target.value = '';
    return;
  }
  const status = document.getElementById('schedule-upload-status');
  status.hidden = false;
  status.textContent = 'Uploading menu screenshot…';

  try {
    const formData = new FormData();
    formData.append('menuImage', file);
    const result = await api('/api/menu/image', { method: 'POST', body: formData });
    menuImage = result.menuImageUrl;
    updatePosterPreview();
    status.textContent = 'Screenshot uploaded. Reading menu text…';
  } catch (uploadError) {
    status.textContent = `Could not upload menu screenshot: ${uploadError.message}`;
    showToast(`Could not upload menu screenshot: ${uploadError.message}`);
    event.target.value = '';
    return;
  }

  if (!window.Tesseract || !window.MenuScheduleOcr) {
    status.textContent = 'The OCR service did not load. Check your connection and try again.';
    showToast('The OCR service did not load. Check your connection and try again.');
    event.target.value = '';
    return;
  }

  let worker;
  try {
    worker = await window.Tesseract.createWorker('eng', 1, {
      logger: message => {
        if (message.status === 'recognizing text') {
          status.textContent = `Reading menu text… ${Math.round(message.progress * 100)}%`;
        }
      }
    });
    const { data } = await worker.recognize(file, {}, { tsv: true });
    const detected = window.MenuScheduleOcr.parseMenuSchedule
      ? window.MenuScheduleOcr.parseMenuSchedule(data)
      : window.MenuScheduleOcr.parseMenuScheduleText(data.text, data.tsv);
    if (!detected || !detected.length) {
      status.textContent = 'Screenshot uploaded, but no meal rows were recognized. Existing schedule was left unchanged.';
      showToast('Could not detect meal rows. Use a clear table with Day, Meal, Time and Menu columns.');
      return;
    }
    scheduleDraft = null;
    await persistSchedule([...detected], 'Menu schedule updated from uploaded screenshot');
    status.textContent = `${detected.length} meals detected and meal schedule updated automatically.`;
    showToast(`${detected.length} meals detected and updated!`);
  } catch (ocrError) {
    status.textContent = `Screenshot uploaded, but its schedule could not be read: ${ocrError.message}`;
    showToast(`Screenshot uploaded, but OCR failed: ${ocrError.message}`);
  } finally {
    if (worker) await worker.terminate();
    event.target.value = '';
  }
});

document.getElementById('remove-poster').addEventListener('click', async () => {
  try {
    await api('/api/menu/image', { method: 'DELETE' });
    menuImage = '';
    menuSchedule = [];
    scheduleDraft = null;
    updatePosterPreview();
    renderScheduleRows();
    refreshStudentMenu();
    document.getElementById('last-saved').textContent = 'Screenshot and meal schedule removed';
    document.getElementById('schedule-upload-status').hidden = true;
    showToast('Menu screenshot and meal schedule removed.');
  } catch (error) {
    showToast(error.message);
  }
});

updatePosterPreview();

document.getElementById('admin-logout').addEventListener('click', logOut);

function renderStudents(students) {
  const list = document.getElementById('student-account-list');
  if (!list) return;
  document.getElementById('student-count').textContent = `${students.length} ${students.length === 1 ? 'account' : 'accounts'}`;
  document.getElementById('student-empty').hidden = students.length > 0;
  list.innerHTML = students.map(student => {
    const status = student.active ? 'Active' : 'Deactivated';
    const action = student.active ? 'Deactivate' : 'Reactivate';
    const email = student.email ? `<span>${escapeHtml(student.email)}</span>` : '';
    return `<article class="student-account"><div><strong>${escapeHtml(student.username)}</strong>${email}<span>${status}</span></div><details class="student-reset"><summary>Reset password</summary><form data-reset-id="${student.id}"><input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="72" placeholder="New password (12+ characters)" required><button type="submit">Set password</button></form></details><button type="button" class="student-toggle" data-student-id="${student.id}" data-active="${!student.active}">${action}</button></article>`;
  }).join('');
}

document.getElementById('student-import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector('input[type="file"]');
  const submit = form.querySelector('button[type="submit"]');
  const resultElement = document.getElementById('student-import-result');
  if (!input.files.length) {
    resultElement.textContent = 'Choose an .xlsx workbook first.';
    return;
  }
  if (input.files[0].size > maxUploadBytes) {
    resultElement.textContent = 'The Excel workbook must be 4 MB or smaller.';
    return;
  }
  const spreadsheet = new FormData();
  spreadsheet.append('studentSpreadsheet', input.files[0]);
  submit.disabled = true;
  resultElement.textContent = 'Validating and importing students…';
  try {
    const result = await api('/api/admin/students/import', { method: 'POST', body: spreadsheet });
    form.reset();
    const students = await api('/api/admin/students');
    renderStudents(students.students);
    resultElement.textContent = `Imported ${result.created} student ${result.created === 1 ? 'account' : 'accounts'}. Initial passwords are their email addresses.`;
  } catch (error) {
    const details = error.details || [];
    resultElement.textContent = [error.message, ...details, error.issueCount > details.length ? `Showing ${details.length} of ${error.issueCount} issues.` : ''].filter(Boolean).join('\n');
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('student-create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    await api('/api/admin/students', {
      method: 'POST',
      body: JSON.stringify({ studentId: values.get('studentId'), password: values.get('password') })
    });
    form.reset();
    const result = await api('/api/admin/students');
    renderStudents(result.students);
    showToast('Student account created.');
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});

document.getElementById('student-account-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-student-id]');
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/admin/students/${button.dataset.studentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: button.dataset.active === 'true' })
    });
    const result = await api('/api/admin/students');
    renderStudents(result.students);
    showToast('Student account updated.');
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
});

document.getElementById('student-account-list').addEventListener('submit', async event => {
  const form = event.target.closest('form[data-reset-id]');
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const values = new FormData(form);
    await api(`/api/admin/students/${form.dataset.resetId}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password: values.get('password') })
    });
    form.reset();
    showToast('Student password reset. Their existing sessions have been signed out.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('admin-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const error = document.getElementById('admin-password-error');
  error.textContent = '';
  if (values.get('newPassword') !== values.get('confirmPassword')) {
    error.textContent = 'The new passwords do not match.';
    return;
  }
  try {
    await api('/api/password', {
      method: 'PUT',
      body: JSON.stringify({
        currentPassword: values.get('currentPassword'),
        newPassword: values.get('newPassword')
      })
    });
    form.reset();
    showToast('Administrator password changed.');
  } catch (requestError) {
    error.textContent = requestError.message;
  }
});

function renderFeedback() {
  const list = document.getElementById('feedback-list');
  if (!list) return;
  const sorted = [...feedbackEntries].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  document.getElementById('feedback-count').textContent = sorted.length + (sorted.length === 1 ? ' message' : ' messages');
  document.getElementById('feedback-empty').hidden = sorted.length > 0;
  list.innerHTML = sorted.map(entry => {
    const sentAt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.createdAt));
    const stars = '★'.repeat(entry.rating || 0) + '☆'.repeat(5 - (entry.rating || 0));
    return '<article class="feedback-entry"><div class="feedback-entry-top"><div><strong>' + escapeHtml(entry.studentId) + '</strong><span>' + sentAt + '</span></div><button type="button" class="feedback-delete" data-feedback-id="' + escapeHtml(entry.id) + '" aria-label="Delete feedback">×</button></div><div class="feedback-stars" aria-label="' + (entry.rating || 0) + ' out of 5 stars">' + stars + '</div><p>' + (entry.comment ? escapeHtml(entry.comment) : '<em>Rating only</em>') + '</p></article>';
  }).join('');
}

document.getElementById('feedback-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-feedback-id]');
  if (!button) return;
  try {
    await api(`/api/feedback/${button.dataset.feedbackId}`, { method: 'DELETE' });
    feedbackEntries = feedbackEntries.filter(entry => entry.id !== Number(button.dataset.feedbackId));
    renderFeedback();
    showToast('Feedback removed from the inbox.');
  } catch (error) {
    showToast(error.message);
  }
});

function openPasswordChange() {
  openModal('Change your password', 'KEEP YOUR ACCOUNT YOURS', `<p class="password-note">Use a password of at least 12 characters. Passwords are securely hashed on the server.</p><form class="password-form" id="password-change-form"><label><span class="password-field-label">Current password</span><input class="password-field" name="currentPassword" type="password" autocomplete="current-password" required></label><label><span class="password-field-label">New password</span><input class="password-field" name="newPassword" type="password" autocomplete="new-password" minlength="12" required></label><label><span class="password-field-label">Confirm new password</span><input class="password-field" name="confirmPassword" type="password" autocomplete="new-password" minlength="12" required></label><p class="password-error" id="password-error" role="alert"></p></form>`, 'Save password');
  modalAction = async () => {
    const form = document.getElementById('password-change-form');
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const current = values.get('currentPassword');
    const next = values.get('newPassword');
    const confirm = values.get('confirmPassword');
    const error = document.getElementById('password-error');
    if (next.length < 12) { error.textContent = 'Use at least 12 characters for your new password.'; return; }
    if (next !== confirm) { error.textContent = 'The new passwords do not match.'; return; }
    if (next === current) { error.textContent = 'Choose a password different from your current one.'; return; }
    try {
      await api('/api/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      closeModal();
      showToast('Your password has been changed.');
    } catch (requestError) {
      error.textContent = requestError.message;
    }
  };
}

function openAccountSettings() {
  openModal('Your account', 'STUDENT PROFILE', `<div class="modal-choice"><span>Student ID</span><strong>${escapeHtml(activeUser.username)}</strong></div><div class="modal-choice"><span>Residence</span><strong>Not configured</strong></div><div class="settings-actions"><button class="settings-action" type="button" data-account-action="password">Change password <span>→</span></button><button class="settings-action logout" type="button" data-account-action="logout">Sign out <span>↗</span></button></div>`);
  modalContent.querySelector('[data-account-action="password"]').addEventListener('click', openPasswordChange);
  modalContent.querySelector('[data-account-action="logout"]').addEventListener('click', logOut);
}

let displayedMeals = [];
function refreshStudentMenu() {
  const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());
  const scheduledToday = menuSchedule.filter(meal => meal.day.toLowerCase() === dayName.toLowerCase());
  displayedMeals = ['Breakfast', 'Lunch', 'Dinner'].map(name => {
    const scheduled = scheduledToday.find(meal => meal.meal.toLowerCase() === name.toLowerCase());
    return scheduled
      ? { ...scheduled, name, location: 'Central Mess', rating: 'Today’s menu' }
      : { name, time: 'Not scheduled', dish: 'No menu published for this meal today.', location: 'Central Mess', rating: 'Today’s menu' };
  });
  document.querySelectorAll('.meal-card').forEach((card, index) => {
    const scheduled = displayedMeals[index];
    card.querySelector('.meal-dish').textContent = scheduled.dish;
    card.querySelector('.meal-time').textContent = scheduled.time;
    card.querySelector('.meal-link').dataset.meal = scheduled.name;
    card.querySelector('.meal-status').textContent = scheduledToday.some(meal => meal.meal.toLowerCase() === scheduled.name.toLowerCase())
      ? 'ON TODAY’S MENU'
      : 'NOT SCHEDULED';
  });
  const currentHour = new Date().getHours();
  const currentIndex = currentHour >= 7 && currentHour < 10 ? 0 : currentHour >= 10 && currentHour < 16 ? 1 : 2;
  const currentMeal = displayedMeals[currentIndex];
  document.getElementById('next-meal-label').textContent = currentMeal.name.toUpperCase();
  document.getElementById('hero-time').textContent = currentMeal.time;
  document.querySelector('.hero-text h2').innerHTML = currentIndex === 0 ? 'Breakfast is<br>better together.' : currentIndex === 1 ? 'A good lunch<br>is waiting.' : 'Dinner is<br>on its way.';
}
function menuMarkup(items = displayedMeals, showPoster = false) {
  const mealRows = items.map(meal => {
    const mealName = meal.meal || meal.name;
    const details = [meal.day, meal.location || 'Central Mess', meal.rating || 'Weekly menu'].filter(Boolean).join(' · ');
    return `<article class="modal-meal"><div class="modal-meal-head"><span>${escapeHtml(mealName.toUpperCase())}</span><span class="modal-meal-time">${escapeHtml(meal.time)}</span></div><p>${escapeHtml(meal.dish)}</p><small>${escapeHtml(details)}</small></article>`;
  }).join('');
  const poster = showPoster && menuImage ? '<img class="menu-poster" src="' + menuImage + '" alt="Weekly menu uploaded by the mess administrator">' : '';
  return poster + mealRows;
}

document.querySelectorAll('.meal-link').forEach(button => {
  button.addEventListener('click', () => {
    const meal = displayedMeals.find(item => (item.meal || item.name) === button.dataset.meal);
    if (!meal) return;
    openModal(`${meal.name} at the mess`, 'ON TODAY’S MENU', menuMarkup([meal]));
  });
});

document.getElementById('hero-action').addEventListener('click', async () => {
  try {
    await loadMenu();
    openModal('Today’s menu', 'TODAY’S MENU', menuMarkup(displayedMeals, true));
  } catch (error) {
    showToast(`Could not load menu: ${error.message}`);
  }
});

document.getElementById('modal-close').addEventListener('click', closeModal);
backdrop.addEventListener('click', event => { if (event.target === backdrop) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

function openFeedback() {
  openModal('How was your meal?', 'YOUR VOICE MAKES A DIFFERENCE', `<p class="modal-note">A quick note helps the mess team make every meal a little better. What would you like us to know?</p><div class="modal-stars" aria-label="Choose a rating"><button type="button" aria-label="1 star" aria-pressed="false">★</button><button type="button" aria-label="2 stars" aria-pressed="false">★</button><button type="button" aria-label="3 stars" aria-pressed="false">★</button><button type="button" aria-label="4 stars" aria-pressed="false">★</button><button type="button" aria-label="5 stars" aria-pressed="false">★</button></div><textarea class="modal-textarea" id="feedback-text" placeholder="Tell us what you think…" aria-label="Your feedback"></textarea><p class="feedback-error" id="feedback-error" role="alert"></p>`, 'Send feedback');
  let selectedRating = 0;
  const stars = [...modalContent.querySelectorAll('.modal-stars button')];
  stars.forEach((star, index) => {
    star.style.border = '0'; star.style.background = 'transparent'; star.style.padding = '0'; star.style.cursor = 'pointer';
    star.addEventListener('click', () => {
      selectedRating = index + 1;
      stars.forEach((item, itemIndex) => {
        item.style.color = itemIndex <= index ? '#d5a35d' : '#dfe2db';
        item.setAttribute('aria-pressed', String(itemIndex === index));
      });
    });
  });
  modalAction = async () => {
    const comment = document.getElementById('feedback-text').value.trim();
    if (!comment && !selectedRating) {
      document.getElementById('feedback-error').textContent = 'Add a comment or choose a star rating before sending.';
      return;
    }
    try {
      await api('/api/feedback', {
        method: 'POST',
        body: JSON.stringify({ rating: selectedRating, comment })
      });
      closeModal();
      showToast('Thanks! Your feedback was sent to the mess team.');
    } catch (error) {
      document.getElementById('feedback-error').textContent = error.message;
    }
  };
}

document.getElementById('tip-feedback').addEventListener('click', openFeedback);
document.querySelector('[data-view="feedback"]').addEventListener('click', event => { event.preventDefault(); openFeedback(); });

document.getElementById('notifications').addEventListener('click', () => showToast('Notifications are not connected yet.'));
function openAttendanceInfo() {
  openModal('Attendance isn’t connected', 'LIVE DATA NOT AVAILABLE', '<p class="modal-note">This app does not have a campus attendance system connected yet, so it cannot show real attendance records. Connect an approved attendance data source to enable this feature.</p>');
}

document.getElementById('attendance-more').addEventListener('click', openAttendanceInfo);

document.querySelectorAll('[data-view]').forEach(link => {
  link.addEventListener('click', async event => {
    if (link.dataset.view === 'feedback') { event.preventDefault(); return; }
    event.preventDefault();
    const view = link.dataset.view;
    const labels = { overview: 'Overview', menu: 'Weekly menu', attendance: 'My attendance', account: 'My account', help: 'Help & support' };
    document.getElementById('breadcrumb-current').textContent = labels[view] || 'Overview';
    document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
    document.getElementById('sidebar').classList.remove('mobile-open');
    if (view === 'menu') {
      try {
        await loadMenu();
      } catch (error) {
        showToast(`Could not load menu: ${error.message}`);
        return;
      }
      openModal('This week at the mess', 'YOUR WEEKLY MENU', `<p class="modal-note">A look at what’s cooking at the Central Mess. Today’s menu is fresh from the kitchen.</p>${menuMarkup(menuSchedule, true)}`);
    } else if (view === 'attendance') {
      openAttendanceInfo();
    } else if (view === 'help') {
      openModal('How can we help?', 'HERE FOR THE CAMPUS COMMUNITY', `<p class="modal-note">Need help with a meal plan, attendance record or something at the mess? The student mess committee is happy to help.</p><div class="modal-choice"><span>Mess office</span><strong>Weekdays · 10 AM–5 PM</strong></div><div class="modal-choice"><span>Central Mess desk</span><strong>Open during meal hours</strong></div>`);
    } else if (view === 'account') {
      openAccountSettings();
    } else if (view === 'overview') {
      document.getElementById('overview').scrollIntoView({ behavior: 'smooth' });
    }
  });
});

document.getElementById('date-selector').addEventListener('click', () => showToast(`Showing your schedule for ${displayDate}.`));
document.getElementById('announcement-link').addEventListener('click', event => {
  event.preventDefault();
  openModal('Campus updates aren’t connected', 'LIVE DATA NOT AVAILABLE', '<p class="modal-note">Campus announcements will appear here once an approved updates source is connected.</p>');
});

document.querySelector('.announcement-label').textContent = 'MESS UPDATES · NOT CONNECTED';
document.querySelector('.announcement-card h2').textContent = 'Stay tuned for mess updates.';
document.querySelector('.announcement-card p').textContent = 'Campus announcements will appear here once an approved updates source is connected.';
document.getElementById('announcement-link').innerHTML = 'About updates <span>↗</span>';

document.getElementById('profile-button').addEventListener('click', () => {
  openAccountSettings();
});

document.getElementById('mobile-menu').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('mobile-open'));
document.getElementById('toast-close').addEventListener('click', () => toast.classList.remove('show'));

const now = new Date();
const dateLabel = document.getElementById('current-date');
const displayDate = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
dateLabel.textContent = displayDate;
const eyebrowDate = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: '2-digit', month: 'short' }).format(now).toUpperCase();
document.querySelector('.meal-heading .eyebrow').innerHTML = `<span class="eyebrow-line"></span> ${eyebrowDate}`;
const heroDate = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }).format(now).toUpperCase();
document.getElementById('hero-action').addEventListener('click', () => { modalKicker.textContent = heroDate; });

async function initializeApp() {
  try {
    const session = await api('/api/session');
    if (!session.user) return;
    activeUser = session.user;
    csrfToken = session.csrfToken;
    if (activeUser.role === 'admin') setAdminSignedIn(activeUser);
    else setSignedIn(activeUser);
    try {
      if (activeUser.role === 'admin') await loadAdminData();
      else await loadMenu();
    } catch (error) {
      showToast(`Could not load app data: ${error.message}`);
    }
  } catch (error) {
    document.getElementById('login-error').textContent = `Unable to connect to the app server: ${error.message}`;
  }
}

initializeApp();
