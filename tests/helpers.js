'use strict';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const { openDb } = require('../src/database');
const auth = require('../src/services/auth');
const settings = require('../src/services/settings');
const wallet = require('../src/services/wallet');
const catalog = require('../src/services/catalog');

function freshDb() { return openDb(':memory:'); }
function user(db, name = 'alice', funds = 0) {
  const id = auth.createUser(db, { username: name, email: `${name}@example.com`, password: 'password123' });
  if (funds) wallet.applyTx(db, { userId: id, type: 'admin_adjust', amountPaise: funds, refType: 'admin', refId: `seed-${name}`, reason: 'seed' });
  return id;
}
function configurePayments(db) { settings.set(db, 'fampay_upi_id', 'owner@fam'); settings.set(db, 'fampay_allowed_senders', 'no-reply@fampay.test'); }
function seedService(db, { rate = '13.00', min = 100, max = 10000 } = {}) {
  catalog.syncServices(db, { count: 1, currency: 'INR', services: [{ id: 7, name: 'Instagram Followers', category: 'Instagram Followers', platform: 'instagram', type: 'Default', rate: `${rate}00`, min, max, currency: 'INR' }] });
  return db.prepare('SELECT * FROM services').get();
}
const notif = (over = {}) => ({ uid: `<m-${Math.random()}@x>`, sender: 'no-reply@fampay.test', amountPaise: 10000, receivedAt: new Date(), reference: null, authPass: true, ...over });
module.exports = { freshDb, user, configurePayments, seedService, notif };
