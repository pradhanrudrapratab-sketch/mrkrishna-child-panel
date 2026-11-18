'use strict';
const crypto = require('crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// MKP + DDMMYYYY + 4 random chars, e.g. MKP18112026A7K9
function newTransactionId(date = new Date()) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  let r = '';
  for (let i = 0; i < 4; i++) r += A[crypto.randomInt(A.length)];
  return `MKP${dd}${mm}${date.getFullYear()}${r}`;
}
module.exports = { newTransactionId };
