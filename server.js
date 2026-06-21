// server.js — Bot Hosting Panel entry point
// Express HTTP API + static web UI + Socket.IO for live logs.
require('dotenv').config();

// compiled Python extensions (.so files) খুঁজে পেতে LD_LIBRARY_PATH সেট করো
// grpc, numpy, cryptography ইত্যাদি Nix store থেকে libstdc++ খোঁজে
if (process.platform !== 'win32') {
  const { execSync } = require('child_process');
  try {
    // Nix-এ gcc lib path খুঁজে বের করো
    const gccLib = execSync('gcc -print-file-name=libstdc++.so.6 2>/dev/null || echo ""', {
      encoding: 'utf8', shell: true, timeout: 3000,
    }).trim();
    if (gccLib && gccLib !== 'libstdc++.so.6') {
      const libDir = require('path').dirname(gccLib);
      const current = process.env.LD_LIBRARY_PATH || '';
      const paths = [libDir, '/usr/lib', '/usr/local/lib', '/lib'].filter(Boolean);
      const merged = [...new Set([...paths, ...current.split(':').filter(Boolean)])].join(':');
      process.env.LD_LIBRARY_PATH = merged;
      console.log(`[boot] LD_LIBRARY_PATH=${merged.substring(0, 80)}...`);
    }
  } catch (_) {
    // LD_LIBRARY_PATH set ব্যর্থ হলেও চলবে
  }
}

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const config = require('./src/config');
const store = require('./db/store');
const pm = require('./src/processManager');
const { router: authRouter, ensureAdminBootstrap, requireAuth } = require('./src/auth');
const botsRouter = require('./src/routes/bots');
const deployRouter = require('./src/routes/deploy');
const statsRouter = require('./src/routes/stats');

// ---------- App ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io', cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Socket.IO: authenticate + join bot rooms ----------
const jwt = require('jsonwebtoken');
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const apiKey = socket.handshake.auth?.apiKey || socket.handshake.query?.apiKey;
  try {
    let user = null;
    if (apiKey) user = store.getUserByKey(apiKey);
    else if (token) {
      const payload = jwt.verify(token, config.jwtSecret);
      user = store.getUserById(payload.sub);
    }
    if (!user) return next(new Error('Unauthorized'));
    socket.data.user = user;
    next();
  } catch (e) {
    next(new Error('Unauthorized'));
  }
});
io.on('connection', (socket) => {
  // ইউজারের সব বটের status room-এ auto-join করো
  const userBots = store.getBotsByUser(socket.data.user.id);
  if (socket.data.user.is_admin) {
    // admin সব বটের update পাবে
    store.getAllBots().forEach(b => socket.join(`bot:${b.id}`));
  } else {
    userBots.forEach(b => socket.join(`bot:${b.id}`));
  }

  socket.on('subscribe', (botId) => {
    const bot = store.getBot(botId);
    if (!bot) return;
    if (bot.user_id !== socket.data.user.id && !socket.data.user.is_admin) return;
    socket.join(`bot:${botId}`);
    // send last N lines as catch-up
    const recent = store.getLogs(botId, 0, 200);
    socket.emit('history', { botId, logs: recent });
  });
  socket.on('unsubscribe', (botId) => socket.leave(`bot:${botId}`));
});

pm.setIO(io);

// ---------- Public health ----------
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---------- API routes ----------
app.use('/api/auth', authRouter);
app.use('/api/bots', requireAuth, botsRouter);
app.use('/api/deploy', requireAuth, deployRouter);
app.use('/api/stats', requireAuth, statsRouter);

// catch-all API 404
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Static web UI ----------
app.use(express.static(path.join(__dirname, 'public')));
// SPA-ish fallback: any non-file GET returns index.html (so /#/dashboard works)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Graceful shutdown ----------
function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received, stopping bots...`);
  pm.stopAll();
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------- Boot ----------
ensureAdminBootstrap();
server.listen(config.port, () => {
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  🚀 Bot Hosting Panel running              ║`);
  console.log(`║  → Web UI:  http://localhost:${config.port}`);
  console.log(`║  → API:     http://localhost:${config.port}/api`);
  console.log(`╚════════════════════════════════════════════╝\n`);
});
