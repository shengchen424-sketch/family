#!/usr/bin/env node
/**
 * 家庭资产与开销 — VPS 服务端（Node.js，无第三方依赖）
 *
 * 启动：
 *   FAMILY_KEYS="密钥1:Chen,密钥2:Liza" PORT=8443 TLS_CERT=/path/cert.pem TLS_KEY=/path/key.pem node server.js
 *   密钥也可以放在 data/keys.txt（每行 "密钥:名字"），这样不用写进 systemd 单元。两处都没有时自动生成 owner 密钥。
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
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const COLLECTIONS = ['accounts', 'balances', 'rates', 'tx', 'recurring', 'categories', 'members', 'reminders', 'snapshots', 'audit', 'goals', 'settings'];
const MAX_BODY = 12 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PAGE = path.join(PUBLIC_DIR, 'index.html');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
const vm = require('vm');
// Seed data (2026-10 workbook) is served through the API, so the page itself holds no financial figures.
function loadSeed() {
  try {
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'tests', 'seed.js'), 'utf8'), ctx);
    return { accounts: ctx.SEED_ACCOUNTS || [], rate: ctx.SEED_RATE, month: ctx.SEED_MONTH };
  } catch (e) { return { accounts: [], rate: null, month: null }; }
}
const SEED = loadSeed();
// Build id = hash of the page, used for the service-worker cache name
function buildId() { try { return crypto.createHash('sha1').update(fs.readFileSync(PAGE)).digest('hex').slice(0, 10); } catch (e) { return 'dev'; } }
const STATIC_TYPES = { '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

fs.mkdirSync(RECEIPT_DIR, { recursive: true });

// ---------- access keys: one key per person, so the audit log shows who changed what ----------
// Keys come from FAMILY_KEYS ("key:Name,key2:Name2") and/or DATA_DIR/keys.txt (one "key:Name" per line,
// '#' starts a comment). keys.txt keeps secrets out of the systemd unit and out of git.
const KEYS_FILE = path.join(DATA_DIR, 'keys.txt');
function addPairs(map, text, sep) {
  String(text || '').split(sep).map(s => s.trim()).filter(s => s && s[0] !== '#').forEach(pair => {
    const i = pair.indexOf(':');
    if (i > 0 && pair.slice(0, i).trim().length >= 6) map[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
}
function loadKeys() {
  const map = {};
  addPairs(map, process.env.FAMILY_KEYS, ',');
  try { addPairs(map, fs.readFileSync(KEYS_FILE, 'utf8'), '\n'); } catch (e) { /* no keys file */ }
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
// The owner (first key's name, or FAMILY_OWNER) may restore backups and manage members; everyone may record.
const OWNER = process.env.FAMILY_OWNER || KEYS[Object.keys(KEYS)[0]];
const Logic = require('./src/logic.js');

// Brute-force protection: after MAX_FAILS wrong keys from one address within WINDOW, that address waits BLOCK_MS.
const MAX_FAILS = 8, WINDOW_MS = 10 * 60e3, BLOCK_MS = 15 * 60e3;
const fails = new Map();
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'; }
function blocked(ip) {
  const f = fails.get(ip);
  return !!(f && f.until && f.until > Date.now());
}
function noteFail(ip) {
  const now = Date.now();
  let f = fails.get(ip);
  if (!f || now - f.first > WINDOW_MS) f = { first: now, n: 0, until: 0 };
  f.n++;
  if (f.n >= MAX_FAILS) { f.until = now + BLOCK_MS; f.n = 0; f.first = now; console.log('密钥错误次数过多，暂时拒绝：' + ip); }
  fails.set(ip, f);
}
function noteOk(ip) { fails.delete(ip); }
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (now - f.first > WINDOW_MS && !(f.until > now)) fails.delete(ip); }, 60e3).unref();

function keyFromRequest(req, url) {
  const q = url.searchParams.get('k');
  if (q && KEYS[q]) return q;
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('k='));
  let v = null;
  if (cookie) { try { v = decodeURIComponent(cookie.slice(2)); } catch (e) { v = null; } }
  if (v && KEYS[v]) return v;
  if (q || v) noteFail(clientIp(req));
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
// Server-side sanity checks so a buggy client (or a hand-written request) cannot corrupt the books.
function validateDoc(name, d) {
  const num = v => v == null || v === '' || (typeof v === 'number' && isFinite(v));
  if (name === 'tx') {
    const err = Logic.validateTx(d);
    if (err) throw new Error(err);
    if (!(d.month === String(d.date).slice(0, 7))) throw new Error('月份与日期不一致');
    if (d.note != null && String(d.note).length > 200) throw new Error('备注太长');
  }
  if (name === 'balances') {
    if (!/^\d{4}-\d{2}$/.test(d.month || '') || !d.accountId) throw new Error('余额记录缺少月份或账户');
    if (!(typeof d.amount === 'number' && isFinite(d.amount) && d.amount >= 0)) throw new Error('余额必须是不小于 0 的数字');
    if (d.asOf && !Logic.isDate(d.asOf)) throw new Error('截至日期不正确');
  }
  if (name === 'accounts') {
    if (!d.name || String(d.name).length > 80) throw new Error('账户名称不正确');
    if (!['asset', 'liability'].includes(d.kind)) throw new Error('账户类别不正确');
    if (!['MYR', 'SGD'].includes(d.currency)) throw new Error('币种不支持');
    ['rate', 'monthlyPayment', 'settlementQuote', 'sort'].forEach(k => { if (!num(d[k])) throw new Error('数值字段不正确：' + k); });
  }
  if (name === 'rates' && !(d.sgdMyr > 0)) throw new Error('汇率必须大于 0');
  if (name === 'categories' && (!d.name || !['expense', 'income'].includes(d.type) || !num(d.budget))) throw new Error('分类数据不正确');
  if (name === 'recurring' && (!d.name || !(d.amount > 0) || !Logic.TX_TYPES.includes(d.type))) throw new Error('定期项目数据不正确');
  if (name === 'goals' && (!d.name || !(d.target > 0))) throw new Error('目标数据不正确');
  if (JSON.stringify(d).length > 20000) throw new Error('记录太大');
}
const AUDIT_MAX = 2000;
function pruneAudit(m) {
  const ids = Object.keys(m);
  if (ids.length <= AUDIT_MAX) return;
  ids.sort((a, b) => String(m[a].at || '').localeCompare(String(m[b].at || '')));
  ids.slice(0, ids.length - AUDIT_MAX).forEach(id => { delete m[id]; });
}
function removeReceipt(fileId) {
  if (!/^[a-f0-9]{24}$/.test(String(fileId || ''))) return;
  ['.bin', '.type'].forEach(ext => { try { fs.unlinkSync(path.join(RECEIPT_DIR, fileId + ext)); } catch (e) { /* already gone */ } });
}

const API = {
  getMe(ctx) { return { name: ctx.me, owner: ctx.me === OWNER }; },

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
    if (!id || typeof id !== 'string' || id.length > 120) throw new Error('缺少编号');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数据格式不正确');
    validateDoc(name, data);
    return serial(() => {
      const m = load(name);
      m[id] = data;
      if (name === 'audit') pruneAudit(m);
      save(name);
      return true;
    });
  },

  delDoc(name, id) {
    assertName(name);
    return serial(() => {
      const m = load(name);
      const old = m[id];
      delete m[id];
      save(name);
      if (name === 'tx' && old && old.receiptId) removeReceipt(old.receiptId);
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

  getSeed() { return SEED; },

  // Full backup / restore. Restore merges document by document (existing ids are overwritten, nothing is deleted).
  exportAll() { return API.getSnapshot(COLLECTIONS); },
  importAll(ctx, data) {
    if (ctx.me !== OWNER) throw new Error('只有 ' + OWNER + ' 可以恢复备份');
    if (!data || typeof data !== 'object') throw new Error('备份格式不正确');
    return serial(() => {
      let n = 0;
      Object.keys(data).forEach(name => {
        if (!COLLECTIONS.includes(name) || !Array.isArray(data[name])) return;
        const m = load(name);
        data[name].forEach(r => { if (r && typeof r.id === 'string' && r.data && typeof r.data === 'object') { m[r.id] = r.data; n++; } });
        save(name);
      });
      return { imported: n };
    });
  },

  listBackups() {
    try { return fs.readdirSync(BACKUP_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch (e) { return []; }
  },
  restoreBackup(ctx, day) {
    if (ctx.me !== OWNER) throw new Error('只有 ' + OWNER + ' 可以恢复备份');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error('日期不正确');
    const dir = path.join(BACKUP_DIR, day);
    if (!fs.existsSync(dir)) throw new Error('没有这一天的备份');
    const data = {};
    COLLECTIONS.forEach(n => {
      const f = path.join(dir, n + '.json');
      if (!fs.existsSync(f)) return;
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      data[n] = Object.keys(m).map(id => ({ id, data: m[id] }));
    });
    return API.importAll(ctx, data);
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
  res.writeHead(code, Object.assign({
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'"
  }, headers || {}));
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
  const ip = clientIp(req);
  if (blocked(ip) && (url.pathname.startsWith('/api/') || url.searchParams.get('k'))) {
    return send(res, 429, JSON.stringify({ ok: false, error: '密钥错误次数过多，请 15 分钟后再试', code: 'throttled' }), { 'Content-Type': 'application/json', 'Retry-After': '900' });
  }
  const key = keyFromRequest(req, url);
  if (key) noteOk(ip);

  if (req.method === 'GET' && url.pathname === '/') {
    // The page is an empty shell (no data inside), so it is served to everyone; every API call checks the key.
    // A valid ?k= is remembered in a cookie (no redirect: some phone browsers drop cookies set on a redirect);
    // the page also keeps the key in localStorage and passes ?k= on API calls, so cookies are optional.
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (key && url.searchParams.get('k')) {
      headers['Set-Cookie'] = 'k=' + encodeURIComponent(key) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000';
    }
    return send(res, 200, fs.readFileSync(PAGE, 'utf8').replace('__BUILD__', buildId()), headers);
  }
  if (req.method === 'GET' && (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/icons/'))) {
    const rel = url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (!/^(sw\.js|manifest\.webmanifest|icons\/[\w.-]+\.png)$/.test(rel) || !fs.existsSync(file)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const type = STATIC_TYPES[path.extname(rel)] || 'application/octet-stream';
    if (rel === 'sw.js') {
      const body = fs.readFileSync(file, 'utf8').replace('__BUILD__', buildId());
      return send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/' });
    }
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
    const name = path.basename(url.pathname);
    const file = path.join(VENDOR_DIR, name);
    if (!/^[\w.-]+\.js$/.test(name) || !fs.existsSync(file)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800' });
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(res, 204, '');
  // Logout: the cookie is HttpOnly, so only the server can clear it; then back to the login screen.
  if (req.method === 'GET' && url.pathname === '/logout') {
    return send(res, 302, '', { Location: '/', 'Set-Cookie': 'k=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }
  // Play Store (TWA) verification file and the privacy policy page, both public
  if (req.method === 'GET' && (url.pathname === '/.well-known/assetlinks.json' || url.pathname === '/privacy.html')) {
    const file = path.join(PUBLIC_DIR, url.pathname.slice(1));
    if (!fs.existsSync(file)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const type = url.pathname.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8';
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!key) return send(res, 403, JSON.stringify({ ok: false, error: '未授权', code: 'unauthorized' }), { 'Content-Type': 'application/json' });
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
  if (fn === 'getMe' || fn === 'importAll' || fn === 'restoreBackup') continue;
  const raw = API[fn];
  API[fn] = (ctx, ...args) => raw(...args);
}

// ---------- automatic month-end snapshot ----------
// On the first run of a new month (checked every 6 h), lock last month's family totals if nobody did it by hand.
function withIds(m) { const o = {}; Object.keys(m).forEach(id => { o[id] = Object.assign({}, m[id], { id }); }); return o; }
function autoSnapshot() {
  try {
    const prev = Logic.addMonths(Logic.nowMonth(), -1);
    const snaps = load('snapshots');
    if (snaps[prev]) return;
    const balances = load('balances');
    if (!Object.keys(balances).some(k => balances[k].month <= prev)) return;
    const accs = withIds(load('accounts')), rates = load('rates');
    const t = Logic.familyTotals(accs, balances, rates, prev);
    const biz = Logic.businessTotals(accs, balances, rates, prev);
    serial(() => {
      const r2 = n => Math.round(n * 100) / 100;
      snaps[prev] = { month: prev, assets: r2(t.assets), liabs: r2(t.liabs), net: r2(t.net), liquid: r2(t.liquid), bizNet: r2(biz.net), missing: t.missing, lockedAt: new Date().toISOString(), byId: 'auto', auto: true };
      save('snapshots');
      const audit = load('audit');
      audit['auto-' + prev] = { at: new Date().toISOString(), byId: 'auto', action: '自动月结', ref: prev, summary: prev + ' 净资产 RM ' + r2(t.net).toLocaleString('en-MY') };
      save('audit');
      console.log('已自动锁定 ' + prev + ' 快照');
    });
  } catch (e) { console.error('自动月结失败', e); }
}
setTimeout(autoSnapshot, 5000);
setInterval(autoSnapshot, 6 * 3600e3).unref();

// ---------- automatic posting of recurring items flagged autoPost (checked hourly) ----------
function autoPostRecurring() {
  try {
    const today = Logic.todayKuching(), m = today.slice(0, 7);
    const recs = withIds(load('recurring')), txm = load('tx');
    const txs = Object.keys(txm).map(id => Object.assign({}, txm[id], { id }));
    const due = Logic.dueAutoPost(Object.keys(recs).map(k => recs[k]), txs, today);
    if (!due.length) return;
    serial(() => {
      const audit = load('audit');
      due.forEach(it => {
        const tx = Logic.txFromRecurring(it, m);
        tx.member = tx.member || 'shared';
        if (Logic.validateTx(tx)) return;
        tx.byId = 'auto'; tx.createdAt = tx.updatedAt = new Date().toISOString(); tx.source = 'auto';
        txm[it.key] = tx;
        audit['auto-' + it.key] = { at: tx.createdAt, byId: 'auto', action: '自动入账', ref: it.key, summary: (it.rec.name || '') + ' RM ' + tx.amount };
      });
      save('tx'); save('audit');
      console.log('自动入账 ' + due.length + ' 笔');
    });
  } catch (e) { console.error('自动入账失败', e); }
}
setTimeout(autoPostRecurring, 8000);
setInterval(autoPostRecurring, 3600e3).unref();

// ---------- daily on-disk backup of the JSON collections (last 30 days kept) ----------
function dailyBackup() {
  try {
    const day = Logic.todayKuching();
    const dir = path.join(BACKUP_DIR, day);
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    COLLECTIONS.forEach(n => { const f = path.join(DATA_DIR, n + '.json'); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, n + '.json')); });
    fs.readdirSync(BACKUP_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, -30).forEach(d => fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true }));
  } catch (e) { console.error('备份失败', e); }
}
setTimeout(dailyBackup, 3000);
setInterval(dailyBackup, 6 * 3600e3).unref();

// ---------- SGD→MYR rate for the current month, fetched once a day unless someone typed one by hand ----------
function fetchRate() {
  const m = Logic.nowMonth();
  const rates = load('rates');
  if (rates[m] && !rates[m].auto) return;
  const req = https.get('https://open.er-api.com/v6/latest/SGD', { timeout: 10000 }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        const r = j && j.rates && Number(j.rates.MYR);
        if (!(r > 0)) return;
        serial(() => { rates[m] = { sgdMyr: Math.round(r * 10000) / 10000, auto: true, updatedAt: new Date().toISOString(), source: 'open.er-api.com' }; save('rates'); });
      } catch (e) { /* ignore bad payload */ }
    });
  });
  req.on('error', () => {}); req.on('timeout', () => req.destroy());
}
if (process.env.FAMILY_NO_FETCH !== '1') { setTimeout(fetchRate, 12000); setInterval(fetchRate, 24 * 3600e3).unref(); }

server.listen(PORT, HOST, () => {
  const scheme = (process.env.TLS_CERT && process.env.TLS_KEY) ? 'https' : 'http';
  console.log('家庭资产服务已启动：' + scheme + '://' + HOST + ':' + PORT + '  数据目录：' + DATA_DIR);
});

module.exports = { API, KEYS, DATA_DIR, OWNER, autoSnapshot, autoPostRecurring, dailyBackup, server };
