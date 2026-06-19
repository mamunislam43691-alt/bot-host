// src/languages.js — runtime configuration per supported language
// Each entry describes how to RUN a script and how to INSTALL deps.
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- Python binary resolution ----------
// Railway/Linux: python3, python  |  Windows: python, py
// We probe at module-load time and cache the working path.
let _pythonBin = null;
function findPython() {
  if (_pythonBin) return _pythonBin;
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
  for (const bin of candidates) {
    try {
      execSync(`${bin} --version`, { stdio: 'pipe', shell: true, timeout: 5000 });
      _pythonBin = bin;
      return bin;
    } catch (_) { /* try next */ }
  }
  return null;
}

// Install a list of pip packages (newline/comma separated) into a workdir.
function installPythonPackages(workdir, depsString) {
  const bin = findPython();
  if (!bin) throw new Error('Python is not installed on the server');
  const pkgs = String(depsString || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pkgs.length) return;
  execFileSync(bin, ['-m', 'pip', 'install', '--no-cache-dir', '--disable-pip-version-check', ...pkgs], {
    cwd: workdir, stdio: 'pipe', timeout: 5 * 60 * 1000, shell: true,
  });
}

// Common Python imports -> PyPI package names (auto-detect missing deps).
// Covers most popular bot/library imports.
const IMPORT_TO_PIP = {
  telebot: 'pyTelegramBotAPI',
  telethon: 'telethon',
  pyrogram: 'pyrogram',
  discord: 'discord.py',
  requests: 'requests',
  flask: 'flask',
  fastapi: 'fastapi',
  aiohttp: 'aiohttp',
  selenium: 'selenium',
  bs4: 'beautifulsoup4',
  pandas: 'pandas',
  numpy: 'numpy',
  pillow: 'pillow',
  cv2: 'opencv-python',
  pyttsx3: 'pyttsx3',
  gtts: 'gTTS',
  yt_dlp: 'yt-dlp',
  youtube_dl: 'youtube-dl',
  instaloader: 'instaloader',
  psutil: 'psutil',
  schedule: 'schedule',
  'praw': 'praw',
  'pymongo': 'pymongo',
  'redis': 'redis',
  'matplotlib': 'matplotlib',
  'requests_html': 'requests-html',
  'undetected_chromedriver': 'undetected-chromedriver',
  'pyautogui': 'pyautogui',
  'pyqrcode': 'pyqrcode',
  'qrcode': 'qrcode',
  'wikipedia': 'wikipedia',
  'googlesearch': 'googlesearch-python',
  'speedtest': 'speedtest-cli',
  'ping3': 'ping3',
  'emoji': 'emoji',
};

// Scan a Python source file for top-level imports and suggest pip packages.
function autoDetectDeps(entryFile, workdir) {
  const fullPath = path.join(workdir, entryFile);
  if (!fs.existsSync(fullPath)) return [];
  let src = '';
  try { src = fs.readFileSync(fullPath, 'utf8'); } catch (_) { return []; }
  const found = new Set();
  const importRe = /^\s*(?:from\s+([a-zA-Z0-9_]+)|import\s+([a-zA-Z0-9_]+))/gm;
  let m;
  while ((m = importRe.exec(src))) {
    const mod = m[1] || m[2];
    if (!mod) continue;
    // skip stdlib-ish & local modules (very rough heuristic)
    if (['os', 'sys', 'time', 'json', 're', 'math', 'random', 'datetime',
         'threading', 'subprocess', 'pathlib', 'logging', 'asyncio', 'io',
         'collections', 'itertools', 'functools', 'typing', 'traceback',
         'shutil', 'glob', 'socket', 'struct', 'base64', 'hashlib', 'hmac',
         'urllib', 'http', 'email', 'csv', 'sqlite3', 'queue', 'signal',
         'argparse', 'platform', 'inspect', 'copy', 'decimal', 'fractions',
         'statistics', 'string', 'textwrap', 'unicodedata', 'uuid', 'xml',
         'configparser', 'tempfile', 'getpass', 'codecs', 'enum', 'abc',
         'dataclasses', 'contextlib', 'concurrent', 'multiprocessing'].includes(mod)) continue;
    if (IMPORT_TO_PIP[mod]) found.add(IMPORT_TO_PIP[mod]);
  }
  return Array.from(found);
}

function nodeBin() { return process.execPath; }

const LANGUAGES = {
  python: {
    label: 'Python',
    icon: '🐍',
    extensions: ['.py'],
    get binary() { return findPython() || 'python3'; },
    argsFor: (entry) => ['-u', entry],   // -u = unbuffered (real-time logs)
    depsFile: 'requirements.txt',
    available: () => !!findPython(),
    installDeps: (workdir) => {
      const bin = findPython();
      if (!bin) throw new Error('Python is not installed on the server');
      const req = path.join(workdir, 'requirements.txt');
      if (fs.existsSync(req)) {
        execFileSync(bin, ['-m', 'pip', 'install', '--no-cache-dir', '-r', 'requirements.txt'], {
          cwd: workdir, stdio: 'pipe', timeout: 5 * 60 * 1000, shell: true,
        });
      }
    },
  },
  node: {
    label: 'Node.js',
    icon: '🟢',
    extensions: ['.js', '.mjs'],
    binary: nodeBin(),
    argsFor: (entry) => [entry],
    depsFile: 'package.json',
    available: () => true,
    installDeps: (workdir) => {
      if (fs.existsSync(path.join(workdir, 'package.json'))) {
        execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
          cwd: workdir, stdio: 'pipe', shell: true, timeout: 5 * 60 * 1000,
        });
      }
    },
  },
  bash: {
    label: 'Bash / Shell',
    icon: '💻',
    extensions: ['.sh'],
    binary: 'bash',
    argsFor: (entry) => [entry],
    depsFile: null,
    available: () => process.platform !== 'win32',
    installDeps: () => {},
  },
};

function detectLanguage(filename) {
  const ext = path.extname(filename).toLowerCase();
  for (const [key, lang] of Object.entries(LANGUAGES)) {
    if (lang.extensions.includes(ext)) return key;
  }
  return null;
}

module.exports = { LANGUAGES, detectLanguage, findPython, installPythonPackages, autoDetectDeps };
