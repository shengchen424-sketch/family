#!/usr/bin/env node
/**
 * 家庭资产与开销 — VPS 服务端（Node.js，无第三方依赖）
 *
 * 启动：
 *   FAMILY_KEYS="密钥1:Chen,密钥2:Liza" PORT=8443 TLS_CERT=/path/cert.pem TLS_KEY=/path/key.pem node server.js
 *   密钥也可以放在 data/keys.txt（每行 "密钥:名字" 或 "密钥:名字:家庭编号"），这样不用写进 systemd 单元。两处都没有时自动生成 owner 密钥。
 *   多家庭：家庭编号不同的密钥看到完全独立的数据（data/families/<编号>/），默认家庭用 data/ 本身。每个家庭第一把密钥的人是该家庭的 owner。
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
const DEFAULT_FAMILY = 'default';
function famDir(fam) { return fam === DEFAULT_FAMILY ? DATA_DIR : path.join(DATA_DIR, 'families', fam); }
function receiptDir(fam) { const d = path.join(famDir(fam), 'receipts'); fs.mkdirSync(d, { recursive: true }); return d; }
function backupDir(fam) { return path.join(famDir(fam), 'backups'); }
const DELETED_DIR = path.join(DATA_DIR, 'deleted');
// Plans: a family's settings doc "plan" {tier:'free'|'pro', until}. No doc = pro (self-hosted families are never limited).
// Billing (Google Play) will call setPlan when it goes live; FREE_LIMITS is what the free tier gets.
const FREE_LIMITS = { accounts: 8, receipts: false };
const COLLECTIONS = ['accounts', 'balances', 'rates', 'tx', 'recurring', 'categories', 'members', 'reminders', 'snapshots', 'audit', 'goals', 'settings', 'tasks', 'events'];
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

fs.mkdirSync(path.join(DATA_DIR, 'receipts'), { recursive: true });

// ---------- access keys: one key per person, so the audit log shows who changed what ----------
// Keys come from FAMILY_KEYS ("key:Name,key2:Name2") and/or DATA_DIR/keys.txt (one "key:Name" per line,
// '#' starts a comment). keys.txt keeps secrets out of the systemd unit and out of git.
const KEYS_FILE = path.join(DATA_DIR, 'keys.txt');
function addPairs(map, text, sep) {
  String(text || '').split(sep).map(s => s.trim()).filter(s => s && s[0] !== '#').forEach(pair => {
    const parts = pair.split(':').map(x => x.trim());
    if (parts.length >= 2 && parts[0].length >= 6 && parts[1]) {
      const fam = (parts[2] || DEFAULT_FAMILY).replace(/[^\w-]/g, '') || DEFAULT_FAMILY;
      map[parts[0]] = { name: parts[1], family: fam };
    }
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
    map[key] = { name: 'Chen', family: DEFAULT_FAMILY };
  }
  return map;
}
const KEYS = loadKeys();
// Each family's owner = the person on its first key (FAMILY_OWNER overrides for the default family).
// Owners may restore backups; everyone may record.
const OWNERS = {};
Object.keys(KEYS).forEach(k => { const e = KEYS[k]; if (!OWNERS[e.family]) OWNERS[e.family] = e.name; });
if (process.env.FAMILY_OWNER) OWNERS[DEFAULT_FAMILY] = process.env.FAMILY_OWNER;
const OWNER = OWNERS[DEFAULT_FAMILY];
function families() { return Object.keys(OWNERS); }
function ctxFor(key) { const e = KEYS[key]; return { me: e.name, family: e.family, owner: e.name === OWNERS[e.family], operator: e.family === DEFAULT_FAMILY && e.name === OWNER, key: key }; }
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
  if (v && !q) req.staleCookie = true; // old cookie after a key change: tell the browser to drop it
  return null;
}
const CLEAR_COOKIE = 'k=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';

// ---------- document store (one JSON file per collection, written atomically) ----------
const cache = {};
function load(fam, name) {
  const k = fam + '/' + name;
  if (cache[k]) return cache[k];
  const file = path.join(famDir(fam), name + '.json');
  let obj = {};
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { obj = {}; }
  cache[k] = obj;
  return obj;
}
function save(fam, name) {
  const dir = famDir(fam);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache[fam + '/' + name]));
  fs.renameSync(tmp, file);
}
function planOf(fam) {
  const p = load(fam, 'settings').plan;
  if (!p || !p.tier) return { tier: 'pro' };
  if (p.tier === 'pro' && p.until && p.until < Logic.todayKuching()) return { tier: 'free', until: p.until, expired: true };
  return p;
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
  if (name === 'tasks' && (!d.title || !d.month)) throw new Error('任务数据不正确');
  if (JSON.stringify(d).length > 20000) throw new Error('记录太大');
}
const AUDIT_MAX = 2000;
function pruneAudit(m) {
  const ids = Object.keys(m);
  if (ids.length <= AUDIT_MAX) return;
  ids.sort((a, b) => String(m[a].at || '').localeCompare(String(m[b].at || '')));
  ids.slice(0, ids.length - AUDIT_MAX).forEach(id => { delete m[id]; });
}
// Accounts marked private (account.private = member id) are visible only to that member and the family owner.
// Visibility: account.private = member id → only that member sees it (and its balances, transactions, goals);
// account.auditable = true additionally lets the family owner see it. Nobody else, including the owner otherwise.
function hiddenAccounts(ctx) {
  const accs = load(ctx.family, 'accounts');
  return new Set(Object.keys(accs).filter(id => accs[id].private && accs[id].private !== ctx.me && !(ctx.owner && accs[id].auditable)));
}
function privateCount(ctx) {
  const accs = load(ctx.family, 'accounts');
  return Object.keys(accs).filter(id => accs[id].private && accs[id].private !== ctx.me).length;
}
function isHiddenDoc(name, id, d, hidden) {
  if (!hidden.size || !d) return false;
  if (name === 'accounts') return hidden.has(id);
  if (name === 'balances') return hidden.has(d.accountId);
  if (name === 'tx') return hidden.has(d.account) || hidden.has(d.toAccount) || hidden.has(d.loanId);
  if (name === 'goals') return hidden.has(d.accountId);
  if (name === 'recurring') return hidden.has(d.account) || hidden.has(d.loanId);
  return false;
}
function removeReceipt(fam, fileId) {
  if (!/^[a-f0-9]{24}$/.test(String(fileId || ''))) return;
  ['.bin', '.type'].forEach(ext => { try { fs.unlinkSync(path.join(receiptDir(fam), fileId + ext)); } catch (e) { /* already gone */ } });
}

// Every API function receives ctx = { me, family, owner, operator } first; the HTTP layer builds it from the key.
const API = {
  getMe(ctx) { return { name: ctx.me, owner: ctx.owner, family: ctx.family, plan: planOf(ctx.family), operator: ctx.operator, hiddenPrivate: privateCount(ctx) }; },

  getSnapshot(ctx, names) {
    const out = {};
    const hidden = hiddenAccounts(ctx);
    (names || COLLECTIONS).forEach(n => {
      assertName(n);
      if (n === 'events') return; // usage counters are operator-only
      const m = load(ctx.family, n);
      out[n] = Object.keys(m).filter(id => !isHiddenDoc(n, id, m[id], hidden)).map(id => ({ id, data: m[id] }));
    });
    return out;
  },

  // Usage events: counts per day per event name, no amounts, no text. Used to measure activation and retention.
  track(ctx, event) {
    const name = String(event || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!name) return false;
    return serial(() => {
      const ev = load(ctx.family, 'events');
      const day = Logic.todayKuching();
      const rec = ev[day] = ev[day] || {};
      rec[name] = (rec[name] || 0) + 1;
      rec['_members_' + ctx.me] = 1;
      save(ctx.family, 'events');
      return true;
    });
  },
  usageStats(ctx) {
    if (!ctx.operator) throw new Error('只有运营者可以查看');
    return families().map(f => {
      const ev = load(f, 'events'), days = Object.keys(ev).sort();
      const last30 = days.filter(d => d >= Logic.todayKuching().slice(0, 8) || days.length <= 30 || d >= days[Math.max(0, days.length - 30)]);
      const totals = {}; last30.forEach(d => Object.keys(ev[d]).forEach(k => { if (k[0] !== '_') totals[k] = (totals[k] || 0) + ev[d][k]; }));
      return { family: f, activeDays30: last30.length, firstDay: days[0] || null, lastDay: days[days.length - 1] || null, events30: totals };
    });
  },

  // Owner wipes everything in the family (collections, receipts, backups). The keys stay; the family starts empty.
  // Wipe = owner + DELETE + the owner's own key typed again. Everything is first archived under data/deleted/<family>-<time>/
  // and kept for 30 days (operator can restore with restoreDeleted); then the family starts empty.
  deleteFamilyData(ctx, confirmText, keyAgain) {
    if (!ctx.owner) throw new Error('只有 ' + OWNERS[ctx.family] + ' 可以删除全部数据');
    if (confirmText !== 'DELETE') throw new Error('请输入 DELETE 确认');
    if (!keyAgain || keyAgain !== ctx.key) throw new Error('请重新输入你的访问密钥以确认身份');
    return serial(() => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const arch = path.join(DELETED_DIR, ctx.family + '-' + stamp);
      fs.mkdirSync(arch, { recursive: true });
      COLLECTIONS.forEach(n => { const f = path.join(famDir(ctx.family), n + '.json'); if (fs.existsSync(f)) fs.renameSync(f, path.join(arch, n + '.json')); cache[ctx.family + '/' + n] = {}; });
      const rd = receiptDir(ctx.family); if (fs.existsSync(rd)) fs.renameSync(rd, path.join(arch, 'receipts'));
      fs.rmSync(backupDir(ctx.family), { recursive: true, force: true });
      fs.writeFileSync(path.join(arch, 'meta.json'), JSON.stringify({ family: ctx.family, by: ctx.me, at: new Date().toISOString(), recoverUntil: Logic.addMonths(Logic.nowMonth(), 1) }));
      console.log('[' + ctx.family + '] 数据已由 ' + ctx.me + ' 删除，归档 30 天：' + arch);
      return { deleted: true, archived: path.basename(arch), recoverDays: 30 };
    });
  },
  listDeleted(ctx) {
    if (!ctx.operator) throw new Error('只有运营者可以查看');
    try { return fs.readdirSync(DELETED_DIR).filter(d => fs.existsSync(path.join(DELETED_DIR, d, 'meta.json'))).map(d => Object.assign({ folder: d }, JSON.parse(fs.readFileSync(path.join(DELETED_DIR, d, 'meta.json'), 'utf8')))); } catch (e) { return []; }
  },
  restoreDeleted(ctx, folder) {
    if (!ctx.operator) throw new Error('只有运营者可以恢复');
    const arch = path.join(DELETED_DIR, String(folder || '').replace(/[^\w.-]/g, ''));
    if (!fs.existsSync(path.join(arch, 'meta.json'))) throw new Error('没有这个归档');
    const meta = JSON.parse(fs.readFileSync(path.join(arch, 'meta.json'), 'utf8'));
    return serial(() => {
      let n = 0;
      COLLECTIONS.forEach(c => {
        const f = path.join(arch, c + '.json'); if (!fs.existsSync(f)) return;
        const m = load(meta.family, c), src = JSON.parse(fs.readFileSync(f, 'utf8'));
        Object.keys(src).forEach(id => { m[id] = src[id]; n++; }); save(meta.family, c);
      });
      const rd = path.join(arch, 'receipts'); if (fs.existsSync(rd)) { const dst = receiptDir(meta.family); fs.readdirSync(rd).forEach(f => fs.copyFileSync(path.join(rd, f), path.join(dst, f))); }
      return { restored: n, family: meta.family };
    });
  },

  setDoc(ctx, name, id, data) {
    assertName(name);
    if (!id || typeof id !== 'string' || id.length > 120) throw new Error('缺少编号');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('数据格式不正确');
    validateDoc(name, data);
    if (name === 'settings' && id === 'plan') throw new Error('方案由系统设置');
    if (name === 'events') throw new Error('请用 track 记录事件');
    const hidden = hiddenAccounts(ctx);
    if (isHiddenDoc(name, id, data, hidden) || (name === 'accounts' && hidden.has(id))) throw new Error('这是别人的私人账户');
    return serial(() => {
      const m = load(ctx.family, name);
      if (name === 'accounts' && m[id] && m[id].private && m[id].private !== ctx.me) throw new Error('这是别人的私人账户');
      if (name === 'accounts' && !m[id] && planOf(ctx.family).tier === 'free' && Object.keys(m).length >= FREE_LIMITS.accounts) throw new Error('免费版最多 ' + FREE_LIMITS.accounts + ' 个账户，升级后不限');
      m[id] = data;
      if (name === 'audit') pruneAudit(m);
      save(ctx.family, name);
      return true;
    });
  },

  delDoc(ctx, name, id) {
    assertName(name);
    return serial(() => {
      const m = load(ctx.family, name);
      const old = m[id];
      delete m[id];
      save(ctx.family, name);
      if (name === 'tx' && old && old.receiptId) removeReceipt(ctx.family, old.receiptId);
      return true;
    });
  },

  uploadReceipt(ctx, dataUrl) {
    if (planOf(ctx.family).tier === 'free' && !FREE_LIMITS.receipts) throw new Error('收据照片是付费版功能');
    const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp|heic|heif));base64,(.*)$/);
    if (!m) throw new Error('图片格式不正确');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 4 * 1024 * 1024) throw new Error('图片太大');
    const id = crypto.randomBytes(12).toString('hex');
    const dir = receiptDir(ctx.family);
    fs.writeFileSync(path.join(dir, id + '.bin'), bytes);
    fs.writeFileSync(path.join(dir, id + '.type'), m[1]);
    return { fileId: id };
  },

  getSeed(ctx) { return ctx.family === DEFAULT_FAMILY ? SEED : { accounts: [], rate: null, month: null }; },

  // Full backup / restore. Restore merges document by document (existing ids are overwritten, nothing is deleted).
  exportAll(ctx) { return API.getSnapshot(ctx, COLLECTIONS); },
  importAll(ctx, data) {
    if (!ctx.owner) throw new Error('只有 ' + OWNERS[ctx.family] + ' 可以恢复备份');
    if (!data || typeof data !== 'object') throw new Error('备份格式不正确');
    return serial(() => {
      let n = 0;
      Object.keys(data).forEach(name => {
        if (!COLLECTIONS.includes(name) || !Array.isArray(data[name])) return;
        const m = load(ctx.family, name);
        data[name].forEach(r => { if (r && typeof r.id === 'string' && r.data && typeof r.data === 'object') { m[r.id] = r.data; n++; } });
        save(ctx.family, name);
      });
      return { imported: n };
    });
  },

  listBackups(ctx) {
    try { return fs.readdirSync(backupDir(ctx.family)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch (e) { return []; }
  },
  restoreBackup(ctx, day) {
    if (!ctx.owner) throw new Error('只有 ' + OWNERS[ctx.family] + ' 可以恢复备份');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new Error('日期不正确');
    const dir = path.join(backupDir(ctx.family), day);
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

  getReceipt(ctx, fileId) {
    if (!/^[a-f0-9]{24}$/.test(String(fileId || ''))) throw new Error('编号不正确');
    const dir = receiptDir(ctx.family);
    const bin = path.join(dir, fileId + '.bin');
    if (!fs.existsSync(bin)) throw new Error('找不到收据');
    const type = fs.readFileSync(path.join(dir, fileId + '.type'), 'utf8');
    return 'data:' + type + ';base64,' + fs.readFileSync(bin).toString('base64');
  },

  // Operator only (owner of the default family): set a family's plan. Billing webhooks will call this.
  setPlan(ctx, family, tier, until) {
    if (!ctx.operator) throw new Error('只有运营者可以设置方案');
    if (!OWNERS[family]) throw new Error('没有这个家庭');
    if (!['free', 'pro'].includes(tier)) throw new Error('方案只能是 free 或 pro');
    if (until && !Logic.isDate(until)) throw new Error('到期日不正确');
    return serial(() => {
      const st = load(family, 'settings');
      st.plan = { tier, until: until || null, setAt: new Date().toISOString(), by: ctx.me };
      save(family, 'settings');
      return st.plan;
    });
  },
  listFamilies(ctx) {
    if (!ctx.operator) throw new Error('只有运营者可以查看');
    return families().map(f => ({ family: f, owner: OWNERS[f], members: Object.keys(KEYS).filter(k => KEYS[k].family === f).map(k => KEYS[k].name), plan: planOf(f), accounts: Object.keys(load(f, 'accounts')).length }));
  },
  // Operator only: create an access key for a person. A new family id starts an empty, isolated family whose
  // first person is its owner; an existing family id adds a member. The key is appended to keys.txt (so it
  // survives restarts) and becomes valid at once. Same line format as scripts/keys.sh, no SSH needed.
  addKey(ctx, name, family) {
    if (!ctx.operator) throw new Error('只有运营者可以新建密钥');
    name = String(name || '').trim();
    family = String(family || '').trim();
    if (!name || name.length > 30 || /[:\n\r]/.test(name)) throw new Error('名字 1–30 字，不能有冒号');
    if (!/^[A-Za-z0-9][\w-]{0,29}$/.test(family)) throw new Error('家庭编号只能用英文字母、数字、- 和 _，以字母或数字开头');
    if (Object.keys(KEYS).some(k => KEYS[k].family === family && KEYS[k].name === name)) throw new Error('这个家庭已有 ' + name);
    const r = writeKey(name, family);
    console.log('[' + ctx.family + '] ' + ctx.me + ' 新建密钥：' + name + '（家庭 ' + family + (r.created ? '，新家庭' : '') + '）');
    return r;
  }
};
// Append "key:name:family" to keys.txt and make it valid at once. The first key of a family makes its owner.
function writeKey(name, family) {
  const key = crypto.randomBytes(18).toString('base64url');
  fs.appendFileSync(KEYS_FILE, key + ':' + name + ':' + family + '\n', { mode: 0o600 });
  try { fs.chmodSync(KEYS_FILE, 0o600); } catch (e) { /* best effort */ }
  const created = !OWNERS[family];
  KEYS[key] = { name, family };
  if (created) OWNERS[family] = name;
  return { key, name, family, created, owner: OWNERS[family] };
}
// Self-service sign-up (no key): a fresh empty family per call, limited per address per day and in total.
const OPEN_SIGNUP = process.env.FAMILY_OPEN_SIGNUP !== '0';
const SIGNUP_PER_DAY = Math.max(1, parseInt(process.env.FAMILY_SIGNUP_PER_DAY || '3', 10) || 3);
const SIGNUP_MAX_FAMILIES = Math.max(1, parseInt(process.env.FAMILY_MAX_FAMILIES || '300', 10) || 300);
const signups = new Map();
function startFamily(ip, name) {
  name = String(name || '').trim().replace(/[:\n\r]/g, '').slice(0, 30) || '我';
  const now = Date.now();
  const list = (signups.get(ip) || []).filter(t => now - t < 86400e3);
  if (list.length >= SIGNUP_PER_DAY) throw new Error('这个网络今天已建立 ' + SIGNUP_PER_DAY + ' 个账本，请明天再试或向管理员要链接');
  if (families().length >= SIGNUP_MAX_FAMILIES) throw new Error('账本数量已达上限，请向管理员要链接');
  let family;
  do { family = 'f' + crypto.randomBytes(4).toString('hex'); } while (OWNERS[family]);
  list.push(now); signups.set(ip, list);
  const r = writeKey(name, family);
  console.log('[' + family + '] 自助注册：' + name + '（' + ip + '）');
  return r;
}

// ---------- HTTP ----------
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'"
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
    if (req.staleCookie) headers['Set-Cookie'] = CLEAR_COOKIE;
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
    const rel = url.pathname.slice('/vendor/'.length);
    const file = path.join(VENDOR_DIR, rel);
    const VENDOR_TYPES = { '.js': 'application/javascript; charset=utf-8', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.json': 'application/json' };
    const type = VENDOR_TYPES[path.extname(rel)];
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(rel) || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800' });
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

  // Android package download (key required): the APK built with Bubblewrap, if present
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/download/apk') {
    if (!key) return send(res, 403, '需要访问密钥', { 'Content-Type': 'text/plain; charset=utf-8' });
    const apk = path.join(__dirname, 'android', 'app-release-signed.apk');
    if (!fs.existsSync(apk)) return send(res, 404, '还没有 Android 安装包', { 'Content-Type': 'text/plain; charset=utf-8' });
    const hdr = { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="family-assets.apk"', 'Cache-Control': 'no-store', 'Content-Length': String(fs.statSync(apk).size) };
    if (req.method === 'HEAD') return send(res, 200, '', hdr);
    return send(res, 200, fs.readFileSync(apk), hdr);
  }

  if (req.method === 'POST' && url.pathname === '/api/startFamily') {
    // Open sign-up: no key needed. The server creates an empty family with its own random key and hands the
    // key to this phone (cookie + response); the person never has to see or type it. Limited per address and
    // in total so nobody can fill the disk. FAMILY_OPEN_SIGNUP=0 turns it off.
    if (!OPEN_SIGNUP) return send(res, 403, JSON.stringify({ ok: false, error: '这台服务器不开放自助注册，请向管理员要链接' }), { 'Content-Type': 'application/json' });
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = startFamily(ip, body && body.name);
      return send(res, 200, JSON.stringify({ ok: true, result: r }), { 'Content-Type': 'application/json', 'Set-Cookie': 'k=' + encodeURIComponent(r.key) + '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000' });
    } catch (e) {
      return send(res, 200, JSON.stringify({ ok: false, error: String(e && e.message || e) }), { 'Content-Type': 'application/json' });
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!key) return send(res, 403, JSON.stringify({ ok: false, error: '未授权', code: 'unauthorized' }), Object.assign({ 'Content-Type': 'application/json' }, req.staleCookie ? { 'Set-Cookie': CLEAR_COOKIE } : {}));
    const fn = url.pathname.slice(5);
    if (!Object.prototype.hasOwnProperty.call(API, fn)) return send(res, 404, JSON.stringify({ ok: false, error: '未知函数' }), { 'Content-Type': 'application/json' });
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const args = Array.isArray(body.args) ? body.args : [];
      const result = await API[fn](ctxFor(key), ...args.slice(0, 4).map(a => a));
      return send(res, 200, JSON.stringify({ ok: true, result: result === undefined ? null : result }), { 'Content-Type': 'application/json' });
    } catch (e) {
      return send(res, 200, JSON.stringify({ ok: false, error: String(e && e.message || e) }), { 'Content-Type': 'application/json' });
    }
  }

  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

// ---------- automatic month-end snapshot ----------
// On the first run of a new month (checked every 6 h), lock last month's family totals if nobody did it by hand.
function withIds(m) { const o = {}; Object.keys(m).forEach(id => { o[id] = Object.assign({}, m[id], { id }); }); return o; }
function autoSnapshot() { families().forEach(autoSnapshotFor); }
function autoSnapshotFor(fam) {
  try {
    const prev = Logic.addMonths(Logic.nowMonth(), -1);
    const snaps = load(fam, 'snapshots');
    if (snaps[prev]) return;
    const balances = load(fam, 'balances');
    if (!Object.keys(balances).some(k => balances[k].month <= prev)) return;
    const accs = withIds(load(fam, 'accounts')), rates = load(fam, 'rates');
    const t = Logic.familyTotals(accs, balances, rates, prev);
    const biz = Logic.businessTotals(accs, balances, rates, prev);
    serial(() => {
      const r2 = n => Math.round(n * 100) / 100;
      snaps[prev] = { month: prev, assets: r2(t.assets), liabs: r2(t.liabs), net: r2(t.net), liquid: r2(t.liquid), bizNet: r2(biz.net), missing: t.missing, lockedAt: new Date().toISOString(), byId: 'auto', auto: true };
      save(fam, 'snapshots');
      const audit = load(fam, 'audit');
      audit['auto-' + prev] = { at: new Date().toISOString(), byId: 'auto', action: '自动月结', ref: prev, summary: prev + ' 净资产 RM ' + r2(t.net).toLocaleString('en-MY') };
      save(fam, 'audit');
      console.log('[' + fam + '] 已自动锁定 ' + prev + ' 快照');
    });
  } catch (e) { console.error('自动月结失败', e); }
}
setTimeout(autoSnapshot, 5000);
setInterval(autoSnapshot, 6 * 3600e3).unref();

// ---------- automatic posting of recurring items flagged autoPost (checked hourly) ----------
function autoPostRecurring() { families().forEach(autoPostFor); }
function autoPostFor(fam) {
  try {
    const today = Logic.todayKuching(), m = today.slice(0, 7);
    const recs = withIds(load(fam, 'recurring')), txm = load(fam, 'tx');
    const txs = Object.keys(txm).map(id => Object.assign({}, txm[id], { id }));
    const due = Logic.dueAutoPost(Object.keys(recs).map(k => recs[k]), txs, today);
    if (!due.length) return;
    serial(() => {
      const audit = load(fam, 'audit');
      due.forEach(it => {
        const tx = Logic.txFromRecurring(it, m);
        tx.member = tx.member || 'shared';
        if (Logic.validateTx(tx)) return;
        tx.byId = 'auto'; tx.createdAt = tx.updatedAt = new Date().toISOString(); tx.source = 'auto';
        txm[it.key] = tx;
        audit['auto-' + it.key] = { at: tx.createdAt, byId: 'auto', action: '自动入账', ref: it.key, summary: (it.rec.name || '') + ' RM ' + tx.amount };
      });
      save(fam, 'tx'); save(fam, 'audit');
      console.log('[' + fam + '] 自动入账 ' + due.length + ' 笔');
    });
  } catch (e) { console.error('自动入账失败', e); }
}
setTimeout(autoPostRecurring, 8000);
setInterval(autoPostRecurring, 3600e3).unref();

// ---------- daily on-disk backup of the JSON collections (last 30 days kept) ----------
function dailyBackup() {
  families().forEach(dailyBackupFor);
  try { // purge wiped-family archives after their 30-day recovery window
    fs.readdirSync(DELETED_DIR).forEach(d => { const mf = path.join(DELETED_DIR, d, 'meta.json'); if (!fs.existsSync(mf)) return; const meta = JSON.parse(fs.readFileSync(mf, 'utf8')); if (Date.parse(meta.at) < Date.now() - 30 * 864e5) fs.rmSync(path.join(DELETED_DIR, d), { recursive: true, force: true }); });
  } catch (e) { /* no archives */ }
}
function dailyBackupFor(fam) {
  try {
    const day = Logic.todayKuching(), bdir = backupDir(fam);
    const dir = path.join(bdir, day);
    if (fs.existsSync(dir)) return;
    if (!COLLECTIONS.some(n => fs.existsSync(path.join(famDir(fam), n + '.json')))) return;
    fs.mkdirSync(dir, { recursive: true });
    COLLECTIONS.forEach(n => { const f = path.join(famDir(fam), n + '.json'); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, n + '.json')); });
    fs.readdirSync(bdir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, -30).forEach(d => fs.rmSync(path.join(bdir, d), { recursive: true, force: true }));
  } catch (e) { console.error('备份失败', e); }
}
setTimeout(dailyBackup, 3000);
setInterval(dailyBackup, 6 * 3600e3).unref();

// ---------- SGD→MYR rate for the current month, fetched once a day unless someone typed one by hand ----------
function fetchRate() {
  const m = Logic.nowMonth();
  const req = https.get('https://open.er-api.com/v6/latest/SGD', { timeout: 10000 }, res => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      try {
        const j = JSON.parse(body);
        const r = j && j.rates && Number(j.rates.MYR);
        if (!(r > 0)) return;
        serial(() => {
          families().forEach(fam => {
            const rates = load(fam, 'rates');
            if (rates[m] && !rates[m].auto) return;
            rates[m] = { sgdMyr: Math.round(r * 10000) / 10000, auto: true, updatedAt: new Date().toISOString(), source: 'open.er-api.com' }; save(fam, 'rates');
          });
        });
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

module.exports = { API, KEYS, DATA_DIR, OWNER, OWNERS, families, autoSnapshot, autoPostRecurring, dailyBackup, server };
