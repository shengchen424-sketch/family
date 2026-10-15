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
process.env.FAMILY_KEYS = 'ownerkey123:Chen,lizakey456:Liza'; process.env.FAMILY_NO_FETCH = '1';
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
    const me = await api('getMe', [], 'ownerkey123');
    assert.deepStrictEqual(me.j.result, { name: 'Chen', owner: true });
    const liza = await api('getMe', [], 'lizakey456');
    assert.deepStrictEqual(liza.j.result, { name: 'Liza', owner: false });
    const viaCookie = await req('POST', '/api/getMe', { args: [] }, { cookie: 'k=lizakey456' });
    assert.strictEqual(JSON.parse(viaCookie.body).result.name, 'Liza');
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
    assert.strictEqual((await req('GET', '/icons/x.txt')).status, 404);
  });

  await t('daily backup folder and auto snapshot do not throw', async () => {
    srv.dailyBackup();
    const days = fs.readdirSync(path.join(dir, 'backups'));
    assert.strictEqual(days.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'backups', days[0], 'tx.json')));
    srv.autoSnapshot();
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
