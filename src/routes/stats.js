// src/routes/stats.js — সার্ভার ও প্রতিটি বটের CPU/RAM stats
// GET /api/stats        → সার্ভারের সার্বিক stats
// GET /api/stats/bots   → প্রতিটি চলমান বটের memory usage

const express = require('express');
const os = require('os');
const { execSync } = require('child_process');
const store = require('../../db/store');
const pm = require('../processManager');

const router = express.Router();

// ---------- CPU usage (দুটো snapshot-এর পার্থক্য থেকে সঠিক %) ----------
function getCpuPercent() {
  return new Promise((resolve) => {
    const s1 = os.cpus().map(c => ({ ...c.times }));
    setTimeout(() => {
      const s2 = os.cpus();
      let idleDiff = 0, totalDiff = 0;
      s2.forEach((cpu, i) => {
        const t1 = Object.values(s1[i]).reduce((a, b) => a + b, 0);
        const t2 = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        idleDiff  += cpu.times.idle  - s1[i].idle;
        totalDiff += t2 - t1;
      });
      const pct = totalDiff === 0 ? 0 : ((1 - idleDiff / totalDiff) * 100);
      resolve(Math.min(100, Math.max(0, +pct.toFixed(1))));
    }, 500);
  });
}

// ---------- Per-process memory (Windows: tasklist, Linux/Mac: /proc) ----------
function getProcMemMB(pid) {
  if (!pid) return null;
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `tasklist /fi "PID eq ${pid}" /fo csv /nh`,
        { encoding: 'utf8', timeout: 2000 }
      ).trim();
      if (!out || out.toLowerCase().includes('no tasks')) return null;
      // "name","pid","session","num","mem K"
      const parts = out.split('\n')[0].split(',');
      if (parts.length < 5) return null;
      const memKStr = parts[4].replace(/[^0-9]/g, '');
      const memKB = parseInt(memKStr, 10);
      return isNaN(memKB) ? null : +(memKB / 1024).toFixed(1);
    } else {
      // Linux: /proc/<pid>/status → VmRSS
      const status = require('fs').readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      return m ? +(parseInt(m[1], 10) / 1024).toFixed(1) : null;
    }
  } catch (_) {
    return null;
  }
}

// bytes → সুন্দর স্ট্রিং
function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576)    return (b / 1048576).toFixed(1)    + ' MB';
  if (b >= 1024)       return (b / 1024).toFixed(0)       + ' KB';
  return b + ' B';
}

// seconds → "২ দিন ৩ ঘণ্টা" style
function fmtUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(' ');
}

// ---------- GET /api/stats ----------
router.get('/', async (req, res) => {
  try {
    const cpuPercent  = await getCpuPercent();
    const totalMem    = os.totalmem();
    const freeMem     = os.freemem();
    const usedMem     = totalMem - freeMem;
    const memPercent  = +((usedMem / totalMem) * 100).toFixed(1);

    const serverProc  = process.memoryUsage();
    const cpus        = os.cpus();

    // চলমান বটের সংখ্যা ও তাদের memory
    const allBots     = req.user.is_admin ? store.getAllBots() : store.getBotsByUser(req.user.id);
    const running     = allBots.filter(b => pm.status(b.id) === 'running');
    let botsMemMB     = 0;
    const botStats    = running.map(b => {
      const desc = pm.describe(b.id);
      const memMB = getProcMemMB(desc.pid);
      if (memMB) botsMemMB += memMB;
      return {
        id:       b.id,
        name:     b.name,
        language: b.language,
        pid:      desc.pid,
        status:   desc.status,
        uptimeSec: desc.startedAt ? Math.floor((Date.now() - desc.startedAt) / 1000) : 0,
        memMB,
      };
    });

    res.json({
      server: {
        platform:     os.platform(),
        arch:         os.arch(),
        nodeVersion:  process.version,
        cpuModel:     cpus[0]?.model || 'Unknown',
        cpuCores:     cpus.length,
        cpuPercent,                              // 0–100
        mem: {
          total:       totalMem,
          used:        usedMem,
          free:        freeMem,
          percent:     memPercent,               // 0–100
          totalFmt:    fmtBytes(totalMem),
          usedFmt:     fmtBytes(usedMem),
          freeFmt:     fmtBytes(freeMem),
        },
        panelMem: {                              // এই Node.js প্রসেসের নিজের RAM
          rss:         serverProc.rss,
          rssFmt:      fmtBytes(serverProc.rss),
          heapUsed:    serverProc.heapUsed,
          heapFmt:     fmtBytes(serverProc.heapUsed),
        },
        uptimeSec:     Math.floor(process.uptime()),
        uptimeFmt:     fmtUptime(process.uptime()),
        osUptimeSec:   Math.floor(os.uptime()),
        osUptimeFmt:   fmtUptime(os.uptime()),
      },
      bots: {
        total:         allBots.length,
        running:       running.length,
        stopped:       allBots.length - running.length,
        totalMemMB:    +botsMemMB.toFixed(1),
        list:          botStats,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'Stats error: ' + e.message });
  }
});

module.exports = router;
