// src/config.js — central config & helpers
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('../db/store');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex'),
  jwtExpires: '30d',
  dataDir: store.DATA_DIR,
  maxUploadMb: parseInt(process.env.MAX_UPLOAD_MB || '50', 10),
  disableSignup: String(process.env.DISABLE_SIGNUP || '').toLowerCase() === 'true',
  usersDir: path.join(store.DATA_DIR, 'users'),
};

if (!fs.existsSync(config.usersDir)) fs.mkdirSync(config.usersDir, { recursive: true });

config.genApiKey = () => 'bh_' + crypto.randomBytes(24).toString('hex');
config.genId = () => require('uuid').v4();

module.exports = config;
