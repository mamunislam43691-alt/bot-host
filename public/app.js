// public/app.js — SPA frontend: auth screen + dashboard (upload, list, logs)
(function () {
  'use strict';

  // ---------- State ----------
  let token = localStorage.getItem('token');
  let user = null;
  let bots = [];
  let activeLogBotId = null;
  let socket = null;
  let selectedLanguage = 'python';
  let selectedFile = null;
  let pollingTimer = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const app = $('#app');

  // ---------- API helper ----------
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, { ...opts, headers });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ---------- Toasts ----------
  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---------- Modal ----------
  function openModal(html) {
    $('#modal-content').innerHTML = html;
    $('#modal-bg').classList.add('open');
  }
  function closeModal() { $('#modal-bg').classList.remove('open'); }
  $('#modal-bg').addEventListener('click', (e) => { if (e.target.id === 'modal-bg') closeModal(); });

  // ---------- Routing ----------
  function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (!token || !user) return renderAuth();
    if (hash === 'dashboard') return renderDashboard();
    renderAuth();
  }
  window.addEventListener('hashchange', route);

  // ---------- Auth screen ----------
  function renderAuth() {
    let mode = 'login';
    app.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="logo">
            <div class="mark">🤖</div>
            <h1>Bot Hosting Panel</h1>
            <p>আপনার Python / Node / Bash বট হোস্ট করুন</p>
          </div>
          <form id="authForm">
            <div class="form-group">
              <label>ইউজারনেম</label>
              <input id="username" autocomplete="username" required />
            </div>
            <div class="form-group">
              <label>পাসওয়ার্ড</label>
              <input id="password" type="password" autocomplete="current-password" required />
            </div>
            <div class="error-msg" id="authErr"></div>
            <button class="btn btn-primary" style="width:100%;justify-content:center" id="authBtn">লগইন</button>
          </form>
          <div class="auth-toggle">
            <span id="toggleText">একাউন্ট নেই?</span>
            <a href="#" id="toggleMode">রেজিস্টার করুন</a>
          </div>
          <div class="center muted" style="margin-top:18px;font-size:12px">
            🚀 Railway-এ ডিপ্লয় করা হোস্টিং প্যানেল
          </div>
        </div>
      </div>`;

    const toggle = () => {
      mode = mode === 'login' ? 'register' : 'login';
      $('#authBtn').textContent = mode === 'login' ? 'লগইন' : 'রেজিস্টার';
      $('#toggleText').textContent = mode === 'login' ? 'একাউন্ট নেই?' : 'আগেই একাউন্ট আছে?';
      $('#toggleMode').textContent = mode === 'login' ? 'রেজিস্টার করুন' : 'লগইন করুন';
    };
    $('#toggleMode').addEventListener('click', (e) => { e.preventDefault(); toggle(); });

    $('#authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#username').value.trim();
      const password = $('#password').value;
      $('#authErr').textContent = '';
      $('#authBtn').disabled = true;
      try {
        const data = await api('/api/auth/' + mode, {
          method: 'POST',
          body: JSON.stringify({ username, password }),
        });
        token = data.token;
        user = data.user;
        localStorage.setItem('token', token);
        location.hash = '#/dashboard';
        route();
      } catch (err) {
        $('#authErr').textContent = err.message;
      } finally {
        $('#authBtn').disabled = false;
      }
    });
  }

  // ---------- Dashboard ----------
  function renderDashboard() {
    app.innerHTML = `
      <div class="topbar">
        <div class="container inner">
          <div class="brand">
            <div class="dot">🤖</div>
            <div>Bot Hosting Panel</div>
          </div>
          <div class="right">
            <button class="btn btn-sm btn-ghost" id="docsBtn">📄 API ডকস</button>
            <button class="btn btn-sm" id="logoutBtn">🚪 লগআউট</button>
          </div>
        </div>
      </div>

      <div class="container" style="padding-bottom:60px">
        <!-- Credential banner -->
        <div class="cred-banner">
          <div>
            <h3>🔑 আপনার API Key</h3>
            <div class="cred-row">
              <code id="apiKeyDisplay">...</code>
              <button class="btn btn-sm" id="copyKey">📋</button>
            </div>
            <button class="btn btn-sm btn-warn mt" id="regenKey">♻️ নতুন Key তৈরি</button>
          </div>
          <div>
            <h3>🌐 Base URL</h3>
            <div class="cred-row">
              <code id="baseUrlDisplay">...</code>
              <button class="btn btn-sm" id="copyUrl">📋</button>
            </div>
            <div class="muted mt" style="font-size:12.5px">
              এই URL ও API Key দিয়ে REST API কল করেও বট ডিপ্লয় করতে পারবেন।
            </div>
          </div>
        </div>

        <h2 class="section-title">📤 নতুন বট আপলোড করুন</h2>
        <div class="upload-card" id="uploadCard">
          <div class="kv" style="margin-bottom:14px">
            <label class="k" style="align-self:center">বটের নাম</label>
            <input id="botName" placeholder="যেমন: My Telegram Bot" />
          </div>

          <label>ভাষা সিলেক্ট করুন</label>
          <div class="lang-grid" id="langGrid">
            <div class="lang-opt active" data-lang="python"><div class="ic">🐍</div><div class="nm">Python</div></div>
            <div class="lang-opt" data-lang="node"><div class="ic">🟢</div><div class="nm">Node.js</div></div>
            <div class="lang-opt" data-lang="bash"><div class="ic">💻</div><div class="nm">Bash</div></div>
          </div>

          <div class="drop-zone" id="dropZone">
            <div class="icon">📁</div>
            <div>ফাইল এখানে টেনে আনুন অথবা ক্লিক করে সিলেক্ট করুন</div>
            <div class="muted" style="font-size:12px;margin-top:6px">
              .py / .js / .mjs / .sh অথবা .zip (requirements.txt বা package.json সহ)
            </div>
            <div class="filename" id="fileName"></div>
            <input type="file" id="fileInput" hidden />
          </div>

          <div class="flex gap mt" style="align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer;color:var(--text)">
              <input type="checkbox" id="autoRestart" style="width:auto" /> ক্র্যাশ হলে অটো-রিস্টার্ট
            </label>
            <div style="flex:1"></div>
            <button class="btn btn-primary" id="uploadBtn" disabled>🚀 আপলোড করুন</button>
          </div>
        </div>

        <h2 class="section-title">🤖 আপনার বটসমূহ (<span id="botCount">0</span>)</h2>
        <div id="botsArea">
          <div class="empty-state">
            <div class="ic">⏳</div>
            <div>লোড হচ্ছে...</div>
          </div>
        </div>
      </div>
    `;

    // populate credentials
    $('#apiKeyDisplay').textContent = user.apiKey;
    $('#baseUrlDisplay').textContent = location.origin;
    $('#botCount').textContent = bots.length;

    // language select
    $$('.lang-opt').forEach((el) => {
      el.addEventListener('click', () => {
        $$('.lang-opt').forEach((x) => x.classList.remove('active'));
        el.classList.add('active');
        selectedLanguage = el.dataset.lang;
      });
    });

    // file input / drop
    const fileInput = $('#fileInput');
    $('#dropZone').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((ev) =>
      $('#dropZone').addEventListener(ev, (e) => { e.preventDefault(); $('#dropZone').classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      $('#dropZone').addEventListener(ev, (e) => { e.preventDefault(); $('#dropZone').classList.remove('over'); }));
    $('#dropZone').addEventListener('drop', (e) => {
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    function handleFile(file) {
      selectedFile = file;
      $('#fileName').textContent = '✓ ' + file.name;
      $('#uploadBtn').disabled = false;
    }

    $('#uploadBtn').addEventListener('click', uploadBot);
    $('#logoutBtn').addEventListener('click', logout);
    $('#docsBtn').addEventListener('click', showDocs);

    $('#copyKey').addEventListener('click', () => {
      navigator.clipboard.writeText(user.apiKey);
      toast('API Key কপি হয়েছে', 'success');
    });
    $('#copyUrl').addEventListener('click', () => {
      navigator.clipboard.writeText(location.origin);
      toast('Base URL কপি হয়েছে', 'success');
    });
    $('#regenKey').addEventListener('click', regenerateKey);

    setupSocket();
    loadBots();
    startPolling();
  }

  // ---------- Socket.IO ----------
  function setupSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, transports: ['websocket', 'polling'] });
    socket.on('history', ({ botId, logs }) => {
      if (activeLogBotId !== botId) return;
      const body = $('#logBody_' + botId);
      if (!body) return;
      body.innerHTML = logs.length ? logs.map(renderLogLine).join('') : '<div class="log-empty">কোনো লগ নেই।</div>';
      body.scrollTop = body.scrollHeight;
    });
    socket.on('log', ({ botId, stream, text, ts }) => {
      if (activeLogBotId !== botId) return;
      const body = $('#logBody_' + botId);
      if (!body) return;
      // remove empty placeholder
      const empty = body.querySelector('.log-empty');
      if (empty) empty.remove();
      body.insertAdjacentHTML('beforeend', renderLogLine({ stream, text, ts }));
      body.scrollTop = body.scrollHeight;
    });
  }
  function renderLogLine(l) {
    const t = new Date(l.ts).toLocaleTimeString();
    return `<div class="log-line ${l.stream}"><span class="ts">${t}</span>${escapeHtml(l.text)}</div>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Bots ----------
  async function loadBots() {
    try {
      const data = await api('/api/bots');
      bots = data.bots;
      renderBots();
    } catch (e) {
      $('#botsArea').innerHTML = `<div class="empty-state"><div class="ic">⚠️</div><div>${escapeHtml(e.message)}</div></div>`;
    }
  }

  function renderBots() {
    $('#botCount').textContent = bots.length;
    const area = $('#botsArea');
    if (!bots.length) {
      area.innerHTML = `
        <div class="empty-state">
          <div class="ic">📭</div>
          <div>কোনো বট আপলোড করা হয়নি</div>
          <div class="muted" style="margin-top:6px">উপরে গিয়ে আপনার প্রথম বট আপলোড করুন</div>
        </div>`;
      return;
    }
    area.innerHTML = '<div class="bot-grid">' + bots.map(renderBotCard).join('') + '</div>';
    // attach handlers
    bots.forEach((b) => {
      $('#start_' + b.id)?.addEventListener('click', () => doAction(b.id, 'start'));
      $('#stop_' + b.id)?.addEventListener('click', () => doAction(b.id, 'stop'));
      $('#restart_' + b.id)?.addEventListener('click', () => doAction(b.id, 'restart'));
      $('#del_' + b.id)?.addEventListener('click', () => deleteBot(b));
      $('#settings_' + b.id)?.addEventListener('click', () => showSettings(b));
      $('#toggleLog_' + b.id)?.addEventListener('click', () => toggleLog(b.id));
    });
  }

  function renderBotCard(b) {
    const running = b.status === 'running';
    const langIcon = { python: '🐍', node: '🟢', bash: '💻' }[b.language] || '📜';
    return `
      <div class="bot-card">
        <div class="head">
          <div>
            <div class="name">${langIcon} ${escapeHtml(b.name)}</div>
            <div class="meta">
              ${b.language} · ${escapeHtml(b.entryFile)}<br>
              ${b.pid ? `PID: ${b.pid} · ` : ''}রিস্টার্ট: ${b.restartCount || 0}
            </div>
          </div>
          <span class="badge ${running ? 'running' : 'stopped'}"><span class="dot"></span>${running ? 'চলছে' : 'বন্ধ'}</span>
        </div>
        <div class="bot-actions">
          ${running
            ? `<button class="btn btn-sm btn-warn" id="stop_${b.id}">⏹ বন্ধ</button>`
            : `<button class="btn btn-sm btn-success" id="start_${b.id}">▶ চালু</button>`}
          <button class="btn btn-sm" id="restart_${b.id}">↻ রিস্টার্ট</button>
          <button class="btn btn-sm btn-ghost" id="settings_${b.id}">⚙️</button>
          <button class="btn btn-sm btn-danger" id="del_${b.id}">🗑</button>
        </div>
        <button class="btn btn-sm btn-ghost mt" id="toggleLog_${b.id}" style="width:100%;justify-content:center">
          📜 লগ ${activeLogBotId === b.id ? 'লুকান' : 'দেখুন'}
        </button>
        ${activeLogBotId === b.id ? `
          <div class="log-panel">
            <div class="log-head between">
              <span>লাইভ কনসোল — ${escapeHtml(b.name)}</span>
              <button class="btn btn-sm btn-ghost" id="clearLog_${b.id}">🧹 মুছুন</button>
            </div>
            <div class="log-body" id="logBody_${b.id}"><div class="log-empty">কানেক্ট হচ্ছে...</div></div>
          </div>` : ''}
      </div>`;
  }

  function toggleLog(botId) {
    if (activeLogBotId === botId) {
      // close
      socket.emit('unsubscribe', botId);
      activeLogBotId = null;
    } else {
      if (activeLogBotId) socket.emit('unsubscribe', activeLogBotId);
      activeLogBotId = botId;
      socket.emit('subscribe', botId);
    }
    renderBots();
    // re-attach clear log handler
    const clear = $('#clearLog_' + botId);
    if (clear) clear.addEventListener('click', async () => {
      try { await api('/api/bots/' + botId + '/logs', { method: 'DELETE' }); } catch (e) {}
      const body = $('#logBody_' + botId);
      if (body) body.innerHTML = '<div class="log-empty">কোনো লগ নেই।</div>';
    });
  }

  async function doAction(id, action) {
    try {
      await api('/api/bots/' + id + '/' + action, { method: 'POST' });
      toast(action + ' সফল হয়েছে', 'success');
      await loadBots();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteBot(b) {
    if (!confirm(`"${b.name}" বটটি ডিলিট করতে চান? এটি ফেরানো যাবে না।`)) return;
    try {
      await api('/api/bots/' + b.id, { method: 'DELETE' });
      toast('বট ডিলিট হয়েছে', 'success');
      if (activeLogBotId === b.id) activeLogBotId = null;
      await loadBots();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function uploadBot() {
    if (!selectedFile) return;
    const btn = $('#uploadBtn');
    btn.disabled = true;
    btn.textContent = '⏳ আপলোড হচ্ছে...';
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('name', $('#botName').value.trim() || selectedFile.name);
      fd.append('language', selectedLanguage);
      fd.append('autoRestart', $('#autoRestart').checked ? '1' : '0');
      const data = await api('/api/bots/upload', { method: 'POST', body: fd });
      toast('বট আপলোড হয়েছে!', 'success');
      // reset form
      selectedFile = null;
      $('#fileName').textContent = '';
      $('#botName').value = '';
      $('#fileInput').value = '';
      $('#uploadBtn').disabled = true;
      await loadBots();
      // offer to start
      if (confirm('বটটি এখন চালু করবেন?')) {
        await api('/api/bots/' + data.bot.id + '/start', { method: 'POST' });
        toast('বট চালু হয়েছে ▶', 'success');
        await loadBots();
      }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '🚀 আপলোড করুন';
    }
  }

  async function regenerateKey() {
    if (!confirm('নতুন API Key তৈরি করলে পুরোনো Key আর কাজ করবে না। এগিয়ে যাবেন?')) return;
    try {
      const data = await api('/api/auth/regenerate-key', { method: 'POST' });
      user.apiKey = data.apiKey;
      $('#apiKeyDisplay').textContent = user.apiKey;
      toast('নতুন API Key তৈরি হয়েছে', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  function showSettings(b) {
    openModal(`
      <h2>⚙️ সেটিংস — ${escapeHtml(b.name)}</h2>
      <div class="form-group">
        <label>নাম</label>
        <input id="setName" value="${escapeHtml(b.name)}" />
      </div>
      <div class="form-group">
        <label>এনভায়রনমেন্ট ভেরিয়েবল (JSON)</label>
        <textarea id="setEnv" rows="5" placeholder='{"TOKEN":"xxx","WEBHOOK_URL":"..."}'>${escapeHtml(JSON.stringify(b.env || {}, null, 2))}</textarea>
      </div>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text)">
          <input type="checkbox" id="setAuto" style="width:auto" ${b.autoRestart ? 'checked' : ''} />
          ক্র্যাশ হলে অটো-রিস্টার্ট
        </label>
      </div>
      <div class="flex gap" style="justify-content:flex-end">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-bg').classList.remove('open')">বাতিল</button>
        <button class="btn btn-primary" id="saveSettings">সেভ করুন</button>
      </div>
    `);
    $('#saveSettings').addEventListener('click', async () => {
      try {
        const env = JSON.parse($('#setEnv').value || '{}');
        await api('/api/bots/' + b.id, {
          method: 'PATCH',
          body: JSON.stringify({
            name: $('#setName').value.trim(),
            env,
            autoRestart: $('#setAuto').checked,
          }),
        });
        toast('সেটিংস সেভ হয়েছে', 'success');
        closeModal();
        await loadBots();
      } catch (e) { toast(e.message, 'error'); }
    });
  }

  function showDocs() {
    openModal(`
      <h2>📄 REST API ডকুমেন্টেশন</h2>
      <p class="muted" style="margin-bottom:14px;font-size:13px">সব এন্ডপয়েন্টে Header দিন: <code>X-API-Key: ${user ? user.apiKey : '&lt;key&gt;'}</code></p>
      <div class="kv" style="font-size:12.5px">
        <div class="k">Base URL</div><div><code>${location.origin}</code></div>
      </div>
      <pre style="background:#060912;padding:14px;border-radius:10px;overflow:auto;font-size:12px;margin-top:14px;color:#c7e8c7">${escapeHtml(docsText())}</pre>
      <div class="flex" style="justify-content:flex-end;margin-top:14px">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-bg').classList.remove('open')">বন্ধ করুন</button>
      </div>
    `);
  }
  function docsText() {
    return `# বট লিস্ট
curl -H "X-API-Key: KEY" ${location.origin}/api/bots

# বট আপলোড করুন
curl -H "X-API-Key: KEY" \\
  -F "file=@bot.py" -F "language=python" -F "name=MyBot" \\
  ${location.origin}/api/bots/upload

# এক কলে ডিপ্লয় (আপলোড + স্টার্ট)
curl -H "X-API-Key: KEY" \\
  -F "file=@bot.py" -F "start=1" \\
  ${location.origin}/api/deploy

# চালু / বন্ধ / রিস্টার্ট
curl -X POST -H "X-API-Key: KEY" ${location.origin}/api/bots/BOT_ID/start
curl -X POST -H "X-API-Key: KEY" ${location.origin}/api/bots/BOT_ID/stop
curl -X POST -H "X-API-Key: KEY" ${location.origin}/api/bots/BOT_ID/restart

# লগ
curl -H "X-API-Key: KEY" ${location.origin}/api/bots/BOT_ID/logs

# ডিলিট
curl -X DELETE -H "X-API-Key: KEY" ${location.origin}/api/bots/BOT_ID

# এনভায়রনমেন্ট ভেরিয়েবল (deploy এ পাঠান)
curl -H "X-API-Key: KEY" \\
  -F "file=@bot.py" -F "env_TOKEN=xxxx" \\
  ${location.origin}/api/deploy`;
  }

  function logout() {
    if (socket) socket.disconnect();
    token = null; user = null;
    localStorage.removeItem('token');
    if (pollingTimer) clearInterval(pollingTimer);
    location.hash = '';
    route();
  }

  // poll status every 5s (refresh badges cheaply)
  function startPolling() {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(loadBots, 5000);
  }

  // ---------- Init ----------
  (async function init() {
    if (token) {
      try {
        const data = await api('/api/auth/me');
        user = data.user;
      } catch (_) {
        token = null; localStorage.removeItem('token');
      }
    }
    route();
  })();
})();
