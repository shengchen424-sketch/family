#!/usr/bin/env node
/**
 * 家庭资产与开销 — VPS 服务端（Node.js，无第三方依赖）
 *
 * 启动：
 *   FAMILY_KEYS="密钥1:Chen,密钥2:Liza" PORT=8443 TLS_CERT=/path/cert.pem TLS_KEY=/path/key.pem node server.js
 *   不设 TLS_CERT / TLS_KEY 时以 HTTP 运行（只建议在内网或前面有反向代理时使用）。
 *
 * 访问：第一次打开 https://你的IP:8443/?k=密钥 ，之后浏览器会记住，不用再输入。
 * 数据：DATA_DIR（默认 ./data）下每个集合一个 JSON 文件；收据照片放在 data/receipts。
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');
const COLLECTIONS = ['accounts', 'balances', 'rates', 'tx', 'recurring', 'categories', 'members', 'reminders', 'snapshots', 'audit'];
const MAX_BODY = 12 * 1024 * 1024;
const PAGE = path.join(__dirname, 'public', 'index.html');

fs.mkdirSync(RECEIPT_DIR, { recursive: true });

// ---------- access keys: one key per person, so the audit log shows who changed what ----------
function loadKeys() {
  const map = {};
  const raw = process.env.FAMILY_KEYS || '';
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
    const i = pair.indexOf(':');
    if (i > 0) map[pair.slice(0, i)] = pair.slice(i + 1);
  });
  if (!Object.keys(map).length) {
    // first run without FAMILY_KEYS: create a key for the owner and remember it on disk
    const keyFile = path.join(DATA_DIR, 'owner-key.txt');
    let key;
    if (fs.existsSync(keyFile)) key = fs.readFileSync(keyFile, 'utf8').trim();
    else {
      key = crypto.randomBytes(18).toString('base64url');
      fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 });
      console.log('已生成访问密钥（请保存）：' + key + '  （保存在 ' + keyFile + '）');
    }
    map[key] = 'Chen';
  }
  return map;
}
const KEYS = loadKeys();

function keyFromRequest(req, url) {
  const q = url.searchParams.get('k');
  if (q && KEYS[q]) return q;
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('k='));
  if (cookie) {
    const v = decodeURIComponent(cookie.slice(2));
    if (KEYS[v]) return v;
  }
  return null;
}

// ---------- document store (one JSON file per collection, written atomically) ----------
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  const file = path.join(DATA_DIR, name + '.json');
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { obj = {}; }
  cache[name] = obj;
  return obj;
}
function save(name) {
  const file = path.join(DATA_DIR, name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache[name]));
  fs.renameSync(tmp, file);
}
// serialise writes so two phones saving at once cannot interleave
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function assertName(name) {
  if (!COLLECTIONS.includes(name)) throw new Error('未知的集合：' + name);
}

const API = {
  getMe(ctx) { return ctx.me; },

  getSnapshot(names) {
    const out = {};
    (names || COLLECTIONS).forEach(n => {
      assertName(n);
      const m = load(n);
      out[n] = Object.keys(m).map(id => ({ id, data: m[id] }));
    });
    return out;
  },

  setDoc(name, id, data) {
    assertName(name);
    if (!id || typeof id !== 'string') throw new Error('缺少编号');
    return serial(() => {
      const m = load(name);
      m[id] = data;
      save(name);
      return true;
    });
  },

  delDoc(name, id) {
    assertName(name);
    return serial(() => {
      const m = load(name);
      delete m[id];
      save(name);
      return true;
    });
  },

  uploadReceipt(dataUrl) {
    const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp|heic|heif));base64,(.*)$/);
    if (!m) throw new Error('图片格式不正确');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 4 * 1024 * 1024) throw new Error('图片太大');
    const id = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(RECEIPT_DIR, id + '.bin'), bytes);
    fs.writeFileSync(path.join(RECEIPT_DIR, id + '.type'), m[1]);
    return { fileId: id };
  },

  getReceipt(fileId) {
    if (!/^[a-f0-9]{24}$/.test(String(fileId || ''))) throw new Error('编号不正确');
    const bin = path.join(RECEIPT_DIR, fileId + '.bin');
    const type = fs.readFileSync(path.join(RECEIPT_DIR, fileId + '.type'), 'utf8');
    return 'data:' + type + ';base64,' + fs.readFileSync(bin).toString('base64');
  }
};

// ---------- HTTP ----------
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, headers || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('请求太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = (process.env.TLS_CERT && process.env.TLS_KEY)
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handle)
  : http.createServer(handle);

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const key = keyFromRequest(req, url);

  if (req.method === 'GET' && url.pathname === '/') {
    if (!key) return send(res, 403, '需要访问密钥。请用 ?k=你的密钥 打开。', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (url.searchParams.get('k')) {
      // remember the key on this device, then drop it from the address bar
      return send(res, 302, '', {
        Location: '/',
        'Set-Cookie': 'k=' + encodeURIComponent(key) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000'
      });
    }
    const html = fs.readFileSync(PAGE, 'utf8');
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!key) return send(res, 403, JSON.stringify({ ok: false, error: '未授权' }), { 'Content-Type': 'application/json' });
    const fn = url.pathname.slice(5);
    if (!Object.prototype.hasOwnProperty.call(API, fn)) return send(res, 404, JSON.stringify({ ok: false, error: '未知函数' }), { 'Content-Type': 'application/json' });
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const args = Array.isArray(body.args) ? body.args : [];
      const result = await API[fn]({ me: KEYS[key] }, ...args.slice(0, 4).map(a => a));
      return send(res, 200, JSON.stringify({ ok: true, result: result === undefined ? null : result }), { 'Content-Type': 'application/json' });
    } catch (e) {
      return send(res, 200, JSON.stringify({ ok: false, error: String(e && e.message || e) }), { 'Content-Type': 'application/json' });
    }
  }

  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

// Functions that need the caller as first argument are wrapped above; the rest take their arguments directly.
for (const fn of Object.keys(API)) {
  if (fn === 'getMe') continue;
  const raw = API[fn];
  API[fn] = (ctx, ...args) => raw(...args);
}

server.listen(PORT, HOST, () => {
  const scheme = (process.env.TLS_CERT && process.env.TLS_KEY) ? 'https' : 'http';
  console.log('家庭资产服务已启动：' + scheme + '://' + HOST + ':' + PORT + '  数据目录：' + DATA_DIR);
});

module.exports = { API, KEYS, DATA_DIR };
