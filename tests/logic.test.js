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

console.log('\n' + passed + ' tests passed');
