// src/processManager.js — spawn / stop / restart bot subprocesses,
// stream stdout/stderr to DB log buffer and Socket.IO rooms.
//
// Each bot runs as an isolated child_process spawned in its own working dir.
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const store = require('../db/store');
const config = require('./config');
const { LANGUAGES, autoDetectDeps, installPythonPackages, needsSystemInstall } = require('./languages');

// Track bots whose deps are already installed this server lifetime.
// restart করলে সবসময় reinstall হবে (cache clear)
const depsInstalled = new Set();

// botId -> { proc, pid, startedAt, autoRestart, restartCount, status, stopping }
// status: 'stopped' | 'starting' | 'running' | 'stopping'
const running = new Map();

let io = null;

function setIO(socketIO) { io = socketIO; }

function botWorkdir(bot) {
  return path.join(config.usersDir, bot.user_id, bot.dir_name);
}

function emit(botId, stream, text) {
  // persist + push to any connected watchers
  store.appendLog(botId, stream, text);
  if (io) io.to(`bot:${botId}`).emit('log', { botId, stream, text, ts: Date.now() });
  // also emit a status update so frontend can refresh immediately
  if (io) io.to(`bot:${botId}`).emit('status', { botId, ...describeInternal(botId) });
}

function emitStatusUpdate(botId) {
  if (io) io.to(`bot:${botId}`).emit('status', { botId, ...describeInternal(botId) });
}

function statusOf(botId) {
  const r = running.get(botId);
  if (!r) return 'stopped';
  if (r.stopping) return 'stopping';
  if (r.status === 'starting') return 'starting';
  if (!r.proc) return 'stopped';
  if (r.proc.killed) return 'stopped';
  // In Node, exitCode is null while process is still alive
  if (r.proc.exitCode === null && r.proc.signalCode === null) return 'running';
  return 'stopped';
}

function describeInternal(botId) {
  const r = running.get(botId);
  const s = statusOf(botId);
  return {
    status: s === 'stopping' ? 'stopped' : s, // ফ্রন্টেন্ডে stopping কে stopped দেখাই
    pid: r && r.proc && r.proc.pid && (s === 'running') ? r.proc.pid : null,
    startedAt: r ? r.startedAt : null,
    restartCount: r ? r.restartCount : 0,
  };
}

function describe(botId) {
  return describeInternal(botId);
}

// ---------- Pre-flight syntax check ----------
function checkSyntax(bot, workdir, lang) {
  const entryPath = path.join(workdir, bot.entry_file);
  const result = { error: false, lines: [] };

  try {
    if (bot.language === 'python') {
      const pyBin = lang.binary;
      const r = spawnSync(pyBin, ['-m', 'py_compile', bot.entry_file], {
        cwd: workdir,
        encoding: 'utf8',
        timeout: 10000,
        shell: false,  // shell false — args safely passed
      });
      if (r.status !== 0) {
        result.error = true;
        const raw = (r.stderr || r.stdout || '').trim();
        // parse করো: File "...", line N
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        result.lines = lines.map(l => {
          // file path ছোট করো
          return l.replace(/File ".*?([^/\\]+\.py)"/, 'File "$1"');
        });
      }
    } else if (bot.language === 'node') {
      const r = spawnSync(process.execPath, ['--check', bot.entry_file], {
        cwd: workdir,
        encoding: 'utf8',
        timeout: 10000,
      });
      if (r.status !== 0) {
        result.error = true;
        const raw = (r.stderr || r.stdout || '').trim();
        result.lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      }
    }
  } catch (_) {}

  return result;
}

// ---------- Smart error diagnosis ----------
function diagnoseError(exitCode, signal, language, workdir, stderr) {
  if (signal) return null;
  if (!exitCode || exitCode === 0) return null;

  const hints = [];
  const s = (stderr || '').toLowerCase();

  if (language === 'python') {
    if (s.includes('modulenotfounderror') || s.includes('no module named')) {
      const m = stderr.match(/No module named '([^']+)'/i);
      const pkg = m ? m[1].replace('_', '-') : 'unknown';
      hints.push(`💡 Missing module: "${pkg}"`);
      hints.push(`   সমাধান: বটের requirements.txt-এ "${pkg}" যোগ করুন, তারপর 🔄 Reinstall চাপুন।`);
    } else if (s.includes('syntaxerror')) {
      hints.push(`💡 Python Syntax Error — কোডে ভুল আছে।`);
      hints.push(`   সমাধান: 📝 কোড এডিটরে গিয়ে error line ঠিক করুন।`);
    } else if (s.includes('indentationerror')) {
      hints.push(`💡 Indentation Error — space/tab মিলছে না।`);
      hints.push(`   সমাধান: সব জায়গায় একই ধরনের indent ব্যবহার করুন (4 spaces বা tab)।`);
    } else if (s.includes('invalid control character') || s.includes('json.decoder')) {
      hints.push(`💡 JSON/Config Error — env variable বা JSON file-এ invalid character।`);
      hints.push(`   সমাধান: ⚙️ Settings-এ env variables চেক করুন, copy-paste করা text পরিষ্কার করুন।`);
    } else if (s.includes('connection refused') || s.includes('connection error')) {
      hints.push(`💡 Connection Error — external service connect করতে পারছে না।`);
      hints.push(`   সমাধান: API keys ও URLs ⚙️ Settings-এ ঠিকমতো দেওয়া আছে কিনা চেক করুন।`);
    } else if (s.includes('authenticationerror') || s.includes('invalid token') || s.includes('unauthorized')) {
      hints.push(`💡 Authentication Error — API key বা token ভুল।`);
      hints.push(`   সমাধান: ⚙️ Settings-এ সঠিক token/key দিন।`);
    } else if (s.includes('conflict') && s.includes('getupdates')) {
      hints.push(`💡 Telegram Conflict — একই bot token দিয়ে অন্য জায়গায় bot চলছে।`);
      hints.push(`   সমাধান: অন্য সব instance বন্ধ করুন, শুধু এখানে চালান।`);
    } else if (s.includes('permissionerror') || s.includes('permission denied')) {
      hints.push(`💡 Permission Error — ফাইল access করতে পারছে না।`);
    } else if (s.includes('memoryerror') || s.includes('killed') || exitCode === 137) {
      hints.push(`💡 Memory Error — বট অনেক বেশি RAM ব্যবহার করছে।`);
    } else if (exitCode === 1 && !s.includes('error')) {
      hints.push(`💡 বট নিজে থেকে exit করেছে (code 1)। লগের উপরের দিকে error খুঁজুন।`);
    }
  } else if (language === 'node') {
    if (s.includes('cannot find module')) {
      const m = stderr.match(/Cannot find module '([^']+)'/i);
      const pkg = m ? m[1] : 'unknown';
      hints.push(`💡 Missing module: "${pkg}"`);
      hints.push(`   সমাধান: package.json-এ "${pkg}" যোগ করুন।`);
    } else if (s.includes('syntaxerror')) {
      hints.push(`💡 JavaScript Syntax Error — 📝 কোড এডিটরে গিয়ে ঠিক করুন।`);
    }
  }

  return hints.length ? hints : null;
}

// Windows-safe process tree kill
function killProcess(proc) {
  if (!proc) return;
  const pid = proc.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    // Windows: taskkill পুরো process tree সহ বন্ধ করে
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], { timeout: 5000 });
    } catch (_) {}
  } else {
    // Unix: process group kill
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (_) {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch (_) {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
    }, 3000);
  }
}

function start(bot, isAutoRestart = false) {
  // already running?
  const curStatus = statusOf(bot.id);
  if (curStatus === 'running' || curStatus === 'starting') {
    emit(bot.id, 'system', '⚠ বট ইতোমধ্যে চলছে।');
    return false;
  }

  // On manual start/restart, re-check dependencies.
  if (!isAutoRestart) {
    depsInstalled.delete(bot.id);
  }

  const workdir = botWorkdir(bot);
  if (!fs.existsSync(workdir)) {
    emit(bot.id, 'system', `✕ Working directory missing: ${workdir}`);
    return false;
  }
  const entryPath = path.join(workdir, bot.entry_file);
  if (!fs.existsSync(entryPath)) {
    emit(bot.id, 'system', `✕ Entry file not found: ${bot.entry_file}`);
    return false;
  }

  const lang = LANGUAGES[bot.language];
  if (!lang) {
    emit(bot.id, 'system', `✕ Unsupported language: ${bot.language}`);
    return false;
  }

  // Check if the runtime is available BEFORE spawning
  if (typeof lang.available === 'function' && !lang.available()) {
    const msg = bot.language === 'python'
      ? `✕ Python এই সার্ভারে ইনস্টল নেই। nixpacks.toml দেখুন।`
      : `✕ ${lang.label} runtime এই সার্ভারে নেই।`;
    emit(bot.id, 'system', msg);
    return false;
  }

  // ---------- Pre-flight: syntax check (Python / Node) ----------
  try {
    const syntaxResult = checkSyntax(bot, workdir, lang);
    if (syntaxResult.error) {
      emit(bot.id, 'stderr', `✕ Syntax Error — বট চালু হয়নি:`);
      syntaxResult.lines.forEach(l => emit(bot.id, 'stderr', l));
      emit(bot.id, 'system', `💡 কোড এডিটরে গিয়ে error ঠিক করুন, তারপর আবার চালু করুন।`);
      emitStatusUpdate(bot.id);
      return false;
    }
  } catch (_) {
    // syntax check fail হলেও bot চালু করতে দাও
  }

  // ---------- Ensure dependencies are installed ----------
  if (!depsInstalled.has(bot.id)) {
    try {
      if (bot.language === 'python') {
        const depsDir = path.join(workdir, '.deps');

        // ১. .deps-এ যদি system packages (compiled) থাকে সেগুলো সরাও
        //    কারণ --target install করা compiled packages libstdc++ খুঁজে পায় না
        if (fs.existsSync(depsDir)) {
          // system packages-এর সব possible folder names
          const systemPkgDirs = [
            'grpc', 'grpcio', 'grpcio_tools', 'grpcio_status',
            'firebase_admin',
            'google', 'googleapis_common_protos', 'google_auth',
            'google_api_core', 'google_cloud_core', 'google_cloud_firestore',
            'google_cloud_storage', 'googleapiclient', 'google_resumable_media',
            'proto', 'protobuf',
            'numpy', 'numpy.libs', 'numpy_core',
            'pandas', 'pandas_core',
            'scipy', 'scipy.libs',
            'cv2', 'cv2.libs',
            'PIL', 'Pillow', 'Pillow.libs',
            'cryptography', 'cryptography.hazmat',
            'nacl', 'PyNaCl',
            'cffi', 'cffi_backend',
            '_cffi_backend',
            'lxml', 'lxml.libs',
            'psycopg2', 'psycopg2_binary',
            'aiohttp', 'aiohttp.libs',
            'yarl', 'multidict', 'frozenlist', 'aiosignal',
            'pydantic', 'pydantic_core',
            'ujson', 'msgpack', 'orjson',
            'torch', 'tensorflow', 'keras',
            'regex', 'rapidfuzz',
            'charset_normalizer', 'charset_normalizer.libs',
          ];

          try {
            const entries = fs.readdirSync(depsDir);
            for (const entry of entries) {
              // dist-info এবং system package folders মুছো
              const isDistInfo = entry.endsWith('.dist-info') || entry.endsWith('.data');
              const isSystem   = systemPkgDirs.some(d =>
                entry === d || entry.startsWith(d + '-') || entry.startsWith(d + '.')
              );
              if (isDistInfo || isSystem) {
                try {
                  fs.rmSync(path.join(depsDir, entry), { recursive: true, force: true });
                } catch (_) {}
              }
            }
          } catch (_) {}
        }

        // ২. requirements.txt থেকে ইনস্টল
        const reqFile = path.join(workdir, 'requirements.txt');
        if (fs.existsSync(reqFile)) {
          emit(bot.id, 'system', `📦 requirements.txt ইনস্টল হচ্ছে...`);
          const pkgs = fs.readFileSync(reqFile, 'utf8')
            .split('\n').map(l => l.trim())
            .filter(l => l && !l.startsWith('#') && !l.startsWith('-'));
          let failed = [];
          for (const pkg of pkgs) {
            try {
              installPythonPackages(workdir, pkg);
              emit(bot.id, 'system', `  ✓ ${pkg}`);
            } catch (e) {
              failed.push(pkg);
              const errDetail = e.message ? e.message.split('\n').slice(0, 3).join(' | ') : 'unknown';
              emit(bot.id, 'stderr', `  ✕ ${pkg} error: ${errDetail}`);
            }
          }
          if (failed.length === 0) {
            emit(bot.id, 'system', '✓ requirements.txt ইনস্টল সম্পন্ন।');
          }
        }

        // ৩. সব .py ফাইল scan করে অতিরিক্ত package খোঁজো
        const detected = autoDetectDeps(bot.entry_file, workdir);
        const reqPkgs = fs.existsSync(reqFile)
          ? fs.readFileSync(reqFile, 'utf8')
              .split('\n').map(l => l.trim().split(/[=><!\[]/)[0].toLowerCase()).filter(Boolean)
          : [];
        const newPkgs = detected.filter(p => !reqPkgs.includes(p.toLowerCase()));

        if (newPkgs.length) {
          emit(bot.id, 'system', `🔍 অটো-ডিটেক্ট (অতিরিক্ত): ${newPkgs.join(', ')}`);
          for (const pkg of newPkgs) {
            try {
              installPythonPackages(workdir, pkg);
              emit(bot.id, 'system', `  ✓ ${pkg}`);
            } catch (e) {
              const errDetail = e.message ? e.message.split('\n').slice(0, 3).join(' | ') : 'unknown error';
              emit(bot.id, 'stderr', `  ✕ ${pkg} install error: ${errDetail}`);
            }
          }
        }
      } else if (lang.installDeps) {
        lang.installDeps(workdir);
      }
      depsInstalled.add(bot.id);
    } catch (e) {
      emit(bot.id, 'system', `⚠ Dependency install সতর্কতা: ${e.message}`);
      depsInstalled.add(bot.id);
    }
  }

  // Build env: process env + per-bot env
  let env = { ...process.env };
  try {
    const extra = JSON.parse(bot.env_json || '{}');
    // control characters sanitize করো — Firebase/JSON parse error রোধ করো
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === 'string') {
        env[k] = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      } else {
        env[k] = v;
      }
    }
  } catch (_) { /* ignore malformed */ }

  if (bot.language === 'python') {
    const depsDir = path.join(workdir, '.deps');
    if (!fs.existsSync(depsDir)) {
      try { fs.mkdirSync(depsDir, { recursive: true }); } catch (_) {}
    }
    // PYTHONPATH-এ .deps যোগ করো (per-bot pure Python packages)
    // system-wide installed packages (grpc, numpy etc.) Python নিজেই খুঁজে পাবে
    const existing = env.PYTHONPATH ? env.PYTHONPATH.split(path.delimiter) : [];
    if (!existing.includes(depsDir)) {
      env.PYTHONPATH = [depsDir, ...existing].filter(Boolean).join(path.delimiter);
    }
    env.PYTHONUNBUFFERED  = '1';   // real-time log output
    env.PYTHONIOENCODING  = 'utf-8';
    env.PYTHONDONTWRITEBYTECODE = '1';

    // compiled extensions (.so) এর জন্য LD_LIBRARY_PATH inherit করো
    if (process.platform !== 'win32' && process.env.LD_LIBRARY_PATH) {
      env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH;
    }

    // Railway Nix: .deps-এ installed compiled packages-এর .libs folder যোগ করো
    if (process.platform !== 'win32') {
      const depsLibPaths = [];
      try {
        // .deps এর ভেতরে .libs ফোল্ডার খোঁজো (numpy.libs, Pillow.libs ইত্যাদি)
        if (fs.existsSync(depsDir)) {
          for (const entry of fs.readdirSync(depsDir)) {
            if (entry.endsWith('.libs')) {
              depsLibPaths.push(path.join(depsDir, entry));
            }
          }
        }
      } catch (_) {}
      if (depsLibPaths.length) {
        const current = env.LD_LIBRARY_PATH || '';
        env.LD_LIBRARY_PATH = [...depsLibPaths, current].filter(Boolean).join(':');
      }
    }
  }

  let proc;
  try {
    proc = spawn(lang.binary, lang.argsFor(bot.entry_file), {
      cwd: workdir,
      env,
      shell: true,
      windowsHide: true,
      // Windows-এ process group তৈরি করো যাতে পুরো tree kill করা যায়
      detached: process.platform !== 'win32',
    });
  } catch (e) {
    emit(bot.id, 'system', `✕ Spawn করতে ব্যর্থ ${lang.binary}: ${e.message}`);
    return false;
  }

  // Unix-এ detached প্রসেসকে unref না করি — আমরা track করব
  // (unref করলে parent exit হলেও child চলে, কিন্তু আমরা চাই kill করতে পারতে)

  const rec = {
    proc,
    pid: proc.pid,
    startedAt: Date.now(),
    autoRestart: !!bot.auto_restart,
    restartCount: 0,
    status: 'starting',
    stopping: false,
  };
  running.set(bot.id, rec);

  const startMsg = isAutoRestart
    ? `↻ অটো-রিস্টার্ট [${lang.label}] ${bot.entry_file} (pid ${proc.pid})`
    : `▶ বট চালু হচ্ছে [${lang.label}] ${bot.entry_file} (pid ${proc.pid})`;
  emit(bot.id, 'system', startMsg);
  store.markStarted(bot.id);

  // Confirm process is alive after short delay
  setTimeout(() => {
    const cur = running.get(bot.id);
    if (cur && cur.status === 'starting' && cur.proc && cur.proc.exitCode === null && cur.proc.signalCode === null) {
      cur.status = 'running';
      emit(bot.id, 'system', `✓ বট চালু হয়েছে (pid ${proc.pid})`);
      emitStatusUpdate(bot.id);
    }
  }, 800);

  const makeLineBuf = (stream) => {
    let pending = '';
    return (chunk) => {
      pending += chunk.toString();
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx).replace(/\r$/, '');
        pending = pending.slice(idx + 1);
        if (line.length) emit(bot.id, stream, line);
      }
    };
  };

  proc.stdout.on('data', makeLineBuf('stdout'));
  proc.stderr.on('data', makeLineBuf('stderr'));

  proc.on('error', (err) => {
    const msg = err.code === 'ENOENT'
      ? `✕ কমান্ড পাওয়া যায়নি: "${lang.binary}". ${bot.language === 'python' ? 'এই সার্ভারে Python ইনস্টল নেই।' : 'Runtime missing.'}`
      : `✕ প্রসেস এরর: ${err.message}`;
    emit(bot.id, 'system', msg);
    const cur = running.get(bot.id);
    if (cur) cur.status = 'stopped';
    emitStatusUpdate(bot.id);
  });

  proc.on('spawn', () => {
    const cur = running.get(bot.id);
    if (cur && !cur.stopping) cur.status = 'running';
    emitStatusUpdate(bot.id);
  });

  proc.on('exit', (code, signal) => {
    const cur = running.get(bot.id);
    const wasManualStop = cur && cur.stopping;

    running.delete(bot.id);

    let msg;
    if (wasManualStop) {
      msg = `⏹ বট বন্ধ হয়েছে।`;
    } else if (signal) {
      msg = `■ প্রসেস signal দিয়ে বন্ধ হয়েছে: ${signal}`;
    } else if (code === 0) {
      msg = `■ প্রসেস সফলভাবে শেষ হয়েছে (code 0)`;
    } else {
      msg = `■ প্রসেস এরর দিয়ে বন্ধ হয়েছে (code ${code}).`;
    }
    emit(bot.id, wasManualStop ? 'system' : (code === 0 ? 'system' : 'stderr'), msg);

    // Smart diagnosis — helpful hints দেখাও
    if (!wasManualStop && code !== 0 && code !== null) {
      const recentLogs = store.getLogs(bot.id, 0, 500);
      const stderrText = recentLogs
        .filter(l => l.stream === 'stderr')
        .map(l => l.text).join('\n');
      const hints = diagnoseError(code, signal, bot.language, workdir, stderrText);
      if (hints) {
        hints.forEach(h => emit(bot.id, 'system', h));
      }
    }

    emitStatusUpdate(bot.id);

    // Optional auto-restart — manual stop হলে restart করব না
    if (!wasManualStop && cur && cur.autoRestart && code !== 0 && code !== null && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      if ((cur.restartCount || 0) < 5) {
        const nextCount = (cur.restartCount || 0) + 1;
        emit(bot.id, 'system', `↻ অটো-রিস্টার্ট ৩ সেকেন্ড পরে (attempt ${nextCount}/5)...`);
        setTimeout(() => {
          const fresh = store.getBot(bot.id);
          if (fresh) {
            const newRec = running.get(bot.id);
            if (!newRec) {
              start(fresh, true);
              const r = running.get(bot.id);
              if (r) r.restartCount = nextCount;
            }
          }
        }, 3000);
      } else {
        emit(bot.id, 'system', '✕ সর্বোচ্চ অটো-রিস্টার্ট সীমা পৌঁছেছে। বট বন্ধ।');
      }
    }
  });

  return true;
}

function stop(botId) {
  const rec = running.get(botId);

  if (!rec || !rec.proc) {
    emit(botId, 'system', '⚠ বট চলছে না।');
    return false;
  }

  // ইতোমধ্যে বন্ধ প্রসেস
  if (rec.proc.exitCode !== null || rec.proc.signalCode !== null) {
    running.delete(botId);
    emit(botId, 'system', '⏹ বট বন্ধ হয়েছে।');
    emitStatusUpdate(botId);
    return false;
  }

  // manual stop flag — auto-restart এবং exit handler কে জানাই
  rec.stopping = true;
  rec.autoRestart = false;
  rec.status = 'stopping';
  emit(botId, 'system', '⏹ বট বন্ধ করা হচ্ছে...');
  emitStatusUpdate(botId);

  // প্রসেস kill করো
  killProcess(rec.proc);

  // ৫ সেকেন্ড পরেও না মরলে জোর করে সরাও
  setTimeout(() => {
    if (running.has(botId)) {
      running.delete(botId);
      emit(botId, 'system', '⏹ বট বন্ধ হয়েছে (force)।');
      emitStatusUpdate(botId);
    }
  }, 5000);

  return true;
}

function restart(botId) {
  const bot = store.getBot(botId);
  if (!bot) return false;

  // restart-এ সবসময় deps reinstall করো
  depsInstalled.delete(botId);

  const rec = running.get(botId);
  const wasRunning = rec && (statusOf(botId) === 'running' || statusOf(botId) === 'starting');

  emit(botId, 'system', '↻ রিস্টার্ট হচ্ছে...');

  if (wasRunning && rec && rec.proc) {
    // manual stop হিসেবে চিহ্নিত করো (auto-restart রোধ করতে)
    rec.stopping = true;
    rec.autoRestart = false;

    // প্রসেস exit হওয়ার পর start করব
    const onExit = () => {
      running.delete(botId);
      setTimeout(() => {
        const fresh = store.getBot(botId);
        if (fresh) start(fresh, false);
      }, 500);
    };

    rec.proc.once('exit', onExit);
    // exit না হলেও ৩ সেকেন্ড পর জোর করে start
    setTimeout(() => {
      if (running.has(botId) && running.get(botId) === rec) {
        rec.proc.removeListener('exit', onExit);
        running.delete(botId);
      }
      const fresh = store.getBot(botId);
      if (fresh && statusOf(botId) === 'stopped') start(fresh, false);
    }, 3000);

    killProcess(rec.proc);
  } else {
    // বন্ধ ছিল — সরাসরি start করো
    if (rec) running.delete(botId);
    setTimeout(() => {
      const fresh = store.getBot(botId);
      if (fresh) start(fresh, false);
    }, 200);
  }

  return true;
}

function stopAll() {
  for (const [id] of running) stop(id);
}

function clearDepsCache(botId) {
  depsInstalled.delete(botId);
}

module.exports = {
  setIO,
  start, stop, restart, stopAll,
  clearDepsCache,
  status: statusOf,
  describe,
  botWorkdir,
  emit,
};
