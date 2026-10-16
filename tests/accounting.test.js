'use strict';
/* Accounting correctness matrix: the cases that make or break trust in the numbers.
 * Model recap: balances are recorded per account per month (manual or batch), cash flow comes from tx.
 * Net worth = sum(asset balances in RM) − sum(liability balances); income/expense from tx only. */
const assert = require('assert');
const L = require('../src/logic.js');

const M = '2026-10';
const accounts = {
  pbb: { id: 'pbb', name: 'Public Bank', kind: 'asset', group: 'family', category: '现金与定存', currency: 'MYR', active: true },
  mbb: { id: 'mbb', name: 'Maybank', kind: 'asset', group: 'family', category: '现金与定存', currency: 'MYR', active: true },
  card: { id: 'card', name: 'Visa', kind: 'liability', group: 'family', category: '信用卡', currency: 'MYR', active: true },
  loan: { id: 'loan', name: '房贷', kind: 'liability', group: 'family', category: '房贷', currency: 'MYR', active: true },
  stock: { id: 'stock', name: 'MooMoo', kind: 'asset', group: 'family', category: '投资', currency: 'MYR', active: true },
  sg: { id: 'sg', name: 'OCBC SG', kind: 'asset', group: 'family', category: '现金与定存', currency: 'SGD', active: true },
  biz: { id: 'biz', name: 'Agrijoy PBB', kind: 'asset', group: 'business', category: '企业现金', currency: 'MYR', active: true }
};
function bal(id, amount, month, asOf) { return { month: month || M, asOf: asOf || (month || M) + '-01', accountId: id, amount, currency: accounts[id].currency }; }
const balances = { a: bal('pbb', 10000), b: bal('mbb', 5000), c: bal('card', 800), d: bal('loan', 100000), e: bal('stock', 20000), f: bal('sg', 1000), g: bal('biz', 40000) };
const rates = { [M]: { sgdMyr: 3.2 } };
let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  ' + name); }
const net = (b, acc) => L.familyTotals(acc || accounts, b || balances, rates, M);

t('baseline net worth: assets in RM (SGD converted) minus liabilities; business excluded', () => {
  const f = net();
  assert.strictEqual(f.assets, 10000 + 5000 + 20000 + 1000 * 3.2);
  assert.strictEqual(f.liabs, 800 + 100000);
  assert.strictEqual(f.net, f.assets - f.liabs);
  assert.strictEqual(L.businessTotals(accounts, balances, rates, M).net, 40000);
});

t('transfer PBB → Maybank is not income or expense, and does not change net worth', () => {
  const tx = [{ type: 'transfer', month: M, date: M + '-05', amount: 1000, account: 'pbb', toAccount: 'mbb' }];
  const c = L.cashflow(tx, M);
  assert.strictEqual(c.income, 0); assert.strictEqual(c.expense, 0);
  const fl = L.accountFlow(tx, M);
  assert.deepStrictEqual([fl.pbb.out, fl.mbb.in], [1000, 1000]);
  // flow-based estimates move money between the two accounts, total unchanged
  const e1 = L.cashEstimate(accounts.pbb, balances, tx, M), e2 = L.cashEstimate(accounts.mbb, balances, tx, M);
  assert.strictEqual(e1.estimate + e2.estimate, 15000);
});

t('credit card purchase: expense once, from the card account; paying the bill is a transfer, not a second expense', () => {
  const tx = [
    { type: 'expense', month: M, date: M + '-03', amount: 200, account: 'card', category: '日用' },
    { type: 'transfer', month: M, date: M + '-10', amount: 200, account: 'pbb', toAccount: 'card' }
  ];
  const c = L.cashflow(tx, M);
  assert.strictEqual(c.expense, 200, 'expense counted exactly once');
  const rep = L.categoryReport(tx, M);
  assert.strictEqual(rep.length, 1); assert.strictEqual(rep[0].amount, 200);
  const fl = L.accountFlow(tx, M);
  assert.strictEqual(fl.pbb.out, 200);
});

t('loan repayment: interest is expense, principal is not; estimated loan balance drops by principal only', () => {
  const tx = [{ type: 'repayment', month: M, date: M + '-05', amount: 720, principal: 400, interest: 320, loanId: 'loan', account: 'pbb' }];
  const c = L.cashflow(tx, M);
  assert.strictEqual(c.expense, 320); assert.strictEqual(c.interest, 320);
  const lb = L.loanBalance(accounts.loan, balances, tx, M);
  assert.strictEqual(lb.paid, 400); assert.strictEqual(lb.estimate, 99600);
  assert.strictEqual(L.validateTx({ type: 'repayment', date: M + '-05', amount: 720, loanId: 'loan', principal: 400, interest: 300 }), '本金加利息必须等于还款金额');
  const est = L.cashEstimate(accounts.pbb, balances, tx, M);
  assert.strictEqual(est.estimate, 10000 - 720, 'full instalment leaves the paying account');
});

t('buying RM5,000 of shares is a transfer into the investment account, never consumption', () => {
  const tx = [{ type: 'transfer', month: M, date: M + '-06', amount: 5000, account: 'pbb', toAccount: 'stock' }];
  assert.strictEqual(L.cashflow(tx, M).expense, 0);
  assert.strictEqual(L.accountFlow(tx, M).stock.in, 5000);
});

t('valuation change: a higher stock balance raises net worth but is not income', () => {
  const b2 = Object.assign({}, balances, { e: bal('stock', 20500) });
  assert.strictEqual(net(b2).net - net().net, 500);
  assert.strictEqual(L.cashflow([], M).income, 0);
});

t('taking a RM10,000 loan: cash and liability both rise, net worth unchanged', () => {
  const b2 = Object.assign({}, balances, { a: bal('pbb', 20000), d: bal('loan', 110000) });
  assert.strictEqual(net(b2).net, net().net);
});

t('business ↔ family transfer: only a recorded income (提款) enters family cash flow; balances stay separate', () => {
  const tx = [{ type: 'income', month: M, date: M + '-07', amount: 3000, account: 'pbb', category: '生意提款' }];
  assert.strictEqual(L.cashflow(tx, M).income, 3000);
  const f = net(); const b = L.businessTotals(accounts, balances, rates, M);
  assert.ok(!('企业现金' in f.byCategory)); assert.strictEqual(b.net, 40000);
});

t('recurring items never post twice for the same month (key = id__month), skip counts as done', () => {
  const rec = [{ id: 'r1', name: 'Unifi', type: 'expense', amount: 129, dayOfMonth: 1, startMonth: '2026-01', active: true, category: '水电网', account: 'pbb', autoPost: true }];
  const first = L.dueAutoPost(rec, [], M + '-15');
  assert.strictEqual(first.length, 1);
  const posted = [L.txFromRecurring(first[0], M)];
  assert.strictEqual(posted[0].recurringKey, 'r1__' + M);
  assert.strictEqual(L.dueAutoPost(rec, posted, M + '-20').length, 0);
  assert.strictEqual(L.recurringForMonth([Object.assign({}, rec[0], { skipped: [M] })], [], M)[0].done, true);
});

t('editing or deleting a transaction recomputes every derived figure (no cached totals)', () => {
  const tx = [{ id: 'x', type: 'expense', month: M, date: M + '-02', amount: 100, account: 'pbb', category: '饮食' }];
  assert.strictEqual(L.cashflow(tx, M).expense, 100);
  tx[0].amount = 60;
  assert.strictEqual(L.cashflow(tx, M).expense, 60);
  assert.strictEqual(L.cashflow([], M).expense, 0);
});

t('SGD: original amount, rate and valuation month are kept; RM value follows the month rate', () => {
  const r = L.accountValues(accounts, balances, rates, M).find(x => x.acc.id === 'sg');
  assert.strictEqual(r.amount, 1000); assert.strictEqual(r.rm, 3200);
  const r2 = L.accountValues(accounts, balances, { [M]: { sgdMyr: 3.1 } }, M).find(x => x.acc.id === 'sg');
  assert.strictEqual(r2.rm, 3100);
  const fx = { currency: 'SGD', amount: 10, rate: 3.2 };
  assert.strictEqual(L.round2(fx.amount * fx.rate), 32);
});

t('imported bank lines are de-duplicated by date + signed amount + description', () => {
  const k = L.importKey('2026-10-05', -15, 'GRAB');
  const d = L.dedupe([{ importKey: k }, { importKey: k }], []);
  assert.strictEqual(d.fresh.length, 1); assert.strictEqual(d.dup.length, 1);
});

t('money arithmetic: sums of many cents stay exact after round2', () => {
  const tx = []; for (let i = 0; i < 1000; i++) tx.push({ type: 'expense', month: M, amount: 0.1, category: 'x' });
  assert.strictEqual(L.round2(L.cashflow(tx, M).expense), 100);
  assert.strictEqual(L.round2(0.1 + 0.2), 0.3);
  assert.strictEqual(L.evalAmount('19.99*3'), 59.97);
});

t('carried balances: last known value is used until a new month is recorded, flagged as carried', () => {
  const b = { a: bal('pbb', 10000, '2026-08') };
  const v = L.valueAt(b, 'pbb', M);
  assert.strictEqual(v.status, 'carried'); assert.strictEqual(v.b.amount, 10000);
  assert.strictEqual(L.familyTotals({ pbb: accounts.pbb }, b, rates, M).carried, 1);
});

console.log('\n' + passed + ' accounting tests passed');
