// src/routes/bots.js — bot CRUD + lifecycle: upload, list, start/stop/restart, logs, delete
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const unzipper = require('unzipper');

const store = require('../../db/store');
const config = require('../config');
const pm = require('../processManager');
const { LANGUAGES, detectLanguage } = require('../languages');

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

    // Install dependencies if present
    const lang = LANGUAGES[finalLanguage];
    if (lang && lang.installDeps) {
      try {
        pm.emit(botId, 'system', `Installing dependencies for ${lang.label}...`);
        lang.installDeps(botWorkdir);
        pm.emit(botId, 'system', 'Dependencies installed.');
      } catch (e) {
        pm.emit(botId, 'system', `Dependency install warning: ${e.message}`);
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
  const envObj = env !== undefined ? (typeof env === 'string' ? JSON.parse(env) : env) : JSON.parse(bot.env_json);
  const ar = autoRestart !== undefined ? !!autoRestart : !!bot.auto_restart;
  store.updateBotSettings(bot.id, envObj, ar);
  if (name !== undefined) {
    store.db.prepare('UPDATE bots SET name = ? WHERE id = ?').run(String(name).trim() || bot.name, bot.id);
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

// ---------- Logs ----------
router.get('/:id/logs', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  const afterId = parseInt(req.query.after || '0', 10) || 0;
  const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 5000);
  res.json({ logs: store.getLogs(bot.id, afterId, limit) });
});

router.delete('/:id/logs', (req, res) => {
  const bot = store.getBot(req.params.id);
  if (!ensureBotOwnedBy(req, res, bot)) return;
  store.clearLogs(bot.id);
  res.json({ ok: true });
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
