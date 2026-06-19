// src/routes/deploy.js — single-call deploy endpoint for CI/scripts:
//   POST /api/deploy  (multipart)
//     Headers: X-API-Key: <key>   (or Authorization: Bearer <jwt>)
//     Body (multipart/form-data):
//       file:         <script or .zip>     (required)
//       name:         <bot name>           (optional)
//       language:     python|node|bash     (optional, auto-detected)
//       autoRestart:  1|0                  (optional)
//       entryFile:    <override>           (optional)
//       start:        1|0                  (default 1)
//       env_KEY:      <value>              (any env_KEY field becomes env var)
//
// Returns the bot id, status, and the live base URL.
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
const upload = multer({
  dest: path.join(config.dataDir, '_tmp_uploads'),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

    const language = (req.body.language || '').trim();
    const name = (req.body.name || '').trim();
    const autoRestart = String(req.body.autoRestart || '0') === '1';
    const shouldStart = String(req.body.start ?? '1') !== '0';
    const isZip = req.file.originalname.toLowerCase().endsWith('.zip');

    // collect env vars from env_* fields
    const env = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (k.startsWith('env_') && k.length > 4) env[k.slice(4)] = String(v);
    }

    const botId = config.genId();
    const dirName = botId;
    const botWorkdir = path.join(config.usersDir, req.user.id, dirName);
    fs.mkdirSync(botWorkdir, { recursive: true });

    let entryFile = req.body.entryFile ? path.basename(req.body.entryFile) : null;
    let finalLanguage = language;

    if (isZip) {
      await fs.createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: botWorkdir }))
        .promise();
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
        for (const c of candidates) {
          const f = allFiles.find((x) => x === c || x.endsWith('/' + c));
          if (f) { entryFile = f; break; }
        }
        if (!entryFile) {
          const py = allFiles.find((f) => f.endsWith('.py'));
          const js = allFiles.find((f) => f.endsWith('.js') || f.endsWith('.mjs'));
          entryFile = py || js || allFiles[0];
        }
      }
      if (!entryFile) return res.status(400).json({ error: 'Could not determine entry file in zip' });
      if (!finalLanguage) {
        finalLanguage = detectLanguage(entryFile);
        if (!finalLanguage) return res.status(400).json({ error: 'Could not detect language' });
      }
    } else {
      const origExt = path.extname(req.file.originalname);
      const safeName = 'main' + origExt;
      fs.renameSync(req.file.path, path.join(botWorkdir, safeName));
      entryFile = safeName;
      if (!finalLanguage) {
        finalLanguage = detectLanguage(req.file.originalname);
        if (!finalLanguage) {
          return res.status(400).json({ error: 'Unsupported file type. Use .py .js .mjs .sh or .zip' });
        }
      }
    }
    fs.rmSync(req.file.path, { force: true });

    // Install deps
    const lang = LANGUAGES[finalLanguage];
    if (lang && lang.installDeps) {
      try { lang.installDeps(botWorkdir); } catch (e) {
        pm.emit(botId, 'system', `Dependency install warning: ${e.message}`);
      }
    }

    const bot = store.createBot({
      userId: req.user.id,
      name: name || path.basename(entryFile),
      language: finalLanguage,
      entryFile,
      dirName,
      autoRestart,
      env,
    });

    if (shouldStart) pm.start(bot);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = `${protocol}://${req.get('host')}`;
    res.json({
      ok: true,
      bot: {
        id: bot.id,
        name: bot.name,
        language: bot.language,
        entryFile: bot.entry_file,
        ...pm.describe(bot.id),
      },
      baseUrl,
      manageUrl: `${baseUrl}/#/dashboard`,
      logsUrl: `${baseUrl}/api/bots/${bot.id}/logs`,
    });
  } catch (e) {
    res.status(500).json({ error: 'Deploy failed: ' + e.message });
  }
});

module.exports = router;
