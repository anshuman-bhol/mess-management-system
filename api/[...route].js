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
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown initialization error';
    console.error('Vercel app initialization failed:', message);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({
      error: 'The app server failed to initialize. Check the Vercel Function Logs and required environment variables.'
    }));
  }
};

module.exports.config = {
  api: {
    bodyParser: false,
    externalResolver: true
  }
};
