'use strict';
const assert = require('assert');
const L = require('../src/logic.js');
const fs = require('fs');
const vm = require('vm');

// load seed (plain script, defines SEED_* globals)
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/seed.js', 'utf8'), ctx);
const SEED = ctx.SEED_ACCOUNTS;

const accounts = {};
const balances = {};
SEED.forEach(a => {
  accounts[a.id] = { id: a.id, name: a.name, kind: a.kind, group: a.group, category: a.category, currency: a.currency, sort: a.sort, active: true };
  if (a.amount !== null) balances[SEED_M(a.id)] = { month: '2026-10', accountId: a.id, amount: a.amount, currency: a.currency };
});
function SEED_M(id) { return '2026-10__' + id; }
const rates = { '2026-10': { sgdMyr: 3.1953 } };
const M = '2026-10';

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  ' + name); }

// 1. Opening numbers match the workbook (family assets, liabilities, net worth)
t('family totals match workbook 2026-10 (net ≈ 838,364)', () => {
  const f = L.familyTotals(accounts, balances, rates, M);
  assert.ok(Math.abs(f.assets - 1071360.8) < 2, 'assets ' + f.assets);
  assert.ok(Math.abs(f.liabs - 232996.85) < 0.01, 'liabs ' + f.liabs);
  assert.ok(Math.abs(f.net - 838363.95) < 2, 'net ' + f.net);
  assert.strictEqual(f.missing, 1, 'only Uning insurance is missing');
  assert.ok(Math.abs(f.ratio - 0.2175) < 0.001, 'ratio ' + f.ratio);
});

t('business excluded from family totals, shown separately', () => {
  const b = L.businessTotals(accounts, balances, rates, M);
  assert.ok(Math.abs(b.net - (44309.09 - 1489.94)) < 0.01, 'biz net ' + b.net);
  const f = L.familyTotals(accounts, balances, rates, M);
  assert.strictEqual(f.byCategory['企业现金'], undefined);
});

t('SGD accounts converted with the month rate', () => {
  const r = L.accountValues(accounts, balances, rates, M).find(x => x.acc.id === 'ocbc-sg');
  assert.ok(Math.abs(r.rm - 11953.05 * 3.1953) < 0.01);
  const r2 = L.accountValues(accounts, balances, { '2026-10': { sgdMyr: 3.2 } }, M).find(x => x.acc.id === 'ocbc-sg');
  assert.ok(Math.abs(r2.rm - 11953.05 * 3.2) < 0.01, 'uses supplied rate');
});

t('liquid cash = family 现金与定存 only', () => {
  const f = L.familyTotals(accounts, balances, rates, M);
  const expect = 11953.05 * 3.1953 + 5468.72 + 7000 + 16111.71;
  assert.ok(Math.abs(f.liquid - expect) < 0.01, 'liquid ' + f.liquid);
});

// 2. Carry-forward
t('carried value: older month balance shows as carried, not fresh', () => {
  const b = Object.assign({}, balances);
  b['2026-08__luno'] = { month: '2026-08', accountId: 'luno', amount: 200, currency: 'MYR' };
  delete b['2026-10__luno'];
  const v = L.valueAt(b, 'luno', '2026-10');
  assert.strictEqual(v.status, 'carried');
  assert.strictEqual(v.b.amount, 200);
  assert.strictEqual(L.valueAt(b, 'luno', '2026-08').status, 'fresh');
  assert.strictEqual(L.valueAt(b, 'luno', '2026-07').status, 'missing');
});

t('net worth trend skips months before the first balance', () => {
  const series = L.netWorthTrend(accounts, balances, rates, ['2026-08', '2026-09', '2026-10']);
  assert.deepStrictEqual(series.map(s => s.month), ['2026-10']);
});

// 3. Cash flow rules
const tx = [
  { id: 'a', type: 'income', month: M, amount: 8000, category: '工资', date: '2026-10-01' },
  { id: 'b', type: 'income', month: M, amount: 4000, category: '农场提款', date: '2026-10-05' },
  { id: 'c', type: 'expense', month: M, amount: 1200, category: '饮食', date: '2026-10-02' },
  { id: 'd', type: 'transfer', month: M, amount: 3000, account: 'hlb-liza', toAccount: 'pb-joint', date: '2026-10-03' },
  { id: 'e', type: 'repayment', month: M, amount: 1000, loanId: 'loan-house', principal: 700, interest: 300, date: '2026-10-04' }
];
t('cashflow: transfer excluded, repayment principal excluded, interest included', () => {
  const c = L.cashflow(tx, M);
  assert.strictEqual(c.income, 12000);
  assert.strictEqual(c.expense, 1500); // 1200 + 300 interest
  assert.strictEqual(c.net, 10500);
  assert.ok(Math.abs(c.savingsRate - 0.875) < 1e-9);
});

t('loan estimate: principal repaid after the balance date reduces the balance', () => {
  const tx2 = [
    { type: 'repayment', loanId: 'loan-house', month: '2026-09', date: '2026-09-05', principal: 500, interest: 100, amount: 600 },
    { type: 'repayment', loanId: 'loan-house', month: '2026-10', date: '2026-10-05', principal: 700, interest: 300, amount: 1000 }
  ];
  // seed balance is as of 2026-10-01: only the October repayment is after it
  const lb = L.loanBalance({ id: 'loan-house' }, balances, tx2, M);
  assert.strictEqual(lb.base, 58971);
  assert.strictEqual(lb.paid, 700);
  assert.ok(Math.abs(lb.estimate - 58271) < 0.01);
});

t('loan estimate: repayments on or before the balance asOf date are ignored', () => {
  const b = { 'x': { month: '2026-10', asOf: '2026-10-15', accountId: 'loan-hilux', amount: 90000, currency: 'MYR' } };
  const tx3 = [
    { type: 'repayment', loanId: 'loan-hilux', month: '2026-10', date: '2026-10-05', principal: 999, interest: 0, amount: 999 },
    { type: 'repayment', loanId: 'loan-hilux', month: '2026-10', date: '2026-10-20', principal: 400, interest: 0, amount: 400 }
  ];
  const lb = L.loanBalance({ id: 'loan-hilux' }, b, tx3, M);
  assert.strictEqual(lb.paid, 400);
  assert.strictEqual(lb.estimate, 89600);
});

t('average monthly expense ignores empty months; emergency months', () => {
  const series = [
    { type: 'expense', month: '2026-08', amount: 3000 },
    { type: 'expense', month: '2026-09', amount: 4000 },
    { type: 'expense', month: M, amount: 2000 }
  ];
  assert.strictEqual(L.avgMonthlyExpense(series, M, 3), 3000);
  assert.strictEqual(L.avgMonthlyExpense(series, '2026-12', 3), 2000, 'only Oct has data in Oct-Dec window');
  assert.strictEqual(L.avgMonthlyExpense(series, '2026-07', 3), 0, 'no data in window -> 0');
  assert.strictEqual(L.emergencyMonths(30000, 3000), 10);
  assert.strictEqual(L.emergencyMonths(30000, 0), null);
});

// 4. Budgets and members
t('budget status flags over-budget categories', () => {
  const cats = [{ name: '饮食', type: 'expense', budget: 1000, sort: 1 }, { name: '交通', type: 'expense', budget: 500, sort: 2 }];
  const txs = [{ type: 'expense', month: M, category: '饮食', amount: 1200 }, { type: 'income', month: M, category: '饮食', amount: 50 }];
  const s = L.budgetStatus(cats, txs, M);
  assert.strictEqual(s[0].spent, 1200);
  assert.strictEqual(s[0].over, true);
  assert.strictEqual(s[1].spent, 0);
  assert.strictEqual(s[1].over, false);
});

t('spend by member counts expenses only', () => {
  const m = L.spendByMember([
    { type: 'expense', month: M, amount: 100, member: 'Chen' },
    { type: 'expense', month: M, amount: 50, member: 'Liza' },
    { type: 'income', month: M, amount: 999, member: 'Chen' }
  ], M);
  assert.deepStrictEqual(m, { Chen: 100, Liza: 50 });
});

// 5. Recurring: due items and duplicate protection
t('recurring: due this month, dated and clamped to month length', () => {
  const rec = [{ id: 'r1', name: '房贷', type: 'repayment', amount: 1000, dayOfMonth: 31, startMonth: '2026-01', active: true, principal: 700, interest: 300, loanId: 'loan-house', account: 'pb-joint' }];
  const items = L.recurringForMonth(rec, [], '2026-02');
  assert.strictEqual(items[0].date, '2026-02-28');
  assert.strictEqual(items[0].done, false);
});

t('recurring: once materialized it is marked done and not created twice', () => {
  const rec = [{ id: 'r1', name: '保费', type: 'expense', amount: 300, dayOfMonth: 5, startMonth: '2026-01', category: '保险', active: true }];
  const item = L.recurringForMonth(rec, [], M)[0];
  const t1 = L.txFromRecurring(item, M);
  assert.strictEqual(t1.recurringKey, 'r1__2026-10');
  const after = L.recurringForMonth(rec, [t1], M);
  assert.strictEqual(after[0].done, true);
});

t('recurring: ended items are not due', () => {
  const rec = [{ id: 'r2', type: 'expense', amount: 1, dayOfMonth: 1, startMonth: '2026-01', endMonth: '2026-06', active: true }];
  assert.strictEqual(L.recurringForMonth(rec, [], M).length, 0);
});

// 6. Validation
t('validate: transfer needs two different accounts', () => {
  assert.ok(L.validateTx({ type: 'transfer', date: M + '-01', amount: 10, account: 'a', toAccount: 'a' }));
  assert.strictEqual(L.validateTx({ type: 'transfer', date: M + '-01', amount: 10, account: 'a', toAccount: 'b' }), '');
});
t('validate: repayment principal + interest must equal amount', () => {
  assert.ok(L.validateTx({ type: 'repayment', date: M + '-01', amount: 1000, loanId: 'x', principal: 700, interest: 200 }));
  assert.strictEqual(L.validateTx({ type: 'repayment', date: M + '-01', amount: 1000, loanId: 'x', principal: 700, interest: 300 }), '');
});
t('validate: expense needs category, amount > 0, real date', () => {
  assert.ok(L.validateTx({ type: 'expense', date: M + '-01', amount: 10 }));
  assert.ok(L.validateTx({ type: 'expense', date: M + '-01', amount: 0, category: '饮食' }));
  assert.ok(L.validateTx({ type: 'expense', date: '2026-02-30', amount: 5, category: '饮食' }));
  assert.strictEqual(L.validateTx({ type: 'expense', date: M + '-01', amount: 5, category: '饮食' }), '');
});

// 7. CSV import
t('CSV: quotes, commas, BOM and CRLF', () => {
  const p = L.parseCSV('﻿Date,Description,Amount\r\n01/10/2026,"HARGA, RUNCIT ""ABC""",-12.50\r\n');
  assert.deepStrictEqual(p.headers, ['Date', 'Description', 'Amount']);
  assert.strictEqual(p.rows[0].Description, 'HARGA, RUNCIT "ABC"');
});
t('CSV: DD/MM dates, negatives, RM prefix and parentheses', () => {
  assert.strictEqual(L.parseAmount('RM 1,234.50'), 1234.5);
  assert.strictEqual(L.parseAmount('(12.00)'), -12);
  assert.strictEqual(L.parseAmount('-7'), -7);
  assert.ok(isNaN(L.parseAmount('')));
  assert.strictEqual(L.parseDate('01/10/2026'), '2026-10-01');
  assert.strictEqual(L.parseDate('2026-10-01'), '2026-10-01');
  assert.strictEqual(L.parseDate('31-02-2026'), null);
});
t('CSV mapping: debit/credit columns and bad rows', () => {
  const p = L.parseCSV('Date,Desc,Debit,Credit\n05/10/2026,Grab,15.00,\n06/10/2026,Salary,,8000\nxx,bad,1,\n');
  const r = L.mapRows(p, { date: 'Date', desc: 'Desc', debit: 'Debit', credit: 'Credit' });
  assert.strictEqual(r.ok.length, 2);
  assert.strictEqual(r.ok[0].type, 'expense');
  assert.strictEqual(r.ok[0].amount, 15);
  assert.strictEqual(r.ok[1].type, 'income');
  assert.strictEqual(r.bad.length, 1);
});
t('CSV import: duplicates are skipped by importKey', () => {
  const p = L.parseCSV('Date,Desc,Amount\n05/10/2026,Grab,-15\n05/10/2026,Grab,-15\n');
  const r = L.mapRows(p, { date: 'Date', desc: 'Desc', amount: 'Amount' });
  const existing = [L.importKey('2026-10-05', -15, 'Grab')];
  const d = L.dedupe(r.ok, existing);
  assert.strictEqual(d.fresh.length, 0);
  assert.strictEqual(d.dup.length, 2);
  const d2 = L.dedupe(r.ok, []);
  assert.strictEqual(d2.fresh.length, 1, 'same line twice in one file imports once');
});

t('CSV export escapes commas and quotes', () => {
  const out = L.toCSV([{ n: 'a,b', v: 'say "hi"' }], [{ label: 'N', get: r => r.n }, { label: 'V', get: r => r.v }]);
  assert.ok(out.startsWith('﻿'));
  assert.ok(out.includes('"a,b","say ""hi"""'));
});

t('month helpers across year boundary', () => {
  assert.strictEqual(L.addMonths('2026-12', 1), '2027-01');
  assert.strictEqual(L.addMonths('2027-01', -1), '2026-12');
  assert.deepStrictEqual(L.monthRange('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
  assert.strictEqual(L.dateInMonth('2026-02', 31), '2026-02-28');
});

// 8. PDF statements
t('PDF: text items grouped into lines by y, ordered by x, pages top to bottom', () => {
  const items = [
    { str: '7,000.00', x: 400, y: 700.2, w: 40 }, { str: '01/10/2026', x: 20, y: 699.9, w: 50 }, { str: 'BALANCE B/F', x: 120, y: 700, w: 60 },
    { str: '03/10/2026', x: 20, y: 680, w: 50 }, { str: 'TRANSFER', x: 120, y: 680, w: 45 }, { str: ' FROM HLB', x: 165, y: 680, w: 45 }, { str: '3,000.00', x: 300, y: 680, w: 40 }, { str: '10,000.00', x: 400, y: 680, w: 45 }
  ];
  const lines = L.linesFromItems(items);
  assert.deepStrictEqual(lines, ['01/10/2026 BALANCE B/F 7,000.00', '03/10/2026 TRANSFER FROM HLB 3,000.00 10,000.00']);
});
t('PDF: direction confirmed from the running balance; opening balance line skipped; continuation lines appended', () => {
  const r = L.parseStatement([
    'Statement Date: 31/10/2026', 'Date Description Debit Credit Balance',
    '01/10/2026 BALANCE B/F 7,000.00',
    '03/10/2026 TRANSFER FROM HLB LIZA 3,000.00 10,000.00',
    '05/10/2026 GRAB*TRIP 15.00 9,985.00', 'REF 123456',
    '06/10/2026 SALARY CREDIT 8,000.00 17,985.00',
    '31/10/2026 BALANCE C/F 17,985.00', 'Page 1 of 1'
  ]);
  assert.strictEqual(r.ok.length, 3);
  assert.deepStrictEqual(r.ok.map(x => x.signed), [3000, -15, 8000]);
  assert.ok(r.ok.every(x => x.sure));
  assert.strictEqual(r.ok[1].desc, 'GRAB*TRIP REF 123456');
  assert.strictEqual(r.ok[1].importKey, L.importKey('2026-10-05', -15, 'GRAB*TRIP REF 123456'));
  assert.strictEqual(r.bad.length, 0);
});
t('PDF: DR/CR and trailing-minus markers, month names, 2-digit years, double dates', () => {
  const r = L.parseStatement([
    '01 OCT 2026 SHOPEE 120.50',
    '02 OCT 2026 PAYMENT - THANK YOU 500.00 CR',
    '05-10-26 ATM WITHDRAWAL 200.00- 9,800.00',
    '07/10/2026 08/10/2026 TNG EWALLET 50.00 DR 9,750.00',
    '09/10/2026 INTEREST 1.23 CR 9,751.23'
  ]);
  assert.deepStrictEqual(r.ok.map(x => x.date), ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-07', '2026-10-09']);
  assert.deepStrictEqual(r.ok.map(x => x.type), ['expense', 'income', 'expense', 'expense', 'income']);
  assert.strictEqual(r.ok[0].sure, false, 'single amount, no marker: direction is a guess');
  assert.strictEqual(r.ok[1].sure, true);
  assert.strictEqual(r.ok[3].desc, 'TNG EWALLET');
  const flipped = L.flipRow(r.ok[0]);
  assert.strictEqual(flipped.type, 'income');
  assert.strictEqual(flipped.importKey, L.importKey('2026-10-01', 120.5, 'SHOPEE'));
});
t('PDF: year taken from the statement header when lines have none', () => {
  const lines = ['Penyata Akaun 01/09/2025 - 30/09/2025', '03 SEP GIANT 88.00 912.00'];
  assert.strictEqual(L.guessYear(lines), 2025);
  assert.strictEqual(L.parseStatement(lines).ok[0].date, '2025-09-03');
  assert.strictEqual(L.parseStatement(lines, { year: 2024 }).ok[0].date, '2024-09-03');
});
t('PDF: duplicates against existing transactions are skipped via importKey', () => {
  const r = L.parseStatement(['05/10/2026 GRAB*TRIP 15.00 DR 9,985.00']);
  const d = L.dedupe(r.ok, [L.importKey('2026-10-05', -15, 'GRAB*TRIP')]);
  assert.strictEqual(d.fresh.length, 0);
  assert.strictEqual(d.dup.length, 1);
});

// 9. Loan helpers
t('loan: monthly interest estimate and months to payoff', () => {
  assert.strictEqual(L.estimateInterest(58971, 4.5), 221.14);
  assert.strictEqual(L.estimateInterest(0, 4.5), 0);
  assert.strictEqual(L.monthsToPayoff(1200, 0, 100), 12);
  const n = L.monthsToPayoff(58971, 4.5, 1000);
  assert.ok(n > 59 && n < 70, 'months ' + n);
  assert.strictEqual(L.monthsToPayoff(100000, 12, 500), null, 'payment below interest never clears');
  assert.ok(L.totalInterestToPayoff(58971, 4.5, 1000) > 5000);
});
// 10. Reports
const rtx = [
  { type: 'expense', month: M, amount: 300, category: '饮食', account: 'pb-joint', date: M + '-02', note: 'Giant' },
  { type: 'expense', month: M, amount: 100, category: '交通与油费', account: 'pb-joint', date: M + '-03', note: 'Petrol' },
  { type: 'expense', month: '2026-09', amount: 250, category: '饮食', account: 'pb-joint', date: '2026-09-02', note: 'Giant' },
  { type: 'income', month: M, amount: 8000, category: '工资', account: 'hlb-liza', date: M + '-01', note: 'Gaji' },
  { type: 'transfer', month: M, amount: 3000, account: 'hlb-liza', toAccount: 'pb-joint', date: M + '-03' },
  { type: 'repayment', month: M, amount: 1000, principal: 700, interest: 300, loanId: 'loan-house', account: 'pb-joint', date: M + '-05' }
];
t('category report: sorted, share of total, compared with last month, loan interest included', () => {
  const r = L.categoryReport(rtx, M);
  assert.deepStrictEqual(r.map(x => x.name), ['饮食', '贷款利息', '交通与油费']);
  assert.strictEqual(r[0].prev, 250);
  assert.strictEqual(r[0].delta, 50);
  assert.ok(Math.abs(r[0].pct - 300 / 700) < 1e-9);
});
t('account flow: income in, expense/repayment out, transfers on both sides', () => {
  const f = L.accountFlow(rtx, M);
  assert.deepStrictEqual(f['hlb-liza'], { in: 8000, out: 3000, n: 2 });
  assert.deepStrictEqual(f['pb-joint'], { in: 3000, out: 1400, n: 4 });
});
t('year summary: 12 rows with totals', () => {
  const y = L.yearSummary(rtx, 2026);
  assert.strictEqual(y.rows.length, 12);
  assert.strictEqual(y.total.income, 8000);
  assert.strictEqual(y.total.expense, 950);
  assert.strictEqual(y.rows[9].net, 8000 - 700);
});
t('frequent categories and recent notes', () => {
  assert.deepStrictEqual(L.frequentCategories(rtx, 'expense', 5), ['饮食', '交通与油费']);
  assert.deepStrictEqual(L.recentNotes(rtx, 10), ['Petrol', 'Giant', 'Gaji']);
  assert.strictEqual(L.topExpenses(rtx, M, 1)[0].amount, 300);
});
t('chart points scale into the box', () => {
  const c = L.chartPoints([10, 20, 30], 100, 50, 5);
  assert.strictEqual(c.points.length, 3);
  assert.strictEqual(c.points[0].x, 5);
  assert.strictEqual(c.points[2].x, 95);
  assert.strictEqual(c.points[2].y, 5);
  assert.strictEqual(c.points[0].y, 45);
});

// 11. Estimates, budgets, goals, insights
t('cash estimate: last balance plus flows after asOf (RM accounts only)', () => {
  const b = { 'x': { month: M, asOf: '2026-10-05', accountId: 'pb-joint', amount: 7000, currency: 'MYR' } };
  const flows = [
    { type: 'income', date: '2026-10-06', month: M, amount: 8000, account: 'pb-joint' },
    { type: 'expense', date: '2026-10-07', month: M, amount: 100, account: 'pb-joint' },
    { type: 'transfer', date: '2026-10-08', month: M, amount: 500, account: 'pb-joint', toAccount: 'hlb-liza' },
    { type: 'expense', date: '2026-10-03', month: M, amount: 999, account: 'pb-joint' }
  ];
  const e = L.cashEstimate(accounts['pb-joint'], b, flows, M);
  assert.strictEqual(e.estimate, 14400);
  assert.strictEqual(e.n, 3);
  assert.strictEqual(L.cashEstimate(accounts['ocbc-sg'], b, flows, M), null);
});
t('budget summary: overall budget, remaining, daily allowance', () => {
  const cats = [{ name: '饮食', type: 'expense', budget: 1000 }, { name: '交通', type: 'expense', budget: 500 }];
  const txs = [{ type: 'expense', month: M, amount: 600, category: '饮食' }];
  const b = L.budgetSummary(cats, txs, M, 0, '2026-10-21');
  assert.strictEqual(b.budget, 1500);
  assert.strictEqual(b.remaining, 900);
  assert.strictEqual(b.daysLeft, 11);
  assert.ok(Math.abs(b.daily - 900 / 11) < 1e-9);
  assert.strictEqual(L.budgetSummary(cats, txs, M, 3000, '2026-10-21').budget, 3000);
  assert.strictEqual(L.budgetSummary(cats, txs, '2026-09', 0, '2026-10-21').daysLeft, 0);
});
t('goal progress from linked account and target month', () => {
  const g = { target: 30000, accountId: 'hlb-liza', targetMonth: '2027-04' };
  const p = L.goalProgress(g, accounts, balances, rates, M);
  assert.strictEqual(p.current, 16111.71);
  assert.strictEqual(p.monthsLeft, 6);
  assert.ok(Math.abs(p.perMonth - (30000 - 16111.71) / 6) < 1e-6);
  assert.strictEqual(L.goalProgress({ target: 100, saved: 150 }, {}, {}, {}, M).done, true);
});
t('insights: spend change and category jump', () => {
  const txs = [
    { type: 'expense', month: '2026-09', amount: 1000, category: '饮食' }, { type: 'expense', month: M, amount: 1500, category: '饮食' },
    { type: 'income', month: M, amount: 5000, category: '工资' }
  ];
  const ins = L.insights(txs, M);
  assert.ok(ins.some(x => /多 50%/.test(x.text)), JSON.stringify(ins));
  assert.ok(ins.some(x => /饮食.*多花 500/.test(x.text)));
  assert.ok(ins.some(x => /储蓄率 70%/.test(x.text)));
});
t('similar entries detected', () => {
  const txs = [{ id: 'a', type: 'expense', date: M + '-02', amount: 23.5, category: '饮食', account: 'pb-joint' }];
  assert.strictEqual(L.findSimilar(txs, { type: 'expense', date: M + '-02', amount: 23.5, category: '饮食', account: 'pb-joint' }).length, 1);
  assert.strictEqual(L.findSimilar(txs, { type: 'expense', date: M + '-02', amount: 23.5, category: '饮食', account: 'pb-joint' }, 'a').length, 0);
});

// 12. Amount expressions, amortization, recurring skip
t('amount expressions: arithmetic, parentheses, rejects junk', () => {
  assert.strictEqual(L.evalAmount('12+8.5*2'), 29);
  assert.strictEqual(L.evalAmount('(100-10)/3'), 30);
  assert.strictEqual(L.evalAmount(' 1,250.50 '), 1250.5);
  assert.strictEqual(L.evalAmount('-5+10'), 5);
  assert.ok(isNaN(L.evalAmount('12+')));
  assert.ok(isNaN(L.evalAmount('alert(1)')));
  assert.ok(isNaN(L.evalAmount('')));
});
t('amortization schedule reduces the balance and stops at payoff', () => {
  const rows = L.amortization(1000, 12, 300, 12, '2026-10');
  assert.strictEqual(rows[0].interest, 10);
  assert.strictEqual(rows[0].principal, 290);
  assert.strictEqual(rows[0].month, '2026-11');
  assert.strictEqual(rows[rows.length - 1].balance, 0);
  assert.ok(rows.length === 4, 'rows ' + rows.length);
  assert.strictEqual(L.amortization(1000, 24, 10).length, 0, 'payment below interest -> no schedule');
});
t('recurring: a skipped month counts as done', () => {
  const rec = [{ id: 'r1', type: 'expense', amount: 1, dayOfMonth: 1, startMonth: '2026-01', active: true, skipped: ['2026-10'] }];
  const it = L.recurringForMonth(rec, [], '2026-10')[0];
  assert.strictEqual(it.done, true);
  assert.strictEqual(it.skipped, true);
  assert.strictEqual(L.recurringForMonth(rec, [], '2026-11')[0].done, false);
});

// 13. Calendar, weeks, auto-post
t('calendar grid: Monday-first weeks with padding', () => {
  const g = L.calendarGrid('2026-10'); // 1 Oct 2026 is a Thursday
  assert.strictEqual(g[0][3], '2026-10-01');
  assert.strictEqual(g[0][0], null);
  assert.strictEqual(g[g.length - 1].length, 7);
  assert.strictEqual(g.flat().filter(Boolean).length, 31);
});
t('day and week totals', () => {
  const txs = [
    { type: 'expense', month: M, date: '2026-10-01', amount: 10 }, { type: 'expense', month: M, date: '2026-10-02', amount: 20 },
    { type: 'income', month: M, date: '2026-10-05', amount: 100 }, { type: 'repayment', month: M, date: '2026-10-05', amount: 50, interest: 5 }
  ];
  const d = L.dayTotals(txs, M);
  assert.deepStrictEqual(d['2026-10-05'], { expense: 5, income: 100, n: 2 });
  const w = L.weekSummary(txs, M);
  assert.strictEqual(w[0].start, '2026-10-01');
  assert.strictEqual(w[0].end, '2026-10-04');
  assert.strictEqual(w[0].expense, 30);
  assert.strictEqual(w[1].income, 100);
});
t('auto-post picks due, unposted, autoPost items only', () => {
  const rec = [
    { id: 'a', type: 'expense', amount: 10, dayOfMonth: 5, startMonth: '2026-01', active: true, autoPost: true, category: '饮食' },
    { id: 'b', type: 'expense', amount: 10, dayOfMonth: 20, startMonth: '2026-01', active: true, autoPost: true, category: '饮食' },
    { id: 'c', type: 'expense', amount: 10, dayOfMonth: 1, startMonth: '2026-01', active: true, category: '饮食' }
  ];
  const due = L.dueAutoPost(rec, [], '2026-10-15');
  assert.deepStrictEqual(due.map(x => x.rec.id), ['a']);
  const posted = [L.txFromRecurring(due[0], M)];
  assert.strictEqual(L.dueAutoPost(rec, posted, '2026-10-15').length, 0);
});

console.log('\n' + passed + ' tests passed');
