#!/usr/bin/env node
'use strict';

// quiet: dotenv 17 otherwise prints a banner to stdout, corrupting --raw output.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const db = require('../src/db');

// Generate an 8-character hex code formatted as XXXX-XXXX
const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;

db.createInviteCode(code);
db.close();

if (process.argv.includes('--raw')) {
  process.stdout.write(code);
} else {
  console.log(`\nInvite code created:\n\n    ${code}\n\nShare this with the person you want to invite.\nCodes are single-use.\n`);
}
