'use strict';
/* Server tests: keys, throttling, validation, receipts, owner-only restore. Runs server.js on a random port
 * with a temporary data dir (HTTP, no TLS). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-test-'));
process.env.PORT = '0'; process.env.HOST = '127.0.0.1'; process.env.DATA_DIR = dir;
process.env.FAMILY_KEYS = 'ownerkey123:Chen,lizakey456:Liza,tankey7890:Ah Tan:tan,tanwife001:Mei:tan'; process.env.FAMILY_NO_FETCH = '1';
delete process.env.TLS_CERT; delete process.env.TLS_KEY;
const srv = require('../server.js');

let passed = 0;
async function t(name, fn) { await fn(); passed++; console.log('ok  ' + name); }
function req(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.server.address().port, method, path: p, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body != null) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const api = (fn, args, key) => req('POST', '/api/' + fn + (key ? '?k=' + key : ''), { args: args || [] }).then(r => ({ status: r.status, j: r.body ? JSON.parse(r.body) : null }));

(async () => {
  await new Promise(r => (srv.server.listening ? r() : srv.server.once('listening', r)));

  await t('page served without a key; API refuses without one', async () => {
    const page = await req('GET', '/');
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('<title>家庭资产记录</title>'));
    assert.ok(!/SEED_ACCOUNTS\s*=\s*\[/.test(page.body), 'no seed figures inside the page');
    const r = await api('getMe');
    assert.strictEqual(r.status, 403);
  });

  await t('valid ?k= sets a cookie and identifies the person; owner flag only for the first key', async () => {
    const page = await req('GET', '/?k=ownerkey123');
    assert.ok(/^k=ownerkey123;/.test(page.headers['set-cookie'][0]));
    const me = (await api('getMe', [], 'ownerkey123')).j.result;
    assert.deepStrictEqual({ name: me.name, owner: me.owner, family: me.family, operator: me.operator }, { name: 'Chen', owner: true, family: 'default', operator: true });
    const liza = (await api('getMe', [], 'lizakey456')).j.result;
    assert.deepStrictEqual({ name: liza.name, owner: liza.owner }, { name: 'Liza', owner: false });
    const viaCookie = await req('POST', '/api/getMe', { args: [] }, { cookie: 'k=lizakey456' });
    assert.strictEqual(JSON.parse(viaCookie.body).result.name, 'Liza');
  });

  await t('a stale cookie (old key) is cleared by the server so it does not keep counting as a wrong key', async () => {
    const r = await req('POST', '/api/getMe', { args: [] }, { cookie: 'k=oldkey000' });
    assert.strictEqual(r.status, 403);
    assert.ok(/Max-Age=0/.test((r.headers['set-cookie'] || [''])[0]));
    const page = await req('GET', '/', null, { cookie: 'k=oldkey000' });
    assert.strictEqual(page.status, 200);
    assert.ok(/Max-Age=0/.test((page.headers['set-cookie'] || [''])[0]));
  });

  await t('logout clears the HttpOnly cookie', async () => {
    const r = await req('GET', '/logout', null, { cookie: 'k=ownerkey123' });
    assert.strictEqual(r.status, 302);
    assert.ok(/Max-Age=0/.test(r.headers['set-cookie'][0]));
  });

  await t('setDoc validates transactions, balances and accounts', async () => {
    let r = await api('setDoc', ['tx', 't1', { type: 'expense', date: '2026-10-05', month: '2026-10', amount: 0, category: '饮食' }], 'ownerkey123');
    assert.strictEqual(r.j.ok, false); assert.ok(/金额/.test(r.j.error));
    r = await api('setDoc', ['tx', 't1', { type: 'expense', date: '2026-10-05', month: '2026-09', amount: 5, category: '饮食' }], 'ownerkey123');
    assert.ok(/月份/.test(r.j.error));
    r = await api('setDoc', ['tx', 't1', { type: 'expense', date: '2026-10-05', month: '2026-10', amount: 5, category: '饮食', account: 'a' }], 'ownerkey123');
    assert.strictEqual(r.j.ok, true);
    r = await api('setDoc', ['balances', 'b1', { month: '2026-10', accountId: 'a', amount: -1 }], 'ownerkey123');
    assert.ok(/余额/.test(r.j.error));
    r = await api('setDoc', ['accounts', 'a', { name: 'X', kind: 'asset', currency: 'USD' }], 'ownerkey123');
    assert.ok(/币种/.test(r.j.error));
    r = await api('setDoc', ['nope', 'a', {}], 'ownerkey123');
    assert.ok(/未知的集合/.test(r.j.error));
    const snap = await api('getSnapshot', [['tx']], 'lizakey456');
    assert.strictEqual(snap.j.result.tx.length, 1);
  });

  await t('receipt upload, fetch, and cleanup when the transaction is deleted', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
    const up = await api('uploadReceipt', [png], 'lizakey456');
    const id = up.j.result.fileId;
    assert.ok(/^[a-f0-9]{24}$/.test(id));
    const got = await api('getReceipt', [id], 'ownerkey123');
    assert.strictEqual(got.j.result, png);
    await api('setDoc', ['tx', 't2', { type: 'expense', date: '2026-10-06', month: '2026-10', amount: 9, category: '饮食', account: 'a', receiptId: id }], 'lizakey456');
    assert.ok(fs.existsSync(path.join(dir, 'receipts', id + '.bin')));
    await api('delDoc', ['tx', 't2'], 'lizakey456');
    assert.ok(!fs.existsSync(path.join(dir, 'receipts', id + '.bin')), 'receipt file removed with its transaction');
    const bad = await api('uploadReceipt', ['data:text/html;base64,PGI+'], 'ownerkey123');
    assert.ok(/格式/.test(bad.j.error));
  });

  await t('restore is owner-only; export round-trips', async () => {
    const exp = await api('exportAll', [], 'lizakey456');
    assert.strictEqual(exp.j.result.tx.length, 1);
    const denied = await api('importAll', [{ tx: [{ id: 'z', data: { type: 'income', date: '2026-10-01', month: '2026-10', amount: 1, category: '工资' } }] }], 'lizakey456');
    assert.ok(/只有 Chen/.test(denied.j.error));
    const ok = await api('importAll', [{ tx: [{ id: 'z', data: { type: 'income', date: '2026-10-01', month: '2026-10', amount: 1, category: '工资' } }] }], 'ownerkey123');
    assert.strictEqual(ok.j.result.imported, 1);
    assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'tx.json')))).length, 2);
  });

  await t('seed and static assets', async () => {
    const seed = await api('getSeed', [], 'lizakey456');
    assert.strictEqual(seed.j.result.accounts.length, 25);
    for (const p of ['/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/vendor/pdf.min.js']) {
      const r = await req('GET', p); assert.strictEqual(r.status, 200, p);
    }
    assert.strictEqual((await req('GET', '/vendor/../server.js')).status, 404);
    assert.strictEqual((await req('GET', '/vendor/ocr/eng.traineddata.gz')).status, 200);
    assert.strictEqual((await req('GET', '/vendor/ocr/tesseract-core-simd-lstm.wasm.js')).status, 200);
    assert.strictEqual((await req('GET', '/vendor/ocr/../../server.js')).status, 404);
    assert.strictEqual((await req('GET', '/icons/x.txt')).status, 404);
  });

  await t('daily backup folder and auto snapshot do not throw', async () => {
    srv.dailyBackup();
    const days = fs.readdirSync(path.join(dir, 'backups'));
    assert.strictEqual(days.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'backups', days[0], 'tx.json')));
    srv.autoSnapshot();
  });

  await t('families are isolated: data, owners, receipts, backups', async () => {
    const tan = await api('getMe', [], 'tankey7890');
    assert.deepStrictEqual({ name: tan.j.result.name, owner: tan.j.result.owner, family: tan.j.result.family, operator: tan.j.result.operator }, { name: 'Ah Tan', owner: true, family: 'tan', operator: false });
    assert.strictEqual((await api('getMe', [], 'tanwife001')).j.result.owner, false);
    assert.strictEqual((await api('getSnapshot', [['tx']], 'tankey7890')).j.result.tx.length, 0, 'tan family sees none of the default family data');
    await api('setDoc', ['accounts', 'tan-1', { name: 'Tan Maybank', kind: 'asset', group: 'family', currency: 'MYR', category: '现金与定存' }], 'tanwife001');
    assert.strictEqual((await api('getSnapshot', [['accounts']], 'ownerkey123')).j.result.accounts.length, 0, 'default family does not see tan accounts');
    assert.ok(fs.existsSync(path.join(dir, 'families', 'tan', 'accounts.json')));
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
    const up = await api('uploadReceipt', [png], 'tankey7890');
    assert.ok(fs.existsSync(path.join(dir, 'families', 'tan', 'receipts', up.j.result.fileId + '.bin')));
    assert.ok(/找不到收据/.test((await api('getReceipt', [up.j.result.fileId], 'ownerkey123')).j.error), 'other family cannot read it');
    assert.strictEqual((await api('getSeed', [], 'tankey7890')).j.result.accounts.length, 0, 'seed workbook is only for the default family');
    assert.ok(/只有 Ah Tan/.test((await api('importAll', [{}], 'tanwife001')).j.error));
    srv.dailyBackup();
    assert.ok(fs.existsSync(path.join(dir, 'families', 'tan', 'backups')));
  });

  await t('private accounts: hidden from other members (data, balances, tx), visible to owner; usage events; family wipe', async () => {
    await api('setDoc', ['accounts', 'tan-secret', { name: 'Mei Secret', kind: 'asset', group: 'family', currency: 'MYR', category: '现金与定存', private: 'Mei' }], 'tanwife001');
    await api('setDoc', ['balances', '2026-10__tan-secret', { month: '2026-10', accountId: 'tan-secret', amount: 500 }], 'tanwife001');
    await api('setDoc', ['tx', 'tan-secret-tx', { type: 'expense', date: '2026-10-02', month: '2026-10', amount: 9, category: '饮食', account: 'tan-secret' }], 'tanwife001');
    const ownerView = (await api('getSnapshot', [['accounts', 'tx']], 'tankey7890')).j.result;
    assert.ok(!ownerView.accounts.some(a => a.id === 'tan-secret'), 'owner does NOT see a plain private account');
    assert.ok(!ownerView.tx.some(t => t.id === 'tan-secret-tx'), 'nor its transactions');
    assert.strictEqual((await api('getMe', [], 'tankey7890')).j.result.hiddenPrivate, 1, 'owner only sees the count');
    await api('setDoc', ['accounts', 'tan-secret', { name: 'Mei Secret', kind: 'asset', group: 'family', currency: 'MYR', category: '现金与定存', private: 'Mei', auditable: true }], 'tanwife001');
    assert.ok((await api('getSnapshot', [['accounts']], 'tankey7890')).j.result.accounts.some(a => a.id === 'tan-secret'), 'auditable private account is visible to the owner');
    await api('setDoc', ['members', 'Third', { name: 'Third' }], 'tankey7890');
    process.env.FAMILY_KEYS += ''; // (members list is not auth; a third key would be needed for a full check)
    // Simulate a non-owner, non-private-owner view: Ah Tan is owner, so use a fresh key family? Use default-family Liza vs Chen for the same rule:
    await api('setDoc', ['accounts', 'chen-only', { name: 'Chen Private', kind: 'asset', group: 'family', currency: 'MYR', category: '投资', private: 'Chen' }], 'ownerkey123');
    await api('setDoc', ['accounts', 'liza-only', { name: 'Liza Private', kind: 'asset', group: 'family', currency: 'MYR', category: '投资', private: 'Liza' }], 'lizakey456');
    const liza = (await api('getSnapshot', [['accounts']], 'lizakey456')).j.result.accounts.map(a => a.id);
    assert.ok(liza.includes('liza-only') && !liza.includes('chen-only'), 'Liza sees her own private account, not Chen\'s');
    const chen = (await api('getSnapshot', [['accounts']], 'ownerkey123')).j.result.accounts.map(a => a.id);
    assert.ok(!chen.includes('liza-only') && chen.includes('chen-only'), 'owner does not see Liza\'s private account');
    assert.ok(/私人账户/.test((await api('setDoc', ['balances', '2026-10__chen-only', { month: '2026-10', accountId: 'chen-only', amount: 1 }], 'lizakey456')).j.error));
    assert.strictEqual((await api('track', ['first_tx'], 'lizakey456')).j.result, true);
    const stats = (await api('usageStats', [], 'ownerkey123')).j.result.find(f => f.family === 'default');
    assert.strictEqual(stats.events30.first_tx, 1);
    assert.ok(/运营者/.test((await api('usageStats', [], 'lizakey456')).j.error));
    assert.ok(/DELETE/.test((await api('deleteFamilyData', ['no', 'tankey7890'], 'tankey7890')).j.error));
    assert.ok(/只有 Ah Tan/.test((await api('deleteFamilyData', ['DELETE', 'tanwife001'], 'tanwife001')).j.error));
    assert.ok(/密钥/.test((await api('deleteFamilyData', ['DELETE', 'wrongkey'], 'tankey7890')).j.error), 'key must be re-entered');
    const del = (await api('deleteFamilyData', ['DELETE', 'tankey7890'], 'tankey7890')).j.result;
    assert.strictEqual(del.deleted, true); assert.strictEqual(del.recoverDays, 30);
    assert.strictEqual((await api('getSnapshot', [['accounts']], 'tankey7890')).j.result.accounts.length, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'families', 'tan', 'receipts')));
    assert.ok(fs.existsSync(path.join(dir, 'deleted', del.archived, 'accounts.json')), 'archived for recovery');
    const listed = (await api('listDeleted', [], 'ownerkey123')).j.result;
    assert.strictEqual(listed[0].family, 'tan');
    const rs = (await api('restoreDeleted', [del.archived], 'ownerkey123')).j.result;
    assert.ok(rs.restored > 0);
    assert.ok((await api('getSnapshot', [['accounts']], 'tankey7890')).j.result.accounts.length > 0, 'restored');
    await api('deleteFamilyData', ['DELETE', 'tankey7890'], 'tankey7890');
  });

  await t('plans: operator sets a family to free, limits apply, pro lifts them', async () => {
    assert.ok(/运营者/.test((await api('setPlan', ['tan', 'free'], 'tankey7890')).j.error));
    assert.strictEqual((await api('setPlan', ['tan', 'free'], 'ownerkey123')).j.result.tier, 'free');
    assert.strictEqual((await api('getMe', [], 'tankey7890')).j.result.plan.tier, 'free');
    for (let i = 1; i <= 8; i++) await api('setDoc', ['accounts', 'tan-' + i, { name: 'A' + i, kind: 'asset', group: 'family', currency: 'MYR' }], 'tankey7890');
    const ninth = await api('setDoc', ['accounts', 'tan-9', { name: 'A9', kind: 'asset', group: 'family', currency: 'MYR' }], 'tankey7890');
    assert.ok(/免费版最多 8 个账户/.test(ninth.j.error));
    assert.ok(/付费版/.test((await api('uploadReceipt', ['data:image/png;base64,iVBORw0KGgo='], 'tankey7890')).j.error));
    assert.ok(/系统设置/.test((await api('setDoc', ['settings', 'plan', { tier: 'pro' }], 'tankey7890')).j.error), 'families cannot upgrade themselves');
    assert.strictEqual((await api('setPlan', ['tan', 'pro', '2027-12-31'], 'ownerkey123')).j.result.tier, 'pro');
    assert.strictEqual((await api('setDoc', ['accounts', 'tan-9', { name: 'A9', kind: 'asset', group: 'family', currency: 'MYR' }], 'tankey7890')).j.ok, true);
    const fams = (await api('listFamilies', [], 'ownerkey123')).j.result;
    assert.deepStrictEqual(fams.map(f => f.family).sort(), ['default', 'tan']);
    assert.strictEqual(fams.find(f => f.family === 'tan').accounts, 9);
    assert.strictEqual((await api('getMe', [], 'lizakey456')).j.result.plan.tier, 'pro', 'default family is never limited');
  });

  await t('addKey: operator creates an empty isolated family or adds a member; key persists in keys.txt', async () => {
    assert.ok(/运营者/.test((await api('addKey', ['测试', 'demo'], 'tankey7890')).j.error), 'other families cannot create keys');
    assert.ok(/运营者/.test((await api('addKey', ['测试', 'demo'], 'lizakey456')).j.error), 'non-owner of the default family cannot either');
    assert.ok(/家庭编号/.test((await api('addKey', ['测试', 'bad id!'], 'ownerkey123')).j.error));
    assert.ok(/名字/.test((await api('addKey', ['a:b', 'demo'], 'ownerkey123')).j.error));
    const r = (await api('addKey', ['测试', 'demo'], 'ownerkey123')).j.result;
    assert.ok(r.key.length >= 20 && r.created && r.owner === '测试');
    const me = (await api('getMe', [], r.key)).j.result;
    assert.deepStrictEqual([me.name, me.family, me.owner, me.operator], ['测试', 'demo', true, false]);
    const snap = (await api('getSnapshot', [['accounts', 'tx']], r.key)).j.result;
    assert.deepStrictEqual(snap, { accounts: [], tx: [] }, 'new family starts empty');
    const line = fs.readFileSync(path.join(dir, 'keys.txt'), 'utf8').trim().split('\n').pop();
    assert.strictEqual(line, r.key + ':测试:demo');
    const m = (await api('addKey', ['成员', 'demo'], 'ownerkey123')).j.result;
    assert.ok(!m.created && m.owner === '测试');
    assert.ok(/已有/.test((await api('addKey', ['成员', 'demo'], 'ownerkey123')).j.error));
    const fams = (await api('listFamilies', [], 'ownerkey123')).j.result.find(f => f.family === 'demo');
    assert.deepStrictEqual(fams.members, ['测试', '成员']);
  });

  await t('wrong keys are throttled after 8 attempts, then even the right key waits', async () => {
    let last;
    for (let i = 0; i < 8; i++) last = await api('getMe', [], 'wrong' + i);
    assert.strictEqual(last.status, 403);
    const blockedWrong = await api('getMe', [], 'wrong9');
    assert.strictEqual(blockedWrong.status, 429);
    const blockedRight = await api('getMe', [], 'ownerkey123');
    assert.strictEqual(blockedRight.status, 429);
    assert.strictEqual((await req('GET', '/')).status, 200, 'the shell page itself still loads');
  });

  console.log('\n' + passed + ' server tests passed');
  srv.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
