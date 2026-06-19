# 🤖 Bot Hosting Panel

একটি সম্পূর্ণ **মাল্টি-ইউজার বট/স্ক্রিপ্ট হোস্টিং প্যানেল**। ইউজাররা রেজিস্টার করে নিজেদের **Python / Node.js / Bash** স্ক্রিপ্ট বা বট আপলোড করে চালাতে পারবে — ওয়েব UI থেকে অথবা REST API দিয়ে। Railway-এ ১-ক্লিকে ডিপ্লয়যোগ্য।

## ✨ ফিচার

- 🔐 **মাল্টি-ইউজার** — রেজিস্ট্রেশন/লগইন, প্রত্যেকের আলাদা **API Key** ও **Base URL**
- 📤 **ফাইল আপলোড** — `.py` / `.js` / `.mjs` / `.sh` একক ফাইল, অথবা পুরো প্রজেক্ট `.zip` (requirements.txt বা package.json সহ অটো-ইনস্টল)
- 🌐 **ভাষা সিলেক্ট** — Python / Node.js / Bash
- ▶️ **Start / Stop / Restart / Delete** — প্রতিটি বট আলাদা সাবপ্রসেসে চলে
- 📜 **রিয়েল-টাইম লগ** — Socket.IO দিয়ে লাইভ কনসোল
- ♻️ **অটো-রিস্টার্ট** — ক্র্যাশ হলে স্বয়ংক্রিয়ভাবে আবার চালু (ঐচ্ছিক)
- 🔌 **সম্পূর্ণ REST API** — সব কাজ API Key দিয়ে করা যায়
- ⚙️ **প্রতি-বট এনভায়রনমেন্ট ভেরিয়েবল** — টোকেন/সিক্রেট সেফলি সংরক্ষণ
- 🎨 **সুন্দর ডার্ক UI** — রেসপন্সিভ, মোবাইল-ফ্রেন্ডলি

## 🚀 লোকালে চালানো

```bash
# ১. ডিপেন্ডেন্সি ইনস্টল
npm install

# ২. env ফাইল তৈরি
cp .env.example .env
#   এরপর JWT_SECRET ও ADMIN_PASSWORD পরিবর্তন করুন

# ৩. চালু করুন
npm start
```

ব্রাউজারে যান: **http://localhost:3000**

প্রথমবার চালু হলে অ্যাডমিন একাউন্ট স্বয়ংক্রিয়ভাবে তৈরি হবে:
- ইউজারনেম: `ADMIN_USERNAME` (ডিফল্ট `admin`)
- পাসওয়ার্ড: `ADMIN_PASSWORD` (ডিফল্ট `admin123`)

> ⚠️ প্রোডাকশনে যাওয়ার আগে অবশ্যই `ADMIN_PASSWORD` ও `JWT_SECRET` পরিবর্তন করুন।

## ☁️ Railway-এ ডিপ্লয় করুন

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/new)

### ধাপসমূহ:
1. Railway-এ লগইন করে **New Project → Deploy from GitHub repo** (এই কোড push করুন) অথবা "Deploy from GitHub" এ গিয়ে রিপোজিটরি সিলেক্ট করুন।
2. Railway স্বয়ংক্রিয়ভাবে `package.json` থেকে `npm install` ও `npm start` রান করবে।
3. **Variables** ট্যাবে এই env ভেরিয়েবলগুলো সেট করুন:
   - `JWT_SECRET` — একটি দীর্ঘ র্যান্ডম স্ট্রিং
   - `ADMIN_USERNAME` — অ্যাডমিন ইউজারনেম (যেমন `admin`)
   - `ADMIN_PASSWORD` — শক্তিশালী পাসওয়ার্ড
   - `DATA_DIR` — পারসিস্টেন্ট ভলিউম পাথ (যেমন `/data`)
   - `DISABLE_SIGNUP` — পাবলিক রেজিস্ট্রেশন বন্ধ করতে `true` সেট করুন (শুধু admin-managed)
4. **Settings → Networking → Generate Domain** ক্লিক করে একটি পাবলিক URL নিন।
5. **পারসিস্টেন্ট ভলিউম** (গুরুত্বপূর্ণ!):
   - Settings → Volumes → **Add Volume**
   - Mount path: `/data`
   - এটা ছাড়া রিডিপ্লয় হলে DB ও আপলোড করা বট মুছে যাবে।
6. আপনার পাবলিক URL-এ গেলেই প্যানেল চালু পাবেন।

> দ্রষ্টব্য: Railway free/hobby plan-এ কিছু স্লিপ-অ্যাটাচড স্টোরেজ থাকে না — ডেটা রাখা জরুরি হলে **Volume** যুক্ত করতে ভুলবেন না।

## 📡 REST API

সব এন্ডপয়েন্টে অথেনটিকেশন লাগে — Header:
```
X-API-Key: bh_xxxxxxxxxxxxxxxx
```
(অথবা `Authorization: Bearer <jwt>`)

### অথ
| Method | Endpoint | বর্ণনা |
|--------|----------|--------|
| POST | `/api/auth/register` | রেজিস্ট্রেশন — `{username, password}` → `{token, user}` |
| POST | `/api/auth/login` | লগইন → JWT ও user (API Key সহ) |
| GET  | `/api/auth/me` | বর্তমান ইউজার তথ্য |
| POST | `/api/auth/regenerate-key` | নতুন API Key তৈরি |

### বট ম্যানেজমেন্ট
| Method | Endpoint | বর্ণনা |
|--------|----------|--------|
| GET | `/api/bots` | বট লিস্ট |
| GET | `/api/bots/meta/languages` | সমর্থিত ভাষা |
| POST | `/api/bots/upload` | ফাইল/জিপ আপলোড (multipart: `file`, `name`, `language`, `autoRestart`, `entryFile`) |
| GET | `/api/bots/:id` | একটি বটের তথ্য |
| PATCH | `/api/bots/:id` | সেটিংস আপডেট (`name`, `env`, `autoRestart`) |
| POST | `/api/bots/:id/start` | চালু |
| POST | `/api/bots/:id/stop` | বন্ধ |
| POST | `/api/bots/:id/restart` | রিস্টার্ট |
| GET | `/api/bots/:id/logs` | লগ (`?after=<id>&limit=500`) |
| DELETE | `/api/bots/:id/logs` | লগ মুছুন |
| DELETE | `/api/bots/:id` | বট ডিলিট |

### এক-কলে ডিপ্লয় (CI ফ্রেন্ডলি)
`POST /api/deploy` (multipart) — আপলোড করে একসাথে চালুও করে দেয়।

```bash
curl -H "X-API-Key: bh_xxx" \
  -F "file=@bot.py" \
  -F "name=MyBot" \
  -F "language=python" \
  -F "start=1" \
  -F "env_BOT_TOKEN=123456:ABC" \
  https://your-app.up.railway.app/api/deploy
```

রেসপন্সে `bot.id`, `status`, `baseUrl`, `logsUrl` পাবেন।

## 📂 প্রজেক্ট স্ট্রাকচার

```
bot host/
├── server.js              # Express + Socket.IO এন্ট্রিপয়েন্ট
├── package.json
├── railway.json / Procfile
├── .env.example
├── db/
│   └── store.js           # SQLite (users, bots, logs)
└── src/
    ├── config.js
    ├── auth.js            # JWT + API Key মিডলওয়্যার
    ├── languages.js       # রানটাইম কনফিগ
    ├── processManager.js  # সাবপ্রসেস ম্যানেজার
    └── routes/
        ├── bots.js        # বট CRUD + lifecycle
        └── deploy.js      # এক-কলে ডিপ্লয়
└── public/
    ├── index.html
    ├── style.css          # ডার্ক UI
    └── app.js             # ফ্রন্টএন্ড SPA
```

## 🔒 নিরাপত্তা নোট

- স্ক্রিপ্ট সাবপ্রসেস হিসেবে চলে — প্রতিটির আলাদা ওয়ার্কিং ডিরেক্টরি।
- পাবলিক রেজিস্ট্রেশন বন্ধ করতে `DISABLE_SIGNUP=true`।
- কোনো ইউজারের বট অন্য ইউজার দেখতে/চালাতে পারবে না (শুধু admin সব দেখতে পারে)।
- উচ্চ-নিরাপত্তার প্রয়োজনে (একাধিক ইউজারের untrusted code) Docker কন্টেইনার আইসোলেশন বিবেচনা করুন।

## 📜 লাইসেন্স

MIT
