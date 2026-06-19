// src/processManager.js — spawn / stop / restart bot subprocesses,
// stream stdout/stderr to DB log buffer and Socket.IO rooms.
//
// Each bot runs as an isolated child_process spawned in its own working dir.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('../db/store');
const config = require('./config');
const { LANGUAGES, autoDetectDeps, installPythonPackages } = require('./languages');

// Track bots whose deps are already installed this server lifetime,
// so we don't reinstall on every restart.
const depsInstalled = new Set();

// botId -> { proc, pid, startedAt, autoRestart, restartCount, status }
// status: 'stopped' | 'starting' | 'running'
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
  if (!r) return 'stopped';
  if (r.status === 'starting') return 'running'; // show as running to user
  if (!r.proc) return 'stopped';
  if (r.proc.killed) return 'stopped';
  // In Node, exitCode is null while process is still alive
  if (r.proc.exitCode === null && r.proc.signalCode === null) return 'running';
  return 'stopped';
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

function start(bot, isAutoRestart = false) {
  // already running?
  if (statusOf(bot.id) === 'running') {
    emit(bot.id, 'system', 'Bot is already running.');
    return false;
  }

  // On manual start/restart, re-check dependencies.
  if (!isAutoRestart) {
    depsInstalled.delete(bot.id);
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

  // Check if the runtime is available BEFORE spawning
  if (typeof lang.available === 'function' && !lang.available()) {
    const msg = bot.language === 'python'
      ? `✕ Python is not installed on this server. The server admin must add Python to the build (see nixpacks.toml).`
      : `✕ The ${lang.label} runtime is not available on this server.`;
    emit(bot.id, 'system', msg);
    return false;
  }

  // ---------- Ensure dependencies are installed (covers older bots too) ----------
  // We run this once per bot per server lifetime (cached via depsInstalled set).
  if (!depsInstalled.has(bot.id)) {
    try {
      if (bot.language === 'python') {
        // 1) requirements.txt inside the bot folder
        const reqFile = path.join(workdir, 'requirements.txt');
        if (fs.existsSync(reqFile)) {
          emit(bot.id, 'system', `📦 Installing requirements.txt...`);
          installPythonPackages(workdir, fs.readFileSync(reqFile, 'utf8'));
          emit(bot.id, 'system', '✓ requirements.txt installed.');
        }
        // 2) auto-detect imports from the entry file
        const detected = autoDetectDeps(bot.entry_file, workdir);
        if (detected.length) {
          emit(bot.id, 'system', `🔍 Auto-detected imports: ${detected.join(', ')}`);
          installPythonPackages(workdir, detected.join('\n'));
          emit(bot.id, 'system', '✓ Auto-detected dependencies installed.');
        }
      } else if (lang.installDeps) {
        lang.installDeps(workdir);
      }
      depsInstalled.add(bot.id);
    } catch (e) {
      emit(bot.id, 'system', `⚠ Dependency install warning: ${e.message}`);
      // mark as attempted so we don't loop forever on broken deps
      depsInstalled.add(bot.id);
    }
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
      shell: true,
      windowsHide: true,
    });
  } catch (e) {
    emit(bot.id, 'system', `✕ Failed to spawn ${lang.binary}: ${e.message}`);
    return false;
  }

  const rec = {
    proc,
    pid: proc.pid,
    startedAt: Date.now(),
    autoRestart: !!bot.auto_restart,
    restartCount: 0,
    status: 'starting', // will become 'running' once we confirm it's alive
  };
  running.set(bot.id, rec);

  emit(bot.id, 'system', `▶ Starting [${lang.label}] ${bot.entry_file} (pid ${proc.pid})`);
  store.markStarted(bot.id);

  // Confirm process is alive (check if it hasn't immediately crashed)
  setTimeout(() => {
    const cur = running.get(bot.id);
    if (cur && cur.status === 'starting' && cur.proc && cur.proc.exitCode === null && cur.proc.signalCode === null) {
      cur.status = 'running';
    }
  }, 500);

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
    const msg = err.code === 'ENOENT'
      ? `✕ Command not found: "${lang.binary}". ${bot.language === 'python' ? 'এই সার্ভারে Python ইনস্টল নেই।' : 'Runtime missing.'}`
      : `✕ Process error: ${err.message}`;
    emit(bot.id, 'system', msg);
    const cur = running.get(bot.id);
    if (cur) cur.status = 'stopped';
  });

  proc.on('spawn', () => {
    // 'spawn' event fires when the process has successfully started
    const cur = running.get(bot.id);
    if (cur) cur.status = 'running';
  });

  proc.on('exit', (code, signal) => {
    const cur = running.get(bot.id);
    if (cur) cur.status = 'stopped';
    // Remove from running map after a short delay so the frontend can see 'stopped' status
    setTimeout(() => {
      if (running.has(bot.id)) running.delete(bot.id);
    }, 3000);

    let msg;
    if (signal) {
      msg = `■ Process killed by signal ${signal}`;
    } else if (code === 0) {
      msg = `■ Process exited successfully (code 0)`;
    } else {
      msg = `■ Process exited with error (code ${code}).`;
      // Helpful hints for common failure causes
      if (bot.language === 'python' && (code === 127 || code === 1)) {
        const hasReq = fs.existsSync(path.join(workdir, 'requirements.txt'));
        msg += hasReq
          ? ' সম্ভবত কোনো dependency missing বা স্ক্রিপ্টে error। লগের stderr অংশ দেখুন।'
          : ' সম্ভবত script-এ syntax error বা missing module।';
      }
    }
    emit(bot.id, code === 0 ? 'system' : 'stderr', msg);

    // Optional auto-restart on unexpected crash (not on manual stop / SIGTERM)
    if (cur && cur.autoRestart && code !== 0 && code !== null && signal !== 'SIGTERM') {
      if (cur.restartCount < 5) {
        cur.restartCount++;
        emit(bot.id, 'system', `↻ Auto-restarting in 3s (attempt ${cur.restartCount}/5)...`);
        setTimeout(() => {
          const fresh = store.getBot(bot.id);
          if (fresh) start(fresh, true);
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
  rec.status = 'stopped';
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
