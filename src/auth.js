// src/auth.js — JWT issue/verify, API-key + JWT middleware, bootstrap admin
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const store = require('../db/store');
const config = require('./config');

const router = express.Router();

// ---------- Bootstrap admin on first boot ----------
function ensureAdminBootstrap() {
  if (store.userCount() === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const apiKey = config.genApiKey();
    store.createUser({
      username,
      passwordHash: bcrypt.hashSync(password, 10),
      apiKey,
      isAdmin: true,
    });
    console.log(`[bootstrap] Admin user created: "${username}" (password from ADMIN_PASSWORD).`);
  }
}

// ---------- Token helpers ----------
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, admin: !!user.is_admin },
    config.jwtSecret,
    { expiresIn: config.jwtExpires }
  );
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    apiKey: user.api_key,
    isAdmin: !!user.is_admin,
    createdAt: user.created_at,
  };
}

// ---------- Middleware ----------
// Accepts either a Bearer JWT OR an X-API-Key header (so scripts/clients
// can use the API without a login flow).
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const apiKey = req.headers['x-api-key'];

  try {
    if (apiKey) {
      const user = store.getUserByKey(apiKey);
      if (!user) return res.status(401).json({ error: 'Invalid API key' });
      req.user = user;
      return next();
    }
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, config.jwtSecret);
      const user = store.getUserById(payload.sub);
      if (!user) return res.status(401).json({ error: 'User not found' });
      req.user = user;
      return next();
    }
    return res.status(401).json({ error: 'Authentication required (Bearer token or X-API-Key)' });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ---------- Routes: /api/auth ----------
// Register
router.post('/register', (req, res) => {
  if (config.disableSignup) return res.status(403).json({ error: 'Public signup is disabled' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, numbers, _.-)' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (store.getUserByName(username)) return res.status(409).json({ error: 'Username already taken' });

  const user = store.createUser({
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    apiKey: config.genApiKey(),
    isAdmin: false,
  });
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// Login
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  const user = store.getUserByName(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// Current user
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Regenerate API key
router.post('/regenerate-key', requireAuth, (req, res) => {
  const newKey = config.genApiKey();
  store.updateUser(req.user.id, { api_key: newKey });
  const user = store.getUserById(req.user.id);
  res.json({ apiKey: newKey, user: publicUser(user) });
});

module.exports = {
  router,
  ensureAdminBootstrap,
  requireAuth,
  requireAdmin,
  signToken,
  publicUser,
};
