'use strict';
const test = require('node:test'); const assert = require('node:assert');
const m = require('../src/utils/money'); const { newTransactionId } = require('../src/utils/txid');
test('paise parsing', () => { assert.equal(m.toPaise('100.50'), 10050); assert.equal(m.fromPaise(10050), '100.50'); assert.throws(() => m.toPaise('1.234')); });
test('30% markup example from spec', () => {
  const rate = m.retailRatePaise(1300, 3000); assert.equal(rate, 1690); assert.equal(m.orderCostPaise(rate, 1000), 1690);
});
test('rounds up', () => assert.equal(m.retailRatePaise(1001, 3000), 1302));
test('txn id format', () => assert.match(newTransactionId(new Date(2026, 10, 18)), /^MKP18112026[A-Z0-9]{4}$/));
