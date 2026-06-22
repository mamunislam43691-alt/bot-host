// src/routes/bots.js — bot CRUD + lifecycle: upload, list, start/stop/restart, logs, delete
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const unzipper = require('unzipper');
const archiver = require('archiver');

const store = require('../../db/store');
const config = require('../config');
const pm = require('../processManager');
const { LANGUAGES, detectLanguage, installPythonPackages, autoDetectDeps } = require('../languages');

const router = express.Router();

// ---------- multer: temp storage ----------
const upload = multer({
  dest: path.join(config.dataDir, '_tmp_uploads'),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

function botDirName(botId) { return botId; }

function publicBot(bot) {
  if (!bot) return null;
  return {
    id: bot.id,
    name: bot.name,
    language: bot.language,
    entryFile: bot.entry_file,
    autoRestart: !!bot.auto_restart,
    env: (() => { try { return JSON.parse(bot.env_json); } catch { return {}; } })(),
    createdAt: bot.created_at,
    lastStarted: bot.last_started,
    ...pm.describe(bot.id),
  };
}

function ensureBotOwnedBy(req, res, bot) {
  if (!bot) { res.status(404).json({ error: 'Bot not found' }); return false; }
  if (bot.user_id !== req.user.id && !req.user.is_admin) {
    res.status(403).json({ error: 'Not your bot' });
    return false;
  }
  return true;
}

// ---------- List supported languages (declared before :id) ----------
router.get('/meta/languages', (req, res) => {
  res.json({ languages: Object.fromEntries(
    Object.entries(LANGUAGES).map(([k, v]) => [k, { label: v.label, icon: v.icon, extensions: v.extensions }])
  )});
});

// ---------- List ----------
router.get('/', (req, res) => {
  const bots = req.user.is_admin ? store.getAllBots() : store.getBotsByUser(req.user.id);
  res.json({ bots: bots.map(publicBot) });
});

// ---------- Upload ----------
// Form fields: name, language (optional; auto-detected from filename),
//              autoRestart (0/1), entryFile (optional override),
//              file (single .py/.js/.sh OR .zip)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

    let language = (req.body.language || '').trim();
    const name = (req.body.name || '').trim();
    const autoRestart = String(req.body.autoRestart || '0') === '1' || req.body.autoRestart === true;
    const requirements = (req.body.requirements || '').trim();  // user-supplied deps
    const isZip = req.file.originalname.toLowerCase().endsWith('.zip');

    // Setup directory
    const botId = config.genId();
    const dirName = botDirName(botId);
    const botWorkdir = path.join(config.usersDir, req.user.id, dirName);
    fs.mkdirSync(botWorkdir, { recursive: true });

    let entryFile = req.body.entryFile ? path.basename(req.body.entryFile) : null;
    let finalLanguage = language;

    if (isZip) {
      // Extract zip into workdir
      try {
        await fs.createReadStream(req.file.path)
          .pipe(unzipper.Extract({ path: botWorkdir }))
          .promise();
      } catch (e) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(400).json({ error: 'Invalid or corrupted zip: ' + e.message });
      }

      // Determine entry file: explicit > auto (prefer main.py/index.js/app.py)
      if (!entryFile) {
        const candidates = ['main.py', 'app.py', 'bot.py', 'index.js', 'main.js', 'app.js',
                            'bot.js', 'index.mjs', 'start.py', 'start.js'];
        const allFiles = [];
        const walk = (d, base = '') => {
          for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const rel = base ? `${base}/${ent.name}` : ent.name;
            if (ent.isDirectory()) walk(path.join(d, ent.name), rel);
            else allFiles.push(rel);
          }
        };
        walk(botWorkdir);
        // If zip had a single top-level folder, flatten? Keep structure but search.
        for (const c of candidates) {
          const found = allFiles.find((f) => f === c || f.endsWith('/' + c));
          if (found) { entryFile = found; break; }
        }
        if (!entryFile) {
          const py = allFiles.find((f) => f.endsWith('.py'));
          const js = allFiles.find((f) => f.endsWith('.js') || f.endsWith('.mjs'));
          entryFile = py || js || allFiles[0];
        }
      }
      if (!entryFile) {
        return res.status(400).json({ error: 'Could not determine entry file in zip' });
      }
      // Detect language from chosen entry
      if (!finalLanguage) {
        finalLanguage = detectLanguage(entryFile);
        if (!finalLanguage) return res.status(400).json({ error: 'Could not detect language from entry file' });
      }
    } else {
      // single script file
      const origExt = path.extname(req.file.originalname);
      const safeName = 'main' + origExt;
      const dest = path.join(botWorkdir, safeName);
      fs.renameSync(req.file.path, dest);
      entryFile = safeName;
      if (!finalLanguage) {
        finalLanguage = detectLanguage(req.file.originalname);
        if (!finalLanguage) {
          return res.status(400).json({ error: 'Unsupported file type. Use .py .js .mjs .sh or .zip' });
        }
      }
    }

    // Cleanup temp
    fs.rmSync(req.file.path, { force: true });

    // ---------- Install dependencies ----------
    // Priority: user-supplied "requirements" field > requirements.txt/package.json > auto-detect from imports
    const lang = LANGUAGES[finalLanguage];
    if (lang) {
      // ১) user-supplied requirements (form field থেকে)
      if (requirements && finalLanguage === 'python') {
        try {
          pm.emit(botId, 'system', `📦 Dependencies ইনস্টল হচ্ছে...`);
          const pkgs = requirements.split(/[\n,]/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
          for (const pkg of pkgs) {
            try {
              installPythonPackages(botWorkdir, pkg);
              pm.emit(botId, 'system', `  ✓ ${pkg}`);
            } catch (_) {
              pm.emit(botId, 'system', `  ✕ ${pkg} ইনস্টল ব্যর্থ`);
            }
          }
          pm.emit(botId, 'system', '✓ Dependencies ইনস্টল সম্পন্ন।');
        } catch (e) {
          pm.emit(botId, 'system', `⚠ Dependency install সতর্কতা: ${e.message}`);
        }
      } else if (lang.installDeps) {
        // ২) requirements.txt / package.json থেকে
        try {
          pm.emit(botId, 'system', `📦 ${lang.label} dependencies ইনস্টল হচ্ছে...`);
          lang.installDeps(botWorkdir);
          pm.emit(botId, 'system', '✓ Dependencies ইনস্টল সম্পন্ন।');
        } catch (e) {
          pm.emit(botId, 'system', `⚠ Dependency install সতর্কতা: ${e.message}`);
        }
      }

      // ৩) Python: সব .py ফাইল scan করে অতিরিক্ত package খোঁজো
      if (finalLanguage === 'python') {
        try {
          const detected = autoDetectDeps(entryFile, botWorkdir);
          const reqPkgs = requirements
            ? requirements.split(/[\n,]/).map(s => s.trim().split(/[=><!\[]/)[0].toLowerCase()).filter(Boolean)
            : [];
          const newPkgs = detected.filter(p => !reqPkgs.includes(p.toLowerCase()));
          if (newPkgs.length) {
            pm.emit(botId, 'system', `🔍 অটো-ডিটেক্ট (অতিরিক্ত): ${newPkgs.join(', ')}`);
            for (const pkg of newPkgs) {
              try {
                installPythonPackages(botWorkdir, pkg);
                pm.emit(botId, 'system', `  ✓ ${pkg}`);
              } catch (_) {
                pm.emit(botId, 'system', `  ✕ ${pkg} — pip-এ নেই বা ভিন্ন নামে আছে`);
              }
            }
          }
        } catch (e) {
          pm.emit(botId, 'system', `⚠ অটো-ডিটেক্ট সতর্কতা: ${e.message}`);
        }
      }
    }

    // Persist bot
    const env = {};
    const bot = store.createBot({
      userId: req.user.id,
      name: name || path.basename(entryFile),
      language: finalLanguage,
      entryFile,
      dirName,
      autoRestart,
      env,
    });

    res.json({ bot: publicBot(bot), message: 'Uploaded successfully' });
  } catch (e) {
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// ---------- Detail ----------
router.get('/:id', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  res.json({ bot: publicBot(bot) });
});

// ---------- Update settings (env, autoRestart, name) ----------
router.patch('/:id', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  const { autoRestart, env, name } = req.body || {};

  let envObj;
  try {
    envObj = env !== undefined
      ? (typeof env === 'string' ? JSON.parse(env) : env)
      : JSON.parse(bot.env_json || '{}');
    // env values sanitize — control characters বাদ দাও (Firebase JSON error রোধ করো)
    for (const [k, v] of Object.entries(envObj)) {
      if (typeof v === 'string') {
        envObj[k] = v.replace(/[\x00-\x1F\x7F]/g, ''); // control chars strip
      }
    }
  } catch {
    return res.status(400).json({ error: 'Invalid env JSON' });
  }

  const ar = autoRestart !== undefined ? !!autoRestart : !!bot.auto_restart;
  store.updateBotSettings(bot.id, envObj, ar);
  if (name !== undefined && String(name).trim()) {
    store.updateBotName(bot.id, String(name).trim().slice(0, 100));
  }
  res.json({ bot: publicBot(store.getBot(bot.id)) });
});

// ---------- Lifecycle ----------
router.post('/:id/start', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  const ok = pm.start(bot);
  res.json({ ok, bot: publicBot(bot) });
});

router.post('/:id/stop', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  const ok = pm.stop(bot.id);
  res.json({ ok, bot: publicBot(bot) });
});

router.post('/:id/restart', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  pm.restart(bot.id);
  res.json({ ok: true, bot: publicBot(bot) });
});

// ---------- Force reinstall deps + restart ----------
// .deps clean করে সব package নতুন করে install করবে
router.post('/:id/reinstall', async (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;

  const workdir = pm.botWorkdir(bot);
  const depsDir = require('path').join(workdir, '.deps');

  // bot বন্ধ করো
  pm.stop(bot.id);

  // .deps পুরো মুছে দাও
  try {
    if (fs.existsSync(depsDir)) {
      fs.rmSync(depsDir, { recursive: true, force: true });
      pm.emit(bot.id, 'system', '🧹 .deps folder মুছা হয়েছে, নতুন install শুরু হবে।');
    }
  } catch (e) {
    pm.emit(bot.id, 'system', `⚠ .deps মুছতে সমস্যা: ${e.message}`);
  }

  // processManager-এর depsInstalled cache থেকেও সরাও
  pm.clearDepsCache(bot.id);

  // restart → এবার সব নতুন করে install হবে
  await new Promise(r => setTimeout(r, 500));
  const fresh = store.getBot(bot.id);
  if (fresh) pm.start(fresh);

  res.json({ ok: true, message: 'Dependencies পুনরায় install হচ্ছে', bot: publicBot(bot) });
});

// ---------- Logs ----------
router.get('/:id/logs', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  const afterId = parseInt(req.query.after || '0', 10) || 0;
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 10000);
  res.json({ logs: store.getLogs(bot.id, afterId, limit) });
});

router.get('/:id/logs/download', (req, res) => {
  // Allow token via query for direct window.open access
  if (req.query.token && !req.user) {
    const jwt = require('jsonwebtoken');
    try {
      const payload = jwt.verify(req.query.token, config.jwtSecret);
      req.user = store.getUserById(payload.sub);
    } catch (e) {
      return res.status(401).send('Unauthorized');
    }
  }
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;

  const logs = store.getLogs(bot.id, 0, 10000);
  const text = logs.map((l) => {
    const t = new Date(l.ts).toISOString().replace('T', ' ').substring(0, 19);
    return `[${t}] ${l.text}`;
  }).join('\n');

  res.setHeader('Content-disposition', `attachment; filename=logs-${bot.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`);
  res.setHeader('Content-type', 'text/plain');
  res.send(text);
});

router.delete('/:id/logs', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  store.clearLogs(bot.id);
  res.json({ ok: true });
});

// ---------- Download Bot Files ----------
router.get('/:id/download', (req, res) => {
  if (req.query.token && !req.user) {
    const jwt = require('jsonwebtoken');
    try {
      const payload = jwt.verify(req.query.token, config.jwtSecret);
      req.user = store.getUserById(payload.sub);
    } catch (e) {
      return res.status(401).send('Unauthorized');
    }
  }
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;

  const wd = pm.botWorkdir(bot);
  if (!fs.existsSync(wd)) return res.status(404).send('Bot files not found');

  res.setHeader('Content-disposition', `attachment; filename=bot-${bot.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.zip`);
  res.setHeader('Content-type', 'application/zip');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => res.status(500).send({ error: err.message }));
  archive.pipe(res);
  archive.directory(wd, false);
  archive.finalize();
});

// ---------- File Editor ----------
router.get('/:id/files', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  const wd = pm.botWorkdir(bot);
  if (!fs.existsSync(wd)) return res.json({ files: [] });

  if (req.query.file) {
    const filePath = path.join(wd, req.query.file);
    if (!filePath.startsWith(wd)) return res.status(403).json({ error: 'Invalid path' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    try {
      return res.json({ content: fs.readFileSync(filePath, 'utf8') });
    } catch (e) {
      return res.status(500).json({ error: 'Cannot read file' });
    }
  }

  const allFiles = [];
  const walk = (d, base = '') => {
    try {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (['.deps', '__pycache__', 'node_modules', '.git'].includes(ent.name)) continue;
        const rel = base ? `${base}/${ent.name}` : ent.name;
        if (ent.isDirectory()) walk(path.join(d, ent.name), rel);
        else allFiles.push(rel);
      }
    } catch (_) {}
  };
  walk(wd);
  res.json({ files: allFiles });
});

router.put('/:id/files', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  const wd = pm.botWorkdir(bot);
  const target = req.body.file;
  const content = req.body.content || '';
  if (!target) return res.status(400).json({ error: 'File path required' });
  
  const filePath = path.join(wd, target);
  if (!filePath.startsWith(wd)) return res.status(403).json({ error: 'Invalid path' });
  
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Write failed: ' + e.message });
  }
});

// ---------- Delete ----------
router.delete('/:id', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  pm.stop(bot.id);
  // Remove files
  const wd = pm.botWorkdir(bot);
  try { fs.rmSync(wd, { recursive: true, force: true }); } catch (_) {}
  store.clearLogs(bot.id);
  store.deleteBotRow(bot.id);
  res.json({ ok: true });
});

module.exports = router;
