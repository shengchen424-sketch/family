/* Family assets & expenses — pure calculation logic (no DOM, no storage).
 * Used by the page in the browser and by node tests.
 * Money is in RM unless a function says otherwise. Months are 'YYYY-MM'. Dates are 'YYYY-MM-DD'.
 */
(function (root) {
  'use strict';

  var DEFAULT_RATE = 3.1953;
  var TX_TYPES = ['income', 'expense', 'transfer', 'repayment'];

  // ---------- dates ----------
  function todayKuching() {
    return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  }
  function nowMonth() { return todayKuching().slice(0, 7); }
  function addMonths(ym, n) {
    var p = ym.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  }
  function monthRange(endYm, n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) out.push(addMonths(endYm, -i));
    return out;
  }
  function daysInMonth(ym) {
    var p = ym.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
  }
  function dateInMonth(ym, day) {
    var d = Math.min(Math.max(1, Number(day) || 1), daysInMonth(ym));
    return ym + '-' + String(d).padStart(2, '0');
  }
  function isDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
    var p = s.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }
  // Accepts YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY, DD-MM-YYYY (Malaysian order: day first)
  function parseDate(s) {
    s = String(s || '').trim();
    var m;
    if ((m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/))) return fmtDate(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/))) return fmtDate(+m[3], +m[2], +m[1]);
    return null;
  }
  function fmtDate(y, mo, d) {
    var s = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    return isDate(s) ? s : null;
  }

  // ---------- balances and rates ----------
  function rateFor(rates, m) {
    var ks = Object.keys(rates || {}).filter(function (k) { return k <= m; }).sort();
    var k = ks[ks.length - 1];
    return k ? Number(rates[k].sgdMyr) : DEFAULT_RATE;
  }
  function latestBalance(balances, accId, m) {
    var best = null;
    Object.keys(balances || {}).forEach(function (k) {
      var b = balances[k];
      if (b.accountId !== accId || b.month > m) return;
      if (!best || b.month > best.month) best = b;
    });
    return best;
  }
  // status: 'fresh' (recorded this month), 'carried' (last known value from an earlier month), 'missing'
  function valueAt(balances, accId, m) {
    var b = latestBalance(balances, accId, m);
    if (!b) return { status: 'missing', b: null };
    return { status: b.month === m ? 'fresh' : 'carried', b: b };
  }
  function toRM(acc, amount, rate) {
    return acc.currency === 'SGD' ? amount * rate : amount;
  }
  function activeAccounts(accounts) {
    return Object.keys(accounts || {}).map(function (k) { return accounts[k]; })
      .filter(function (a) { return a.active !== false; })
      .sort(function (a, b) {
        return ((a.sort || 0) - (b.sort || 0)) || String(a.name).localeCompare(String(b.name));
      });
  }
  function accountValues(accounts, balances, rates, m) {
    return activeAccounts(accounts).map(function (acc) {
      var v = valueAt(balances, acc.id, m);
      var rate = rateFor(rates, m);
      return {
        acc: acc,
        status: v.status,
        amount: v.b ? v.b.amount : null,
        rm: v.b ? toRM(acc, v.b.amount, rate) : null,
        month: v.b ? v.b.month : null
      };
    });
  }

  // Totals for one group ('family' or 'business') as of month m.
  function groupTotals(accounts, balances, rates, m, group) {
    var rows = accountValues(accounts, balances, rates, m).filter(function (r) { return r.acc.group === group; });
    var t = { assets: 0, liabs: 0, net: 0, ratio: null, missing: 0, carried: 0, liquid: 0, byCategory: {} };
    rows.forEach(function (r) {
      if (r.status === 'missing') { t.missing++; return; }
      if (r.status === 'carried') t.carried++;
      if (r.acc.kind === 'asset') {
        t.assets += r.rm;
        var c = r.acc.category || '其他';
        t.byCategory[c] = (t.byCategory[c] || 0) + r.rm;
        if (c === '现金与定存') t.liquid += r.rm;
      } else {
        t.liabs += r.rm;
      }
    });
    t.net = t.assets - t.liabs;
    t.ratio = t.assets > 0 ? t.liabs / t.assets : null;
    return t;
  }
  function familyTotals(accounts, balances, rates, m) { return groupTotals(accounts, balances, rates, m, 'family'); }
  function businessTotals(accounts, balances, rates, m) { return groupTotals(accounts, balances, rates, m, 'business'); }

  // Net worth for each month in `months` where at least one balance exists on or before it.
  function netWorthTrend(accounts, balances, rates, months) {
    var out = [];
    months.forEach(function (m) {
      var any = Object.keys(balances || {}).some(function (k) { return balances[k].month <= m; });
      if (!any) return;
      var t = familyTotals(accounts, balances, rates, m);
      out.push({ month: m, assets: t.assets, liabs: t.liabs, net: t.net, missing: t.missing });
    });
    return out;
  }

  // ---------- cash flow ----------
  // Income: type income. Expense: type expense plus the interest part of repayments. Principal is not expense.
  function cashflow(tx, m) {
    var income = 0, expense = 0, interest = 0;
    (tx || []).forEach(function (t) {
      if (t.month !== m) return;
      var amt = Number(t.amount) || 0;
      if (t.type === 'income') income += amt;
      else if (t.type === 'expense') expense += amt;
      else if (t.type === 'repayment') { interest += Number(t.interest) || 0; expense += Number(t.interest) || 0; }
    });
    var net = income - expense;
    return { income: income, expense: expense, interest: interest, net: net, savingsRate: income > 0 ? net / income : null };
  }
  function cashflowSeries(tx, months) {
    return months.map(function (m) { var c = cashflow(tx, m); return { month: m, income: c.income, expense: c.expense, net: c.net }; });
  }
  // Average monthly expense over the last n months ending at m. Months with no records do not count.
  function avgMonthlyExpense(tx, m, n) {
    n = n || 3;
    var months = monthRange(m, n);
    var sums = months.map(function (x) { return cashflow(tx, x).expense; });
    var used = sums.filter(function (s) { return s > 0; });
    if (!used.length) return 0;
    return used.reduce(function (a, b) { return a + b; }, 0) / used.length;
  }
  // How many months of expenses the liquid cash can cover.
  function emergencyMonths(liquid, avgExpense) {
    return avgExpense > 0 ? liquid / avgExpense : null;
  }

  // ---------- budgets ----------
  function budgetStatus(categories, tx, m) {
    return (categories || []).filter(function (c) { return c.type === 'expense' && Number(c.budget) > 0; })
      .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); })
      .map(function (c) {
        var spent = (tx || []).reduce(function (s, t) {
          if (t.month !== m || t.category !== c.name) return s;
          return s + (t.type === 'expense' ? Number(t.amount) || 0 : 0);
        }, 0);
        var budget = Number(c.budget);
        return { name: c.name, budget: budget, spent: spent, pct: spent / budget, over: spent > budget };
      });
  }
  function spendByMember(tx, m) {
    var out = {};
    (tx || []).forEach(function (t) {
      if (t.month !== m || t.type !== 'expense') return;
      var k = t.member || '未指定';
      out[k] = (out[k] || 0) + (Number(t.amount) || 0);
    });
    return out;
  }

  // ---------- recurring items ----------
  // Items due this month. done=true when a transaction with the same recurringKey already exists.
  function recurringForMonth(recurring, tx, m) {
    var done = {};
    (tx || []).forEach(function (t) { if (t.recurringKey) done[t.recurringKey] = true; });
    return (recurring || [])
      .filter(function (r) {
        return r.active !== false && (!r.startMonth || r.startMonth <= m) && (!r.endMonth || r.endMonth >= m);
      })
      .map(function (r) {
        var key = r.id + '__' + m;
        return { rec: r, key: key, done: !!done[key], date: dateInMonth(m, r.dayOfMonth) };
      })
      .sort(function (a, b) { return a.date.localeCompare(b.date); });
  }
  // Transaction object created from a recurring item.
  function txFromRecurring(item, m) {
    var r = item.rec;
    var t = {
      date: item.date, month: m, type: r.type, amount: Number(r.amount) || 0,
      account: r.account || null, category: r.category || '', member: r.member || '',
      note: r.name || '', recurringKey: item.key
    };
    if (r.type === 'repayment') {
      t.loanId = r.loanId || null;
      t.principal = Number(r.principal) || 0;
      t.interest = Number(r.interest) || 0;
    }
    return t;
  }

  // ---------- loans ----------
  // Balance records may carry asOf (YYYY-MM-DD). Without it, the balance counts as of the 1st of its month.
  function asOfOf(b) { return b.asOf || (b.month + '-01'); }
  // Estimated loan balance = last recorded balance minus principal repaid after its asOf date (up to month m).
  function loanBalance(acc, balances, tx, m) {
    var v = latestBalance(balances, acc.id, m);
    if (!v) return { base: null, baseMonth: null, paid: 0, estimate: null };
    var asOf = asOfOf(v);
    var paid = (tx || []).reduce(function (s, t) {
      if (t.type !== 'repayment' || t.loanId !== acc.id) return s;
      if (!(t.date > asOf) || t.month > m) return s;
      return s + (Number(t.principal) || 0);
    }, 0);
    return { base: v.amount, baseMonth: v.month, asOf: asOf, paid: paid, estimate: Math.max(0, v.amount - paid) };
  }

  // ---------- validation ----------
  function validateTx(t) {
    if (TX_TYPES.indexOf(t.type) < 0) return '类型不正确';
    if (!isDate(t.date)) return '日期不正确';
    var a = Number(t.amount);
    if (!isFinite(a) || a <= 0) return '金额必须大于 0';
    if (t.type === 'transfer') {
      if (!t.account || !t.toAccount) return '转账需要选择转出和转入账户';
      if (t.account === t.toAccount) return '转出和转入不能是同一账户';
    }
    if (t.type === 'repayment') {
      if (!t.loanId) return '还款需要选择贷款';
      var p = Number(t.principal) || 0, i = Number(t.interest) || 0;
      if (Math.abs(p + i - a) > 0.005) return '本金加利息必须等于还款金额';
    }
    if ((t.type === 'income' || t.type === 'expense') && !t.category) return '请选择分类';
    return '';
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* ignore */ }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    var nonEmpty = rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ''; }); });
    var headers = (nonEmpty[0] || []).map(function (h) { return h.trim(); });
    var data = nonEmpty.slice(1).map(function (r) {
      var o = {};
      headers.forEach(function (h, idx) { o[h] = (r[idx] === undefined ? '' : r[idx]).trim(); });
      return o;
    });
    return { headers: headers, rows: data };
  }
  // "RM 1,234.50" -> 1234.5 ; "(12.00)" -> -12 ; "" -> NaN
  function parseAmount(s) {
    s = String(s || '').trim();
    if (s === '') return NaN;
    var neg = /^\(.*\)$/.test(s) || /-/.test(s);
    var n = parseFloat(s.replace(/[^0-9.]/g, ''));
    if (!isFinite(n)) return NaN;
    return neg ? -n : n;
  }
  function normalizeText(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function importKey(date, signed, desc) {
    return date + '|' + Number(signed).toFixed(2) + '|' + normalizeText(desc);
  }
  // mapping: {date: 'Date', desc: 'Description', amount: 'Amount'} or {debit:'Debit', credit:'Credit'}
  function mapRows(parsed, mapping) {
    var ok = [], bad = [];
    parsed.rows.forEach(function (r, idx) {
      var date = parseDate(r[mapping.date]);
      var desc = String(r[mapping.desc] || '').trim();
      var signed;
      if (mapping.amount) signed = parseAmount(r[mapping.amount]);
      else {
        var cr = parseAmount(r[mapping.credit]), dr = parseAmount(r[mapping.debit]);
        signed = isFinite(cr) && cr !== 0 ? Math.abs(cr) : (isFinite(dr) ? -Math.abs(dr) : NaN);
      }
      if (!date || !isFinite(signed) || signed === 0) { bad.push({ line: idx + 2, raw: r }); return; }
      ok.push({
        date: date, month: date.slice(0, 7), desc: desc || '（无描述）',
        type: signed < 0 ? 'expense' : 'income', amount: Math.abs(signed), signed: signed,
        importKey: importKey(date, signed, desc)
      });
    });
    return { ok: ok, bad: bad };
  }
  // Splits candidates into new rows and rows already imported before (by importKey).
  function dedupe(candidates, existingKeys) {
    var seen = {}, fresh = [], dup = [];
    (existingKeys || []).forEach(function (k) { seen[k] = true; });
    candidates.forEach(function (c) {
      if (seen[c.importKey]) dup.push(c);
      else { seen[c.importKey] = true; fresh.push(c); }
    });
    return { fresh: fresh, dup: dup };
  }
  function csvEscape(v) {
    var s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCSV(rows, cols) {
    var lines = [cols.map(function (c) { return csvEscape(c.label); }).join(',')];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvEscape(c.get(r)); }).join(',')); });
    return '﻿' + lines.join('\r\n');
  }

  var api = {
    DEFAULT_RATE: DEFAULT_RATE, TX_TYPES: TX_TYPES,
    todayKuching: todayKuching, nowMonth: nowMonth, addMonths: addMonths, monthRange: monthRange,
    daysInMonth: daysInMonth, dateInMonth: dateInMonth, isDate: isDate, parseDate: parseDate,
    rateFor: rateFor, latestBalance: latestBalance, valueAt: valueAt, toRM: toRM,
    activeAccounts: activeAccounts, accountValues: accountValues,
    groupTotals: groupTotals, familyTotals: familyTotals, businessTotals: businessTotals,
    netWorthTrend: netWorthTrend,
    cashflow: cashflow, cashflowSeries: cashflowSeries, avgMonthlyExpense: avgMonthlyExpense,
    emergencyMonths: emergencyMonths,
    budgetStatus: budgetStatus, spendByMember: spendByMember,
    recurringForMonth: recurringForMonth, txFromRecurring: txFromRecurring,
    loanBalance: loanBalance,
    validateTx: validateTx,
    parseCSV: parseCSV, parseAmount: parseAmount, importKey: importKey, mapRows: mapRows,
    dedupe: dedupe, toCSV: toCSV
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof window !== 'undefined' ? window : globalThis);
