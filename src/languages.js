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

module.exports = { LANGUAGES, detectLanguage, findPython };
