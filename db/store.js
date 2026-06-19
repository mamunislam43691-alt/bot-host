// db/store.js — pure-JS data layer (no native deps; works on Windows + Railway).
//
// Strategy:
//   * users + bots : persisted to a JSON file (db.json), small & rarely changing.
//   * logs         : in-memory ring buffer (last N lines per bot) for real-time tailing.
//
// This avoids better-sqlite3's native build requirement entirely.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'db.json');
const LOG_BUFFER_LIMIT = parseInt(process.env.LOG_BUFFER_LIMIT || '10000', 10);

// ---------- In-memory store ----------
let users = [];        // [{id, username, password_hash, api_key, is_admin, created_at}]
let bots = [];         // [{id, user_id, name, language, entry_file, dir_name, auto_restart, env_json, created_at, last_started}]
let logs = new Map();  // botId -> [{id, ts, stream, text}]   (ring buffer)
let logCounter = new Map(); // botId -> next id

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      users = raw.users || [];
      bots = raw.bots || [];
    }
  } catch (e) {
    console.error('[store] failed to load db.json:', e.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist();
  }, 250);
}
function persist() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users, bots }, null, 0));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[store] persist failed:', e.message);
  }
}

load();

// ---------- Users ----------
function createUser({ username, passwordHash, apiKey, isAdmin = false }) {
  const user = {
    id: crypto.randomUUID(),
    username,
    password_hash: passwordHash,
    api_key: apiKey,
    is_admin: isAdmin ? 1 : 0,
    created_at: Date.now(),
  };
  users.push(user);
  scheduleSave();
  return user;
}
function getUserByName(username) { return users.find((u) => u.username === username); }
function getUserById(id) { return users.find((u) => u.id === id); }
function getUserByKey(apiKey) { return users.find((u) => u.api_key === apiKey); }
function userCount() { return users.length; }
function updateUser(id, patch) {
  const u = users.find((x) => x.id === id);
  if (!u) return null;
  Object.assign(u, patch);
  scheduleSave();
  return u;
}

// ---------- Bots ----------
function createBot({ userId, name, language, entryFile, dirName, autoRestart, env }) {
  const bot = {
    id: crypto.randomUUID(),
    user_id: userId,
    name,
    language,
    entry_file: entryFile,
    dir_name: dirName,
    auto_restart: autoRestart ? 1 : 0,
    env_json: JSON.stringify(env || {}),
    created_at: Date.now(),
    last_started: null,
  };
  bots.push(bot);
  scheduleSave();
  return bot;
}
function getBot(id) { return bots.find((b) => b.id === id); }
function getBotsByUser(userId) {
  return bots.filter((b) => b.user_id === userId).sort((a, b) => b.created_at - a.created_at);
}
function getAllBots() {
  return bots.slice().sort((a, b) => b.created_at - a.created_at);
}
function markStarted(id) {
  const b = getBot(id);
  if (b) { b.last_started = Date.now(); scheduleSave(); }
  return b;
}
function updateBotSettings(id, envJson, autoRestart) {
  const b = getBot(id);
  if (!b) return null;
  b.env_json = JSON.stringify(envJson || {});
  b.auto_restart = autoRestart ? 1 : 0;
  scheduleSave();
  return b;
}
function updateBotName(id, name) {
  const b = getBot(id);
  if (b) { b.name = name; scheduleSave(); }
  return b;
}
function deleteBotRow(id) {
  bots = bots.filter((b) => b.id !== id);
  logs.delete(id);
  logCounter.delete(id);
  scheduleSave();
  return true;
}

// ---------- Logs (in-memory ring buffer) ----------
function appendLog(botId, stream, text) {
  if (!logs.has(botId)) { logs.set(botId, []); logCounter.set(botId, 0); }
  const buf = logs.get(botId);
  const id = (logCounter.get(botId) || 0) + 1;
  logCounter.set(botId, id);
  buf.push({ id, ts: Date.now(), stream, text: String(text) });
  // trim
  if (buf.length > LOG_BUFFER_LIMIT) buf.splice(0, buf.length - LOG_BUFFER_LIMIT);
}
function getLogs(botId, afterId = 0, limit = 500) {
  const buf = logs.get(botId) || [];
  const out = [];
  for (const l of buf) {
    if (l.id <= afterId) continue;
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}
function clearLogs(botId) { logs.set(botId, []); logCounter.set(botId, 0); }

module.exports = {
  // raw for legacy compatibility (not used now)
  db: { prepare: () => ({ run() {} }) },
  DATA_DIR,
  // users
  createUser, getUserByName, getUserById, getUserByKey, userCount, updateUser,
  // bots
  createBot, getBot, getBotsByUser, getAllBots, markStarted,
  updateBotSettings, updateBotName, deleteBotRow,
  // logs
  appendLog, getLogs, clearLogs,
  // maintenance
  persist,
};
