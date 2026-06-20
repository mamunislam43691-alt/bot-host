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
    try { data = await res.json(); } catch (_) { }
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
            <p class="muted cred-desc">এই Key দিয়ে REST API কল করে বট ম্যানেজ ও ডিপ্লয় করতে পারবেন</p>
            <div class="cred-row">
              <code id="apiKeyDisplay">...</code>
              <button class="btn btn-sm" id="copyKey" title="কপি করুন">📋 কপি</button>
            </div>
            <button class="btn btn-sm btn-ghost mt" id="regenKey" style="font-size:12px">♻️ নতুন Key তৈরি</button>
          </div>
          <div>
            <h3>🌐 Base URL</h3>
            <p class="muted cred-desc">API কলের সময় এই URL ব্যবহার করুন (X-API-Key header সহ)</p>
            <div class="cred-row">
              <code id="baseUrlDisplay">...</code>
              <button class="btn btn-sm" id="copyUrl" title="কপি করুন">📋 কপি</button>
            </div>
            <div class="cred-usage mt">
              <div class="cred-usage-title">📊 কুইক রেফারেন্স:</div>
              <div class="cred-example">
                <span class="cred-label">আপলোড + স্টার্ট:</span>
                <code>curl -H "X-API-Key: <span class="key-placeholder">KEY</span>" -F "file=@bot.py" <span class="url-placeholder">URL</span>/api/deploy</code>
              </div>
              <div class="cred-example">
                <span class="cred-label">বট লিস্ট:</span>
                <code>curl -H "X-API-Key: <span class="key-placeholder">KEY</span>" <span class="url-placeholder">URL</span>/api/bots</code>
              </div>
              <div class="cred-example">
                <span class="cred-label">স্টার্ট:</span>
                <code>curl -X POST -H "X-API-Key: <span class="key-placeholder">KEY</span>" <span class="url-placeholder">URL</span>/api/bots/BOT_ID/start</code>
              </div>
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

          <div class="deps-group" id="depsGroup">
            <label>📦 Dependencies / requirements.txt <span class="muted" style="font-weight:normal">(ঐচ্ছিক — প্রতি লাইনে একটা প্যাকেজ)</span></label>
            <textarea id="botRequirements" rows="3" placeholder="pyTelegramBotAPI&#10;requests&#10;aiohttp"></textarea>
            <div class="muted" style="font-size:11.5px;margin-top:4px">
              ℹ️ খালি রাখলে সিস্টেম আপনার স্ক্রিপ্টের <code style="font-size:10.5px">import</code> থেকে সাধারণ প্যাকেজ অটো-ইনস্টল করবে। যেমন <code style="font-size:10.5px">import telebot</code> → pyTelegramBotAPI
            </div>
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

    // Event delegation for bot actions (start/stop/restart/delete/download/settings/editor/toggleLog)
    $('#botsArea').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      const id = btn.id;
      if (!id) return;

      const match = id.match(/^(start|stop|restart|del|download|settings|editor|toggleLog|downloadLog|clearLog)_(.+)$/);
      if (!match) return;

      const [, action, botId] = match;

      if (action === 'start' || action === 'stop' || action === 'restart') {
        doAction(botId, action);
      } else if (action === 'del') {
        const bot = bots.find(b => b.id === botId);
        if (bot) deleteBot(bot);
      } else if (action === 'download') {
        window.open('/api/bots/' + botId + '/download?token=' + token, '_blank');
      } else if (action === 'settings') {
        const bot = bots.find(b => b.id === botId);
        if (bot) showSettings(bot);
      } else if (action === 'editor') {
        const bot = bots.find(b => b.id === botId);
        if (bot) showEditor(bot);
      } else if (action === 'toggleLog') {
        toggleLog(botId);
      } else if (action === 'downloadLog') {
        window.open('/api/bots/' + botId + '/logs/download?token=' + token, '_blank');
      } else if (action === 'clearLog') {
        (async () => {
          try { await api('/api/bots/' + botId + '/logs', { method: 'DELETE' }); } catch (e) { }
          const body = $('#logBody_' + botId);
          if (body) body.innerHTML = '<div class="log-empty">কোনো লগ নেই।</div>';
        })();
      }
    });

    setupSocket();
    loadBots();
    startPolling();
  }

  // ---------- Socket.IO ----------
  function setupSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token }, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 1500 });

    socket.on('connect', () => {
      // re-subscribe to active log if any
      if (activeLogBotId) socket.emit('subscribe', activeLogBotId);
    });

    socket.on('history', ({ botId, logs }) => {
      if (activeLogBotId !== botId) return;
      const body = $('#logBody_' + botId);
      if (!body) return;
      body.innerHTML = logs.length ? logs.map(renderLogLine).join('') : '<div class="log-empty">এখনো কোনো লগ নেই। বট চালু হলে এখানে আউটপুট দেখা যাবে।</div>';
      body.scrollTop = body.scrollHeight;
    });

    socket.on('log', ({ botId, stream, text, ts }) => {
      // লগ লাইন যোগ করো
      if (activeLogBotId === botId) {
        const body = $('#logBody_' + botId);
        if (body) {
          const empty = body.querySelector('.log-empty');
          if (empty) empty.remove();
          body.insertAdjacentHTML('beforeend', renderLogLine({ stream, text, ts }));
          body.scrollTop = body.scrollHeight;
        }
      }
    });

    // বট status পরিবর্তন হলে সাথে সাথে UI আপডেট করো
    socket.on('status', ({ botId, status, pid, startedAt, restartCount }) => {
      const bot = bots.find(b => b.id === botId);
      if (!bot) return;
      const changed = bot.status !== status || bot.pid !== pid;
      if (!changed) return;
      bot.status = status;
      bot.pid = pid;
      bot.startedAt = startedAt;
      bot.restartCount = restartCount || 0;
      updateBotCardStatus(botId, bot);
    });
  }

  // DOM ইনপ্লেসে badge + বোতাম আপডেট করো (পুরো re-render না করে)
  function updateBotCardStatus(botId, bot) {
    const running = bot.status === 'running';

    // badge আপডেট
    const badge = document.querySelector(`.bot-card [id$="_${botId}"]`)?.closest('.bot-card')?.querySelector('.badge');
    if (badge) {
      badge.className = `badge ${running ? 'running' : 'stopped'}`;
      badge.innerHTML = `<span class="dot"></span>${running ? 'চলছে' : 'বন্ধ'}`;
    }

    // meta (PID / restart count) আপডেট
    const meta = document.querySelector(`.bot-card [id$="_${botId}"]`)?.closest('.bot-card')?.querySelector('.meta');
    if (meta && bot.entryFile) {
      const langIcon = { python: '🐍', node: '🟢', bash: '💻' }[bot.language] || '📜';
      meta.innerHTML = `${bot.language} · ${escapeHtml(bot.entryFile)}<br>${bot.pid ? `PID: ${bot.pid} · ` : ''}রিস্টার্ট: ${bot.restartCount || 0}`;
    }

    // start/stop বোতাম swap করো
    const actions = document.querySelector(`#stop_${botId}, #start_${botId}`)?.parentElement;
    if (actions) {
      const oldBtn = actions.querySelector(`#stop_${botId}, #start_${botId}`);
      if (oldBtn) {
        const newBtn = document.createElement('button');
        if (running) {
          newBtn.className = 'btn btn-sm btn-warn';
          newBtn.id = `stop_${botId}`;
          newBtn.innerHTML = '⏹ বন্ধ';
        } else {
          newBtn.className = 'btn btn-sm btn-success';
          newBtn.id = `start_${botId}`;
          newBtn.innerHTML = '▶ চালু';
        }
        actions.replaceChild(newBtn, oldBtn);
      }
    }
  }

  function renderLogLine(l) {
    const t = new Date(l.ts).toLocaleTimeString();
    // system লাইনের জন্য বিশেষ আইকন
    let prefix = '';
    if (l.stream === 'system') {
      const txt = l.text || '';
      if (txt.startsWith('▶') || txt.startsWith('✓')) prefix = '';
      else if (txt.startsWith('⏹') || txt.startsWith('■')) prefix = '';
      else if (txt.startsWith('↻')) prefix = '';
      else if (txt.startsWith('✕') || txt.startsWith('⚠')) prefix = '';
    }
    return `<div class="log-line ${escapeHtml(l.stream)}"><span class="ts">${t}</span>${prefix}${escapeHtml(l.text)}</div>`;
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
      // polling fallback removed to prevent socket log flickering
    } catch (e) {
      $('#botsArea').innerHTML = `<div class="empty-state"><div class="ic">⚠️</div><div>${escapeHtml(e.message)}</div></div>`;
    }
  }

  function renderBots() {
    // Preserve existing log content before re-rendering
    let preservedLogHtml = null;
    let preservedScroll = 0;
    if (activeLogBotId) {
      const existingBody = $('#logBody_' + activeLogBotId);
      if (existingBody) {
        preservedLogHtml = existingBody.innerHTML;
        preservedScroll = existingBody.scrollTop;
      }
    }

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

    // Restore preserved log content
    if (activeLogBotId && preservedLogHtml) {
      const restoredBody = $('#logBody_' + activeLogBotId);
      if (restoredBody) {
        restoredBody.innerHTML = preservedLogHtml;
        restoredBody.scrollTop = preservedScroll;
      }
    }
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
          <button class="btn btn-sm btn-ghost" id="editor_${b.id}">📝 কোড</button>
          <button class="btn btn-sm btn-primary" id="download_${b.id}" title="বট ফাইল ডাউনলোড" style="padding:4px 8px">⬇️ ফাইল</button>
          <button class="btn btn-sm btn-danger" id="del_${b.id}">🗑</button>
        </div>
        <button class="btn btn-sm btn-ghost mt" id="toggleLog_${b.id}" style="width:100%;justify-content:center">
          📜 লগ ${activeLogBotId === b.id ? 'লুকান' : 'দেখুন'}
        </button>
        ${activeLogBotId === b.id ? `
          <div class="log-panel">
            <div class="log-head between">
              <span>লাইভ কনসোল — ${escapeHtml(b.name)}</span>
              <div style="display:flex;gap:4px">
                <button class="btn btn-sm btn-ghost" id="downloadLog_${b.id}" title="সম্পূর্ণ লগ ডাউনলোড">⬇️ লগ</button>
                <button class="btn btn-sm btn-ghost" id="clearLog_${b.id}">🧹 মুছুন</button>
              </div>
            </div>
            <div class="log-body" id="logBody_${b.id}"><div class="log-empty">কানেক্ট হচ্ছে...</div></div>
          </div>` : ''}
      </div>`;
  }

  function toggleLog(botId) {
    const wasActive = activeLogBotId === botId;
    if (wasActive) {
      // close
      if (socket) socket.emit('unsubscribe', botId);
      activeLogBotId = null;
    } else {
      if (activeLogBotId && socket) socket.emit('unsubscribe', activeLogBotId);
      activeLogBotId = botId;
      if (socket && socket.connected) socket.emit('subscribe', botId);
    }
    renderBots();
    if (activeLogBotId === botId) {
      loadLogViaHttp(botId);
    }
  }

  // Fetch logs via HTTP and render them (used as initial load + socket fallback)
  async function loadLogViaHttp(botId) {
    try {
      const data = await api('/api/bots/' + botId + '/logs?limit=5000');
      const body = $('#logBody_' + botId);
      if (!body) return;
      if (data.logs && data.logs.length) {
        body.innerHTML = data.logs.map(renderLogLine).join('');
        body.scrollTop = body.scrollHeight;
      } else if (body.querySelector('.log-empty')?.textContent === 'কানেক্ট হচ্ছে...') {
        body.innerHTML = '<div class="log-empty">এখনো কোনো লগ নেই। বট চালু হলে এখানে আউটপুট দেখা যাবে।</div>';
      }
    } catch (e) {
      const body = $('#logBody_' + botId);
      if (body) body.innerHTML = '<div class="log-empty">লগ লোড করা যায়নি: ' + escapeHtml(e.message) + '</div>';
    }
  }

  async function doAction(id, action) {
    // বোতাম খুঁজে disable করো
    const btn = document.getElementById(`${action}_${id}`);
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

    try {
      await api('/api/bots/' + id + '/' + action, { method: 'POST' });

      const msgs = { start: 'বট চালু হচ্ছে ▶', stop: 'বট বন্ধ হচ্ছে ⏹', restart: 'রিস্টার্ট হচ্ছে ↻' };
      toast(msgs[action] || action, 'success');

      // স্টপ হলে সাথে সাথে local state আপডেট করো (socket status আসার আগেই দেখাতে)
      if (action === 'stop') {
        const bot = bots.find(b => b.id === id);
        if (bot) {
          bot.status = 'stopped';
          bot.pid = null;
          updateBotCardStatus(id, bot);
        }
      }

      // server থেকে fresh data নাও
      await loadBots();
      // ২ বার আরো refresh — প্রসেস পুরোপুরি বন্ধ/চালু নিশ্চিত করতে
      setTimeout(loadBots, 1200);
      setTimeout(loadBots, 3000);
    } catch (e) {
      toast(e.message, 'error');
      // এররে বোতাম re-enable করো
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }
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
      const reqs = $('#botRequirements')?.value.trim();
      if (reqs) fd.append('requirements', reqs);
      const data = await api('/api/bots/upload', { method: 'POST', body: fd });
      toast('বট আপলোড হয়েছে!', 'success');
      // reset form
      selectedFile = null;
      $('#fileName').textContent = '';
      $('#botName').value = '';
      if ($('#botRequirements')) $('#botRequirements').value = '';
      $('#fileInput').value = '';
      $('#uploadBtn').disabled = true;
      await loadBots();
      // offer to start
      if (confirm('বটটি এখন চালু করবেন?')) {
        await api('/api/bots/' + data.bot.id + '/start', { method: 'POST' });
        toast('বট চালু হচ্ছে ▶', 'success');
        await loadBots();
        setTimeout(loadBots, 1000);
        setTimeout(loadBots, 2500);
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

  async function showEditor(b) {
    openModal(`
      <h2>📝 কোড এডিটর — ${escapeHtml(b.name)}</h2>
      <div style="display:flex;gap:12px;height:60vh;min-height:300px;margin-top:10px;">
        <div style="flex:1;overflow-y:auto;background:#060912;border:1px solid var(--border);border-radius:8px;padding:8px;" id="editorFileList">
          <div class="muted">লোড হচ্ছে...</div>
        </div>
        <div style="flex:2;display:flex;flex-direction:column;">
          <input type="text" id="editorCurrentFile" readonly style="background:#060912;color:#8ba2cc;border-bottom:0;border-radius:8px 8px 0 0;font-family:monospace;font-size:12px;padding:6px 12px;margin-bottom:0;" placeholder="ফাইল সিলেক্ট করুন" />
          <textarea id="editorContent" style="flex:1;resize:none;font-family:monospace;font-size:13px;border-radius:0 0 8px 8px;margin:0;padding:12px;white-space:pre;overflow-wrap:normal;overflow-x:auto;" placeholder="কোড এডিট করুন..." disabled></textarea>
        </div>
      </div>
      <div class="flex gap" style="justify-content:flex-end;margin-top:14px;">
        <button class="btn btn-ghost" onclick="document.getElementById('modal-bg').classList.remove('open')">বাতিল</button>
        <button class="btn btn-primary" id="saveEditor" disabled>সেভ করুন</button>
      </div>
    `);

    try {
      const data = await api('/api/bots/' + b.id + '/files');
      const list = $('#editorFileList');
      if (!data.files || !data.files.length) {
        list.innerHTML = '<div class="muted">কোনো ফাইল নেই</div>';
        return;
      }

      list.innerHTML = data.files.map(f => `<div class="editor-file-item" data-file="${escapeHtml(f)}">📄 ${escapeHtml(f)}</div>`).join('');

      let currentFile = null;
      $$('.editor-file-item').forEach(el => {
        el.addEventListener('click', async () => {
          $$('.editor-file-item').forEach(e => e.classList.remove('active'));
          el.classList.add('active');
          currentFile = el.dataset.file;
          $('#editorCurrentFile').value = currentFile;
          $('#editorContent').value = 'লোড হচ্ছে...';
          $('#editorContent').disabled = true;
          $('#saveEditor').disabled = true;
          try {
            const res = await api('/api/bots/' + b.id + '/files?file=' + encodeURIComponent(currentFile));
            $('#editorContent').value = res.content || '';
            $('#editorContent').disabled = false;
            $('#saveEditor').disabled = false;
          } catch (e) {
            $('#editorContent').value = 'Error: ' + e.message;
          }
        });
      });

      $('#saveEditor').addEventListener('click', async () => {
        if (!currentFile) return;
        const btn = $('#saveEditor');
        btn.disabled = true;
        btn.textContent = 'সেভ হচ্ছে...';
        try {
          await api('/api/bots/' + b.id + '/files', {
            method: 'PUT',
            body: JSON.stringify({ file: currentFile, content: $('#editorContent').value })
          });
          toast('ফাইল সেভ হয়েছে', 'success');
        } catch (e) {
          toast(e.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = 'সেভ করুন';
        }
      });
    } catch (e) {
      $('#editorFileList').innerHTML = `<div class="error-msg">${escapeHtml(e.message)}</div>`;
    }
  }

  function showDocs() {
    const key = user ? user.apiKey : 'YOUR_API_KEY';
    const url = location.origin;
    openModal(`
      <h2>📡 API Key ও Base URL</h2>
      <p class="muted" style="margin-bottom:16px;font-size:13px">
        নিচের দুটো মান কপি করে আপনার স্ক্রিপ্ট/CI-তে ব্যবহার করুন
      </p>
      <div class="form-group">
        <label>API Key (Header: X-API-Key)</label>
        <div class="cred-row">
          <code style="flex:1" id="modalKey">${escapeHtml(key)}</code>
          <button class="btn btn-sm" id="modalCopyKey">📋 কপি</button>
        </div>
      </div>
      <div class="form-group">
        <label>Base URL</label>
        <div class="cred-row">
          <code style="flex:1" id="modalUrl">${escapeHtml(url)}</code>
          <button class="btn btn-sm" id="modalCopyUrl">📋 কপি</button>
        </div>
      </div>
      <h3 style="margin-top:18px;font-size:15px">📝 সব এন্ডপয়েন্ট</h3>
      <div style="background:#060912;padding:14px;border-radius:10px;overflow:auto;font-size:12px;margin-top:8px;color:#c7e8c7">
        <div><strong>POST</strong> /api/auth/register &nbsp;— রেজিস্ট্রেশন</div>
        <div><strong>POST</strong> /api/auth/login &nbsp;&nbsp;&nbsp;— লগইন</div>
        <div><strong>GET</strong>&nbsp;&nbsp; /api/bots &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;— বট লিস্ট</div>
        <div><strong>POST</strong> /api/bots/upload &nbsp;&nbsp;— ফাইল আপলোড</div>
        <div><strong>POST</strong> /api/deploy &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;— আপলোড + স্টার্ট</div>
        <div><strong>POST</strong> /api/bots/ID/start &nbsp;— চালু</div>
        <div><strong>POST</strong> /api/bots/ID/stop &nbsp;&nbsp;— বন্ধ</div>
        <div><strong>POST</strong> /api/bots/ID/restart — রিস্টার্ট</div>
        <div><strong>GET</strong>&nbsp;&nbsp; /api/bots/ID/logs &nbsp;&nbsp;— লগ দেখুন</div>
        <div><strong>DELETE</strong> /api/bots/ID &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;— ডিলিট</div>
      </div>
      <div class="flex" style="justify-content:flex-end;margin-top:14px">
        <button class="btn btn-ghost" id="modalCloseDocs">বন্ধ করুন</button>
      </div>
    `);
    $('#modalCopyKey').addEventListener('click', () => { navigator.clipboard.writeText(key); toast('API Key কপি হয়েছে', 'success'); });
    $('#modalCopyUrl').addEventListener('click', () => { navigator.clipboard.writeText(url); toast('Base URL কপি হয়েছে', 'success'); });
    $('#modalCloseDocs').addEventListener('click', closeModal);
  }
  function docsText() { return ''; }

  function logout() {
    if (socket) socket.disconnect();
    token = null; user = null;
    localStorage.removeItem('token');
    if (pollingTimer) clearInterval(pollingTimer);
    location.hash = '';
    route();
  }

  // poll status every 3s (refresh badges + logs cheaply)
  function startPolling() {
    if (pollingTimer) clearInterval(pollingTimer);
    pollingTimer = setInterval(loadBots, 3000);
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
