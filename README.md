# Messmate

Messmate is a Node.js/Express web application backed by SQLite. Student accounts, menu changes, uploaded menu images, feedback, and login sessions are stored on the server and shared across users.

The browser app is in `frontend/`; the Express server, database module, scripts, and tests are in `backend/`. Keep `package.json`, `.env`, and persistent data at the project root.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a local environment file and set unique secrets:

   ```sh
   cp .env.example .env
   ```

   Set `SESSION_SECRET` to a random secret of at least 32 characters and replace the example `ADMIN_PASSWORD` with a unique password of at least 12 characters. The configured admin account is created the first time the database is initialized.

3. Start the app:

   ```sh
   npm start
   ```

4. Open <http://localhost:3000>. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`. In **Student accounts → Bulk import students**, download the Excel template and fill its `Student ID` and `Student Email ID` columns. Upload the completed `.xlsx` file; each student's email address becomes their initial password, which they can change after signing in. The import is all-or-nothing, reports row-specific validation errors, and supports up to 5,000 students per workbook. Administrators can also create a single account, deactivate accounts, and reset passwords.

The spreadsheet's first worksheet must have `Student ID` and `Student Email ID` headers. Student IDs must be A or B followed by six digits. Each email must be valid and unique across existing accounts and the workbook. Imported default passwords are stored as salted password hashes and are never saved in plaintext.

The sample weekly menu is loaded into a new database on first startup. Existing menu data is retained on subsequent starts. Data previously saved in the old browser-only version is not automatically imported.

### Admin password changed in `.env`

The initial admin password is copied into SQLite only when the admin account is first created. Editing `ADMIN_PASSWORD` later does not change the existing account. For local development, run:

```sh
npm run admin:sync-password
```

This sets the existing local admin password to the current `.env` value and revokes existing admin sessions. It does not reset or delete application data.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (defaults to `3000`) |
| `SESSION_SECRET` | Signs opaque, server-backed login session cookies; required |
| `ADMIN_USERNAME` | Initial administrator username; used only when no admin exists |
| `ADMIN_PASSWORD` | Initial administrator password; used only when no admin exists |
| `DATABASE_PATH` | SQLite database file (defaults to `./data/messmate.sqlite`) |
| `UPLOADS_PATH` | Uploaded menu screenshot directory (defaults to `./uploads`) |
| `NODE_ENV` | Set to `production` to enable secure-only session cookies |
| `TRUST_PROXY` | Set to `1` only when deployed behind a trusted reverse proxy |

## Production notes

Use HTTPS, a unique secret, and a deployment platform with persistent storage. Back up the SQLite database and uploads directory together. Do not deploy the SQLite database to an ephemeral/serverless filesystem. Store secrets in the hosting provider's secret manager rather than committing `.env`. For multiple server instances or high traffic, use a shared database and session store instead of SQLite.

The attendance, campus announcements, and notifications panels are intentionally marked as unavailable: no approved campus data sources or integration credentials are part of this project. The app does not display fabricated attendance figures or announcements.

## Tests

Run the API integration tests with:

```sh
npm test
```
