// src/routes/deploy.js — single-call deploy endpoint for CI/scripts:
//
//   POST /api/deploy  (multipart/form-data)
//   Headers: X-API-Key: <your_api_key>
//            OR Authorization: Bearer <jwt_token>
//
//   Body fields:
//     file         : <script.py / script.js / script.sh / bundle.zip>  [required]
//     name         : বটের নাম                                           [optional]
//     language     : python | node | bash                               [optional, auto-detected]
//     autoRestart  : 1 | 0   (ক্র্যাশ হলে অটো-রিস্টার্ট)               [default: 0]
//     entryFile    : zip-এর ভেতরে entry file override                   [optional]
//     start        : 1 | 0   (deploy করেই চালু করবে?)                   [default: 1]
//     requirements : pip packages, প্রতি লাইনে একটা                     [optional]
//     env_TOKEN    : বটের env variable (env_ prefix দিয়ে যেকোনো নাম)   [optional]
//
//   Response:
//     {
//       ok: true,
//       bot: { id, name, language, entryFile, status, pid, ... },
//       botId: "<uuid>",           ← এই ID দিয়ে বট কন্ট্রোল করুন
//       apiKey: "<your_key>",      ← আপনার API Key
//       baseUrl: "https://...",
//       endpoints: {               ← সব API endpoint ready-to-use
//         list, detail, start, stop, restart, logs, delete, update, files
//       }
//     }

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const unzipper = require('unzipper');

const store = require('../../db/store');
const config = require('../config');
const pm = require('../processManager');
const { LANGUAGES, detectLanguage, installPythonPackages, autoDetectDeps } = require('../languages');

const router = express.Router();
const upload = multer({
  dest: path.join(config.dataDir, '_tmp_uploads'),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
});

// বট ID থেকে সব API endpoint তৈরি করো
function buildEndpoints(baseUrl, botId, apiKey) {
  const h = `X-API-Key: ${apiKey}`;
  const base = `${baseUrl}/api/bots/${botId}`;
  return {
    detail:  { method: 'GET',    url: `${base}`,         header: h, desc: 'বটের তথ্য দেখুন' },
    start:   { method: 'POST',   url: `${base}/start`,   header: h, desc: 'বট চালু করুন' },
    stop:    { method: 'POST',   url: `${base}/stop`,    header: h, desc: 'বট বন্ধ করুন' },
    restart: { method: 'POST',   url: `${base}/restart`, header: h, desc: 'বট রিস্টার্ট করুন' },
    logs:    { method: 'GET',    url: `${base}/logs`,    header: h, desc: 'লগ দেখুন' },
    delete:  { method: 'DELETE', url: `${base}`,         header: h, desc: 'বট ডিলিট করুন' },
    update:  { method: 'PATCH',  url: `${base}`,         header: h, desc: 'সেটিংস আপডেট করুন', body: '{"name":"...", "autoRestart":true, "env":{"TOKEN":"..."}}' },
    files:   { method: 'GET',    url: `${base}/files`,   header: h, desc: 'ফাইল লিস্ট দেখুন' },
    list:    { method: 'GET',    url: `${baseUrl}/api/bots`, header: h, desc: 'সব বটের লিস্ট' },
  };
}

// ---------- Deploy ----------
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

    const language    = (req.body.language || '').trim();
    const name        = (req.body.name || '').trim();
    const autoRestart = String(req.body.autoRestart || '0') === '1';
    const shouldStart = String(req.body.start ?? '1') !== '0';
    const isZip       = req.file.originalname.toLowerCase().endsWith('.zip');

    // env_* fields → env object
    const env = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (k.startsWith('env_') && k.length > 4) env[k.slice(4)] = String(v);
    }

    const botId      = config.genId();
    const dirName    = botId;
    const botWorkdir = path.join(config.usersDir, req.user.id, dirName);
    fs.mkdirSync(botWorkdir, { recursive: true });

    let entryFile    = req.body.entryFile ? path.basename(req.body.entryFile) : null;
    let finalLanguage = language;

    if (isZip) {
      try {
        await fs.createReadStream(req.file.path)
          .pipe(unzipper.Extract({ path: botWorkdir }))
          .promise();
      } catch (e) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(400).json({ error: 'Invalid or corrupted zip: ' + e.message });
      }

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
        if (!finalLanguage) return res.status(400).json({ error: 'Could not detect language from entry file' });
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

    // ---------- Install dependencies ----------
    const requirements = (req.body.requirements || '').trim();
    const lang = LANGUAGES[finalLanguage];
    if (lang) {
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
        try {
          lang.installDeps(botWorkdir);
        } catch (e) {
          pm.emit(botId, 'system', `⚠ Dependency install সতর্কতা: ${e.message}`);
        }
      }
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
    const baseUrl   = `${protocol}://${req.get('host')}`;
    const apiKey    = req.user.api_key;

    res.json({
      ok: true,
      message: shouldStart ? 'বট deploy ও চালু হয়েছে' : 'বট deploy হয়েছে (চালু হয়নি)',
      botId: bot.id,                         // ← এই ID দিয়ে সব API কল করুন
      apiKey,                                // ← Header-এ X-API-Key হিসেবে ব্যবহার করুন
      bot: {
        id:        bot.id,
        name:      bot.name,
        language:  bot.language,
        entryFile: bot.entry_file,
        autoRestart: !!bot.auto_restart,
        ...pm.describe(bot.id),
      },
      baseUrl,
      manageUrl:  `${baseUrl}/#/dashboard`,
      endpoints: buildEndpoints(baseUrl, bot.id, apiKey),
    });
  } catch (e) {
    res.status(500).json({ error: 'Deploy ব্যর্থ: ' + e.message });
  }
});

// ---------- Re-deploy: কোড আপডেট করে restart ----------
// POST /api/deploy/:id/update  (নতুন ফাইল দিয়ে বট আপডেট করুন, বট অটো-রিস্টার্ট হবে)
router.post('/:id/update', upload.single('file'), async (req, res) => {
  try {
    const bot = store.getBot(req.params.id);
    if (!bot) return res.status(404).json({ error: 'বট পাওয়া যায়নি' });
    if (bot.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ error: 'এই বটটি আপনার নয়' });
    }

    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });

    const workdir = pm.botWorkdir(bot);
    const isZip   = req.file.originalname.toLowerCase().endsWith('.zip');

    pm.emit(bot.id, 'system', `📦 কোড আপডেট হচ্ছে...`);

    if (isZip) {
      // পুরনো ফাইল মুছে নতুন extract করো (.deps ফোল্ডার রাখো)
      for (const ent of fs.readdirSync(workdir)) {
        if (ent === '.deps') continue;
        fs.rmSync(path.join(workdir, ent), { recursive: true, force: true });
      }
      try {
        await fs.createReadStream(req.file.path)
          .pipe(unzipper.Extract({ path: workdir }))
          .promise();
      } catch (e) {
        fs.rmSync(req.file.path, { force: true });
        return res.status(400).json({ error: 'Invalid zip: ' + e.message });
      }
    } else {
      // single file — entry file-কে overwrite করো
      const dest = path.join(workdir, bot.entry_file);
      fs.renameSync(req.file.path, dest);
    }
    fs.rmSync(req.file.path, { force: true });

    pm.emit(bot.id, 'system', '✓ কোড আপডেট হয়েছে। রিস্টার্ট হচ্ছে...');

    // বট রিস্টার্ট করো
    pm.restart(bot.id);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl   = `${protocol}://${req.get('host')}`;
    const apiKey    = req.user.api_key;

    res.json({
      ok: true,
      message: 'কোড আপডেট হয়েছে, বট রিস্টার্ট হচ্ছে',
      botId: bot.id,
      bot: {
        id:        bot.id,
        name:      bot.name,
        language:  bot.language,
        entryFile: bot.entry_file,
        ...pm.describe(bot.id),
      },
      endpoints: buildEndpoints(baseUrl, bot.id, apiKey),
    });
  } catch (e) {
    res.status(500).json({ error: 'আপডেট ব্যর্থ: ' + e.message });
  }
});

module.exports = router;
