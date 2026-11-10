const { del, put } = require('@vercel/blob');
const { createPostgresDatabase, ensureBootstrapAdmin, seedDefaultMenu } = require('../backend/postgres-db');
const { createApp } = require('../backend/server');

let appPromise;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const sessionSecret = process.env.SESSION_SECRET;
      if (!sessionSecret || sessionSecret.length < 32) {
        throw new Error('Set SESSION_SECRET to a random value of at least 32 characters.');
      }
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        throw new Error('Connect a Vercel Blob store to provide BLOB_READ_WRITE_TOKEN.');
      }

      const db = createPostgresDatabase(process.env.DATABASE_URL);
      try {
        await db.initialize();
        await seedDefaultMenu(db);
        await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
        await ensureBootstrapAdmin(db, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD);
      } catch (error) {
        await db.close();
        throw error;
      }

      return createApp({
        db,
        sessionSecret,
        secureCookies: true,
        blobStorage: { put, del },
        serveStatic: false,
        trustProxy: 1
      });
    })();
    appPromise = appPromise.catch(error => {
      appPromise = undefined;
      throw error;
    });
  }
  return appPromise;
}

module.exports = async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
};

module.exports.config = {
  api: {
    bodyParser: false,
    externalResolver: true
  }
};
