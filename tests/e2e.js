'use strict';
/* Phone-viewport regression (not part of `npm test`: needs Playwright, which is not a project dependency).
 * One-off setup in a scratch folder, then run against a throwaway server:
 *   mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright@1.47.2 && PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/browsers npx playwright install chromium
 *   mkdir -p /tmp/fam-data && (cd ~/family && PORT=8445 HOST=127.0.0.1 DATA_DIR=/tmp/fam-data FAMILY_KEYS=testkey123:Chen FAMILY_NO_FETCH=1 node server.js &)
 *   PW=/tmp/pw/node_modules/playwright PLAYWRIGHT_BROWSERS_PATH=/tmp/pw/browsers DATA=/tmp/fam-data node tests/e2e.js
 * Never point DATA_DIR at the real data folder. */
const { chromium } = require(process.env.PW || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DATA = process.env.DATA;
const BASE = process.env.BASE || 'http://127.0.0.1:8445';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'family-e2e-'));
if (!DATA) { console.error('DATA=<the test server data dir> is required'); process.exit(1); }

function samplePdf() {
  const lines = [['Statement 01/10/2026 - 31/10/2026', 40, 760], ['01/10/2026', 40, 700], ['BALANCE B/F', 110, 700], ['7,000.00', 470, 700],
    ['03/10/2026', 40, 680], ['TRANSFER FROM HLB', 110, 680], ['3,000.00', 400, 680], ['10,000.00', 470, 680],
    ['05/10/2026', 40, 660], ['GRAB', 110, 660], ['15.00', 330, 660], ['9,985.00', 470, 660]];
  const content = 'BT /F1 10 Tf\n' + lines.map(([t, x, y]) => `1 0 0 1 ${x} ${y} Tm (${t}) Tj\n`).join('') + 'ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const p = path.join(TMP, 'stmt.pdf'); fs.writeFileSync(p, out); return p;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage(); const errors = []; let failed = 0;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/403|404/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  const ok = (name, cond) => { if (!cond) failed++; console.log((cond ? 'ok   ' : 'FAIL ') + name); };
  const json = f => JSON.parse(fs.readFileSync(path.join(DATA, f)));

  await page.goto(BASE + '/'); await page.waitForTimeout(700);
  ok('login screen', !(await page.$eval('#login', n => n.hidden)));
  await page.fill('#loginKey', 'testkey123'); await page.click('#loginBtn'); await page.waitForTimeout(1200);
  ok('logged in, key stripped from url', page.url().endsWith('/') && await page.$eval('#notice', n => n.hidden));
  await page.click('#welcome [data-act="goto"]'); await page.waitForTimeout(300);
  await page.click('#seedBtn'); await page.waitForTimeout(200); await page.click('#seedBtn'); await page.waitForTimeout(3000);
  ok('seeded 25 accounts', Object.keys(json('accounts.json')).length === 25);

  await page.click('#nav [data-tab="entry"]'); await page.waitForTimeout(300);
  await page.fill('#fAmt', '23.5'); await page.click('#catChips button'); await page.selectOption('#fAcc', 'pb-joint'); await page.fill('#fNote', 'Giant');
  const png = path.join(TMP, 'r.png');
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVQImWP8z8DwHwyZGBgYGBgYGBgAHQcD/TPhB+MAAAAASUVORK5CYII=', 'base64'));
  await page.setInputFiles('#fReceiptPick', png); await page.waitForTimeout(500);
  await page.click('#fSave'); await page.waitForTimeout(1200);
  const tx = Object.values(json('tx.json'))[0];
  ok('entry saved with receipt + member', tx.amount === 23.5 && !!tx.receiptId && tx.member === 'Chen' && tx.category === '饮食');
  await page.click('[data-act="view-receipt"]'); await page.waitForTimeout(600);
  ok('receipt viewer', !(await page.$eval('#rcImg', n => n.hidden)));
  await page.click('#receiptSheet [data-close]');

  await page.click('#nav [data-tab="balances"]'); await page.waitForTimeout(300);
  await page.click('[data-act="open-acc"][data-id="loan-house"]'); await page.fill('#aRate', '4.5'); await page.fill('#aPay', '1000'); await page.click('#aSave'); await page.waitForTimeout(700);
  await page.click('#nav [data-tab="entry"]'); await page.waitForTimeout(200); await page.click('#typeSeg [data-type="repayment"]'); await page.selectOption('#fLoan', 'loan-house'); await page.waitForTimeout(200);
  ok('repayment autofill', (await page.$eval('#fAmt', n => n.value)) === '1000' && (await page.$eval('#fInt', n => n.value)) === '221.14');
  await page.selectOption('#fAcc', 'pb-joint'); await page.click('#fSave'); await page.waitForTimeout(800);

  await page.click('#nav [data-more]'); await page.click('#moreSheet [data-tab="settings"]'); await page.waitForTimeout(300);
  await page.setInputFiles('#csvFile', samplePdf()); await page.waitForTimeout(2500);
  await page.selectOption('#iAcc', 'pb-joint'); await page.click('#previewBtn'); await page.waitForTimeout(400);
  ok('pdf preview', /识别 2 笔/.test(await page.$eval('#importSum', n => n.textContent)));
  await page.click('#importBtn'); await page.waitForTimeout(1200);
  ok('pdf imported', /已导入 2 笔/.test(await page.$eval('#importSum', n => n.textContent)));
  const csv = path.join(TMP, 's.csv'); fs.writeFileSync(csv, 'Date,Description,Amount\n05/10/2026,GRAB,-15.00\n07/10/2026,TOPUP,-20.00\n');
  await page.setInputFiles('#csvFile', csv); await page.waitForTimeout(500); await page.click('#previewBtn'); await page.waitForTimeout(400);
  ok('csv dedupe vs pdf', /可导入 1 笔 · 已导入过（跳过）1 笔/.test(await page.$eval('#importSum', n => n.textContent)));

  await page.click('#nav [data-more]'); await page.click('#moreSheet [data-tab="report"]'); await page.waitForTimeout(400);
  ok('report donut', (await page.$eval('#rpCats', n => n.innerHTML)).includes('<svg'));
  await page.click('#nav [data-tab="ledger"]'); await page.waitForTimeout(300); await page.check('#lCalendar'); await page.waitForTimeout(300);
  ok('calendar', (await page.$$eval('#calBox button[data-day]', b => b.length)) >= 28);
  await page.click('#nav [data-tab="overview"]'); await page.waitForTimeout(400);
  ok('overview insights + cats', !(await page.$eval('#insightBox', n => n.hidden)) && (await page.$eval('#ovCats', n => n.innerHTML)).includes('<svg'));
  await page.click('#nav [data-more]'); await page.click('#moreSheet [data-tab="settings"]'); await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#backupBtn')]);
  ok('backup download', /family-backup-/.test(dl.suggestedFilename()));
  ok('health ok', /没有发现问题|没有归属成员/.test(await page.$eval('#healthList', n => n.textContent)));
  await page.click('#logoutBtn'); await page.waitForTimeout(700);
  ok('logout', !(await page.$eval('#login', n => n.hidden)));
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed || errors.length ? 1 : 0);
})().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
