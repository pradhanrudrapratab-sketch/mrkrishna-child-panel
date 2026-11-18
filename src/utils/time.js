'use strict';
const fmt = (d = new Date()) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const parse = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
const addMs = (d, ms) => new Date(new Date(d).getTime() + ms);
module.exports = { fmt, parse, addMs };
