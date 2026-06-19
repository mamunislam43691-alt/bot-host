// src/languages.js — runtime configuration per supported language
// Each entry describes how to RUN a script and how to INSTALL deps.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LANGUAGES = {
  python: {
    label: 'Python',
    icon: '🐍',
    extensions: ['.py'],
    // Try modern python3, fall back to python
    binary: process.platform === 'win32' ? 'python' : 'python3',
    argsFor: (entry) => ['-u', entry],   // -u = unbuffered (real-time logs)
    detectVersionCmd: ['python3', ['--version']],
    depsFile: 'requirements.txt',
    installDeps: (workdir) => {
      const req = path.join(workdir, 'requirements.txt');
      const bin = process.platform === 'win32' ? 'python' : 'python3';
      if (fs.existsSync(req)) {
        execFileSync(bin, ['-m', 'pip', 'install', '--no-cache-dir', '-r', 'requirements.txt'], {
          cwd: workdir, stdio: 'ignore', timeout: 5 * 60 * 1000,
        });
      }
    },
  },
  node: {
    label: 'Node.js',
    icon: '🟢',
    extensions: ['.js', '.mjs'],
    binary: process.execPath,            // the bundled node itself
    argsFor: (entry) => [entry],
    depsFile: 'package.json',
    installDeps: (workdir) => {
      if (fs.existsSync(path.join(workdir, 'package.json'))) {
        execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
          cwd: workdir, stdio: 'ignore', shell: true, timeout: 5 * 60 * 1000,
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

module.exports = { LANGUAGES, detectLanguage };
