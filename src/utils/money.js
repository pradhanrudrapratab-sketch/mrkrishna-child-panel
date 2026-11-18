'use strict';
// All money is integer paise. No floating-point wallet math.
function toPaise(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Invalid amount');
  const [r, p = ''] = s.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}
function fromPaise(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('Invalid paise');
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b);
// markupBp: basis points (30% = 3000). Rounds UP to the nearest paisa.
function retailRatePaise(wholesalePaisePer1000, markupBp) {
  return ceilDiv(wholesalePaisePer1000 * (10000 + markupBp), 10000);
}
function orderCostPaise(ratePaisePer1000, quantity) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Invalid quantity');
  return ceilDiv(ratePaisePer1000 * quantity, 1000);
}
module.exports = { toPaise, fromPaise, retailRatePaise, orderCostPaise };
// Parse a rate string/number from an upstream API into paise, rounding UP (never under-charge).
function toPaiseCeil(input) {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Invalid rate');
  const [r, p = ''] = s.split('.');
  const base = Number(r) * 100 + Number(p.slice(0, 2).padEnd(2, '0'));
  return /[1-9]/.test(p.slice(2)) ? base + 1 : base;
}
module.exports.toPaiseCeil = toPaiseCeil;
