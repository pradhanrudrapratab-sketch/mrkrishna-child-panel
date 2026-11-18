'use strict';
const path = require('path');
const { initKey } = require('./utils/crypto');
const { DbHolder } = require('./database');
const { createApp } = require('./app');
const { startJobs } = require('./jobs');
const { scrubSecrets } = require('./services/secrets');
const setup = require('./services/setup');

// Everything is hardcoded to sensible defaults. Secrets are generated on first start; settings live in the admin panel.
const DB_FILE = process.env.DATABASE_PATH || '/tmp/mrkrishna-child-panel/database.sqlite'; // optional override, never required
const PORT = process.env.PORT || 10000; // Render injects PORT itself

const keyInfo = initKey(path.dirname(DB_FILE));
const holder = new DbHolder(DB_FILE);
const cleared = scrubSecrets(holder.db);
if (keyInfo.created) console.log('Generated a new encryption key for this instance.');
if (cleared.length) console.log(`Re-enter in the admin panel (stored value could not be decrypted): ${cleared.join(', ')}`);
setup.current(holder.db); // prints the one-time setup code while no admin exists

const server = createApp(holder).listen(PORT, () => console.log(`Child panel listening on ${PORT} (db: ${DB_FILE})`));
const stop = startJobs(holder);
const shutdown = () => { stop(); server.close(() => { holder.close(); process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
