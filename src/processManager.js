// src/processManager.js — spawn / stop / restart bot subprocesses,
// stream stdout/stderr to DB log buffer and Socket.IO rooms.
//
// Each bot runs as an isolated child_process spawned in its own working dir.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('../db/store');
const config = require('./config');
const { LANGUAGES } = require('./languages');

// botId -> { proc, pid, startedAt, autoRestart, restartCount }
const running = new Map();
// botId -> Set of socket ids currently tailing this bot's logs
const watchers = new Map();
let io = null;

function setIO(socketIO) { io = socketIO; }

function botWorkdir(bot) {
  return path.join(config.usersDir, bot.user_id, bot.dir_name);
}

function emit(botId, stream, text) {
  // persist + push to any connected watchers
  store.appendLog(botId, stream, text);
  if (io) io.to(`bot:${botId}`).emit('log', { botId, stream, text, ts: Date.now() });
}

function statusOf(botId) {
  const r = running.get(botId);
  if (!r || !r.proc || r.proc.exitCode !== null) return 'stopped';
  return 'running';
}

function describe(botId) {
  const r = running.get(botId);
  return {
    status: statusOf(botId),
    pid: r && r.proc && r.proc.pid && statusOf(botId) === 'running' ? r.proc.pid : null,
    startedAt: r ? r.startedAt : null,
    restartCount: r ? r.restartCount : 0,
  };
}

function start(bot) {
  // already running?
  if (statusOf(bot.id) === 'running') {
    emit(bot.id, 'system', 'Bot is already running.');
    return false;
  }

  const workdir = botWorkdir(bot);
  if (!fs.existsSync(workdir)) {
    emit(bot.id, 'system', `Working directory missing: ${workdir}`);
    return false;
  }
  const entryPath = path.join(workdir, bot.entry_file);
  if (!fs.existsSync(entryPath)) {
    emit(bot.id, 'system', `Entry file not found: ${bot.entry_file}`);
    return false;
  }

  const lang = LANGUAGES[bot.language];
  if (!lang) {
    emit(bot.id, 'system', `Unsupported language: ${bot.language}`);
    return false;
  }

  // Build env: process env + per-bot env
  let env = { ...process.env };
  try {
    const extra = JSON.parse(bot.env_json || '{}');
    env = { ...env, ...extra };
  } catch (_) { /* ignore malformed */ }

  let proc;
  try {
    proc = spawn(lang.binary, lang.argsFor(bot.entry_file), {
      cwd: workdir,
      env,
      shell: process.platform === 'win32',
      windowsHide: true,
    });
  } catch (e) {
    emit(bot.id, 'system', `Failed to spawn: ${e.message}`);
    return false;
  }

  const rec = {
    proc,
    pid: proc.pid,
    startedAt: Date.now(),
    autoRestart: !!bot.auto_restart,
    restartCount: 0,
  };
  running.set(bot.id, rec);

  emit(bot.id, 'system', `▶ Starting [${lang.label}] ${bot.entry_file} (pid ${proc.pid})`);
  store.markStarted(bot.id);

  const lineBuf = (stream) => {
    let pending = '';
    return (chunk) => {
      pending += chunk.toString();
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.length) emit(bot.id, stream, line);
      }
      if (pending.length) emit(bot.id, stream, pending);
      pending = '';
    };
  };

  proc.stdout.on('data', lineBuf('stdout'));
  proc.stderr.on('data', lineBuf('stderr'));

  proc.on('error', (err) => {
    emit(bot.id, 'system', `Process error: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    const cur = running.get(bot.id);
    running.delete(bot.id);
    const msg = signal
      ? `■ Process killed by signal ${signal}`
      : `■ Process exited with code ${code}`;
    emit(bot.id, code === 0 ? 'system' : 'stderr', msg);

    // Optional auto-restart on unexpected crash (not on manual stop / SIGTERM)
    if (cur && cur.autoRestart && code !== 0 && code !== null && signal !== 'SIGTERM') {
      if (cur.restartCount < 5) {
        cur.restartCount++;
        emit(bot.id, 'system', `↻ Auto-restarting in 3s (attempt ${cur.restartCount}/5)...`);
        setTimeout(() => {
          const fresh = store.getBot(bot.id);
          if (fresh) start(fresh);
        }, 3000);
      } else {
        emit(bot.id, 'system', '✕ Max auto-restart attempts reached. Stopping.');
      }
    }
  });

  return true;
}

function stop(botId) {
  const rec = running.get(botId);
  if (!rec || !rec.proc || rec.proc.exitCode !== null) {
    emit(botId, 'system', 'Bot is not running.');
    return false;
  }
  rec.autoRestart = false; // prevent restart loops
  try {
    rec.proc.kill('SIGTERM');
    // force-kill after 5s if still alive
    setTimeout(() => {
      if (running.has(botId)) {
        try { rec.proc.kill('SIGKILL'); } catch (_) {}
      }
    }, 5000);
  } catch (e) {
    emit(botId, 'system', `Stop error: ${e.message}`);
  }
  emit(botId, 'system', '⏹ Stop requested.');
  return true;
}

function restart(botId) {
  const bot = store.getBot(botId);
  if (!bot) return false;
  const wasRunning = statusOf(botId) === 'running';
  if (wasRunning) {
    const rec = running.get(botId);
    rec.autoRestart = false;
    try { rec.proc.kill('SIGTERM'); } catch (_) {}
    running.delete(botId);
  }
  // small delay so the port/file is released
  setTimeout(() => start(bot), wasRunning ? 800 : 0);
  emit(botId, 'system', '↻ Restarting...');
  return true;
}

function stopAll() {
  for (const [id] of running) stop(id);
}

// On server boot, restart bots that were previously running? We opt for manual
// restart (safer & predictable), but expose the list of stopped bots.

module.exports = {
  setIO,
  start, stop, restart, stopAll,
  status: statusOf,
  describe,
  botWorkdir,
  emit,
};
