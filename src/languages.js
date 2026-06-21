// src/languages.js — runtime configuration per supported language
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- Python binary resolution ----------
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
    } catch (_) {}
  }
  return null;
}

function runPipInstall(workdir, argsStr) {
  // Railway Nix-এ python3 -m pip সবচেয়ে reliable
  // pip3/pip PATH-এ নাও থাকতে পারে
  const cmds = [
    `python3 -m pip install ${argsStr}`,
    `python -m pip install ${argsStr}`,
    `pip3 install ${argsStr}`,
    `pip install ${argsStr}`,
  ];

  let lastErr = null;
  for (const cmd of cmds) {
    try {
      execSync(cmd, {
        cwd: workdir,
        stdio: 'pipe',
        timeout: 10 * 60 * 1000,
        shell: true,
      });
      return; // সফল হলে বের হয়ে যাও
    } catch (e) {
      lastErr = e;
      // পরের command চেষ্টা করো
    }
  }
  // সব fail হলে error throw করো
  const errMsg = lastErr && lastErr.stderr
    ? lastErr.stderr.toString().slice(0, 300)
    : (lastErr ? lastErr.message : 'pip install failed');
  throw new Error(errMsg);
}

// compiled packages (C extensions) যাদের --target দিলে কাজ করে না
const SYSTEM_INSTALL_PKGS = new Set([
  'grpcio', 'grpcio-tools', 'grpc',
  'firebase-admin',
  'google-cloud-firestore', 'google-cloud-storage', 'google-cloud-bigquery',
  'google-api-python-client', 'google-auth', 'google-auth-oauthlib',
  'tensorflow', 'torch', 'torchvision', 'torchaudio',
  'numpy', 'scipy', 'pandas',
  'opencv-python', 'opencv-python-headless', 'cv2',
  'scikit-learn', 'sklearn',
  'Pillow', 'pillow',
  'lxml',
  'cryptography',
  'PyNaCl', 'nacl',
  'psycopg2', 'psycopg2-binary',
  'mysqlclient',
  'ujson',
  'msgpack',
  'pydantic',
  'aiohttp',
  'httptools',
  'uvloop',
  'websockets',
  'yarl',
  'multidict',
  'charset-normalizer',
  'MarkupSafe',
  'pyzmq', 'zmq',
  'Cython',
  'cffi',
  'regex',
  'rapidfuzz',
  'orjson',
  'frozenlist',
  'aiosignal',
]);

function needsSystemInstall(pkg) {
  // package name থেকে version/extras বাদ দাও
  const base = pkg.replace(/\[.*\]/, '').split(/[=><!\s]/)[0].trim();
  return SYSTEM_INSTALL_PKGS.has(base) || SYSTEM_INSTALL_PKGS.has(base.toLowerCase());
}

function installPythonPackages(workdir, depsString) {
  const pkgs = String(depsString || '')
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !s.startsWith('#'));
  if (!pkgs.length) return;

  const depsDir = path.join(workdir, '.deps');
  if (!fs.existsSync(depsDir)) fs.mkdirSync(depsDir, { recursive: true });

  const systemPkgs = pkgs.filter(p => needsSystemInstall(p));
  const localPkgs  = pkgs.filter(p => !needsSystemInstall(p));

  // system-wide install (compiled packages)
  if (systemPkgs.length) {
    const quoted = systemPkgs.map(p => `"${p}"`).join(' ');
    try {
      runPipInstall(workdir, `--no-cache-dir --disable-pip-version-check --quiet ${quoted}`);
    } catch (e) {
      // system install fail → .deps-এ fallback করো
      // (কিছু environment-এ system-wide write permission নেই)
      runPipInstall(workdir, `--target "${depsDir}" --no-cache-dir --disable-pip-version-check --quiet ${quoted}`);
    }
  }

  // .deps install (pure Python packages)
  if (localPkgs.length) {
    const quoted = localPkgs.map(p => `"${p}"`).join(' ');
    runPipInstall(workdir, `--target "${depsDir}" --no-cache-dir --disable-pip-version-check --quiet ${quoted}`);
  }
}

// =============================================================
// Import নাম → PyPI package নাম mapping
// (import করার নাম আর pip install করার নাম আলাদা হলে এখানে লিখতে হয়)
// =============================================================
const IMPORT_TO_PIP = {
  // --- Telegram ---
  telebot:               'pyTelegramBotAPI',
  telegram:              'python-telegram-bot',
  aiogram:               'aiogram',
  telethon:              'telethon',
  pyrogram:              'pyrogram',
  hydrogram:             'hydrogram',
  tgcrypto:              'tgcrypto',

  // --- Discord / Social ---
  discord:               'discord.py',
  nextcord:              'nextcord',
  hikari:                'hikari',
  slack_sdk:             'slack-sdk',
  slack_bolt:            'slack-bolt',
  tweepy:                'tweepy',
  instaloader:           'instaloader',
  instagrapi:            'instagrapi',
  praw:                  'praw',
  asyncpraw:             'asyncpraw',
  facebook:              'facebook-sdk',

  // --- HTTP / Web ---
  requests:              'requests',
  httpx:                 'httpx',
  aiohttp:               'aiohttp',
  httplib2:              'httplib2',
  urllib3:               'urllib3',
  websocket:             'websocket-client',
  websockets:            'websockets',
  grpc:                  'grpcio',

  // --- Web Frameworks ---
  flask:                 'flask',
  fastapi:               'fastapi',
  uvicorn:               'uvicorn',
  starlette:             'starlette',
  django:                'django',
  tornado:               'tornado',
  bottle:                'bottle',
  sanic:                 'sanic',
  quart:                 'quart',
  litestar:              'litestar',

  // --- Database ---
  pymongo:               'pymongo',
  motor:                 'motor',
  redis:                 'redis',
  aioredis:              'aioredis',
  psycopg2:              'psycopg2-binary',
  psycopg:               'psycopg',
  pymysql:               'PyMySQL',
  mysql:                 'mysql-connector-python',
  sqlalchemy:            'SQLAlchemy',
  tortoise:              'tortoise-orm',
  peewee:                'peewee',
  tinydb:                'tinydb',
  databases:             'databases',
  elasticsearch:         'elasticsearch',

  // --- Environment / Config ---
  dotenv:                'python-dotenv',
  decouple:              'python-decouple',
  dynaconf:              'dynaconf',
  pydantic:              'pydantic',
  pydantic_settings:     'pydantic-settings',
  environs:              'environs',

  // --- Data Science / ML ---
  numpy:                 'numpy',
  pandas:                'pandas',
  scipy:                 'scipy',
  sklearn:               'scikit-learn',
  matplotlib:            'matplotlib',
  seaborn:               'seaborn',
  plotly:                'plotly',
  tensorflow:            'tensorflow',
  torch:                 'torch',
  transformers:          'transformers',
  datasets:              'datasets',
  keras:                 'keras',
  xgboost:               'xgboost',
  lightgbm:              'lightgbm',
  statsmodels:           'statsmodels',

  // --- Image / Vision ---
  PIL:                   'Pillow',
  cv2:                   'opencv-python',
  skimage:               'scikit-image',
  imageio:               'imageio',
  wand:                  'Wand',

  // --- Audio / Video ---
  pyttsx3:               'pyttsx3',
  gtts:                  'gTTS',
  pydub:                 'pydub',
  mutagen:               'mutagen',
  speech_recognition:    'SpeechRecognition',
  librosa:               'librosa',
  moviepy:               'moviepy',

  // --- Scraping / Automation ---
  bs4:                   'beautifulsoup4',
  lxml:                  'lxml',
  selenium:              'selenium',
  playwright:            'playwright',
  mechanize:             'mechanize',
  scrapy:                'scrapy',
  pyppeteer:             'pyppeteer',
  undetected_chromedriver: 'undetected-chromedriver',
  requests_html:         'requests-html',
  cssselect:             'cssselect',

  // --- File Formats ---
  yaml:                  'PyYAML',
  toml:                  'toml',
  tomllib:               'tomllib',
  openpyxl:              'openpyxl',
  xlrd:                  'xlrd',
  xlwt:                  'xlwt',
  docx:                  'python-docx',
  PyPDF2:                'PyPDF2',
  pypdf:                 'pypdf',
  pdfplumber:            'pdfplumber',
  reportlab:             'reportlab',
  fpdf:                  'fpdf2',
  markdown:              'Markdown',

  // --- Crypto / Security ---
  cryptography:          'cryptography',
  nacl:                  'PyNaCl',
  jwt:                   'PyJWT',
  bcrypt:                'bcrypt',
  paramiko:              'paramiko',
  Crypto:                'pycryptodome',

  // --- Cloud / APIs ---
  boto3:                 'boto3',
  botocore:              'botocore',
  google:                'google-api-python-client',
  googleapiclient:       'google-api-python-client',
  firebase_admin:        'firebase-admin',
  stripe:                'stripe',
  paypalrestsdk:         'paypalrestsdk',
  openai:                'openai',
  anthropic:             'anthropic',
  cohere:                'cohere',
  langchain:             'langchain',

  // --- Utilities ---
  psutil:                'psutil',
  schedule:              'schedule',
  apscheduler:           'APScheduler',
  celery:                'celery',
  click:                 'click',
  typer:                 'typer',
  rich:                  'rich',
  colorama:              'colorama',
  loguru:                'loguru',
  tqdm:                  'tqdm',
  tabulate:              'tabulate',
  humanize:              'humanize',
  arrow:                 'arrow',
  pendulum:              'pendulum',
  pytz:                  'pytz',
  dateutil:              'python-dateutil',
  cachetools:            'cachetools',
  tenacity:              'tenacity',
  retry:                 'retry',
  aiofiles:              'aiofiles',
  anyio:                 'anyio',
  trio:                  'trio',
  jinja2:                'Jinja2',
  mako:                  'Mako',
  pyperclip:             'pyperclip',
  pyautogui:             'pyautogui',
  keyboard:              'keyboard',
  mouse:                 'mouse',
  qrcode:                'qrcode',
  pyqrcode:              'PyQRCode',
  barcode:               'python-barcode',
  phonenumbers:          'phonenumbers',
  email_validator:       'email-validator',
  validators:            'validators',
  googletrans:           'googletrans==4.0.0-rc1',
  translate:             'translate',
  langdetect:            'langdetect',
  nltk:                  'nltk',
  spacy:                 'spacy',
  textblob:              'textblob',
  wikipedia:             'wikipedia',
  googlesearch:          'googlesearch-python',
  yt_dlp:                'yt-dlp',
  youtube_dl:            'youtube-dl',
  pytube:                'pytube',
  speedtest:             'speedtest-cli',
  ping3:                 'ping3',
  emoji:                 'emoji',
  pyshorteners:          'pyshorteners',
  shortuuid:             'shortuuid',
  nanoid:                'nanoid',
  faker:                 'Faker',
  mimesis:               'mimesis',
  pynput:                'pynput',
  pywin32:               'pywin32',
  win32api:              'pywin32',
  win32con:              'pywin32',
  winreg:                'pywin32',
  comtypes:              'comtypes',
  cffi:                  'cffi',
  ctypes_util:           'ctypes',
  gi:                    'PyGObject',
  wx:                    'wxPython',
  tkinter:               'tk',
  customtkinter:         'customtkinter',
  PyQt5:                 'PyQt5',
  PyQt6:                 'PyQt6',
  PySide6:               'PySide6',
};

// =============================================================
// Python ফাইল স্ক্যান করে সব import বের করো (recursively)
// =============================================================
function autoDetectDeps(entryFile, workdir) {
  const STDLIB = new Set([
    'os','sys','time','json','re','math','random','datetime','threading',
    'subprocess','pathlib','logging','asyncio','io','collections','itertools',
    'functools','typing','traceback','shutil','glob','socket','struct',
    'base64','hashlib','hmac','urllib','http','email','csv','sqlite3',
    'queue','signal','argparse','platform','inspect','copy','decimal',
    'fractions','statistics','string','textwrap','unicodedata','uuid','xml',
    'configparser','tempfile','getpass','codecs','enum','abc','dataclasses',
    'contextlib','concurrent','multiprocessing','gc','weakref','array',
    'bisect','heapq','pprint','reprlib','numbers','cmath','operator',
    'builtins','ast','dis','importlib','pkgutil','runpy','site',
    'sysconfig','token','tokenize','types','warnings','zipfile',
    'tarfile','gzip','bz2','lzma','zlib','zipimport','ctypes','mmap',
    'msvcrt','nt','posix','pwd','grp','pty','tty','termios','fcntl',
    'resource','select','selectors','ssl','secrets','uu','quopri',
    'binascii','audioop','wave','aifc','sunau','chunk','imghdr','sndhdr',
    'readline','rlcompleter','code','codeop','compileall','py_compile',
    'symtable','tabnanny','pyclbr','doctest','unittest','pdb','profile',
    'cProfile','pstats','timeit','trace','tracemalloc','faulthandler',
    'atexit','_thread','contextvars','linecache','keyword','parser',
    'symbol','opcode','__future__','__main__','_io','_abc','_csv',
    'typing_extensions',
  ]);

  const found = new Set();
  const scanned = new Set();

  function extractModules(src) {
    const mods = new Set();

    // প্রতিটা লাইন আলাদাভাবে process করো (multi-line import সমস্যা এড়াতে)
    const lines = src.split('\n');
    for (const line of lines) {
      const stripped = line.trim();

      // from X import ...  OR  from X.Y import ...
      const fromMatch = stripped.match(/^from\s+([a-zA-Z0-9_]+)/);
      if (fromMatch) {
        mods.add(fromMatch[1]);
        continue;
      }

      // import X  OR  import X, Y, Z  OR  import X as Y
      const importMatch = stripped.match(/^import\s+(.+)/);
      if (importMatch) {
        // "X, Y, Z" বা "X as Y" বা "X.Y as Z" parse করো
        const parts = importMatch[1].split(',');
        for (const part of parts) {
          const mod = part.trim().split(/\s+/)[0].split('.')[0];
          if (mod) mods.add(mod);
        }
      }
    }
    return mods;
  }

  function scanFile(filePath) {
    if (scanned.has(filePath)) return;
    scanned.add(filePath);
    if (!fs.existsSync(filePath)) return;

    let src = '';
    try { src = fs.readFileSync(filePath, 'utf8'); } catch (_) { return; }

    const mods = extractModules(src);
    for (const mod of mods) {
      if (!mod || STDLIB.has(mod)) continue;

      if (IMPORT_TO_PIP[mod]) {
        found.add(IMPORT_TO_PIP[mod]);
      }

      // local .py ফাইল হলে সেটাও scan করো
      const localPy = path.join(workdir, mod + '.py');
      if (fs.existsSync(localPy)) scanFile(localPy);
    }
  }

  scanFile(path.join(workdir, entryFile));

  // workdir-এর সব .py ফাইলও scan করো
  try {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.deps', '__pycache__', 'node_modules', '.git', '.venv', 'venv', 'env'].includes(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.py') && !scanned.has(full)) scanFile(full);
      }
    };
    walk(workdir);
  } catch (_) {}

  return Array.from(found);
}

// =============================================================
// requirements.txt থেকে ইনস্টলড package list নিয়ে
// auto-detect-এর duplicate বাদ দাও
// =============================================================
function mergeWithRequirements(workdir, detected) {
  const reqFile = path.join(workdir, 'requirements.txt');
  if (!fs.existsSync(reqFile)) return detected;
  const existing = fs.readFileSync(reqFile, 'utf8')
    .split('\n')
    .map(l => l.trim().split(/[=><!\[]/)[0].toLowerCase())
    .filter(Boolean);
  return detected.filter(p => !existing.includes(p.toLowerCase()));
}

function nodeBin() { return process.execPath; }

const LANGUAGES = {
  python: {
    label: 'Python',
    icon: '🐍',
    extensions: ['.py'],
    get binary() { return findPython() || 'python3'; },
    argsFor: (entry) => ['-u', entry],
    depsFile: 'requirements.txt',
    available: () => !!findPython(),
    installDeps: (workdir) => {
      const req = path.join(workdir, 'requirements.txt');
      if (!fs.existsSync(req)) return;

      // requirements.txt থেকে package list পড়ো
      const pkgList = fs.readFileSync(req, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith('-'));

      // compiled vs pure ভাগ করো
      const systemPkgs = pkgList.filter(p => needsSystemInstall(p));
      const localPkgs  = pkgList.filter(p => !needsSystemInstall(p));

      if (systemPkgs.length) {
        runPipInstall(workdir,
          `--no-cache-dir --disable-pip-version-check --quiet ${systemPkgs.map(p => `"${p}"`).join(' ')}`
        );
      }
      if (localPkgs.length) {
        const depsDir = path.join(workdir, '.deps');
        if (!fs.existsSync(depsDir)) fs.mkdirSync(depsDir, { recursive: true });
        runPipInstall(workdir,
          `--target "${depsDir}" --no-cache-dir --disable-pip-version-check --quiet ${localPkgs.map(p => `"${p}"`).join(' ')}`
        );
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

module.exports = {
  LANGUAGES,
  detectLanguage,
  findPython,
  installPythonPackages,
  autoDetectDeps,
  mergeWithRequirements,
  needsSystemInstall,
};
