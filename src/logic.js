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
        var skipped = (r.skipped || []).indexOf(m) >= 0;
        return { rec: r, key: key, done: !!done[key] || skipped, skipped: skipped, date: dateInMonth(m, r.dayOfMonth) };
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

  // ---------- PDF bank statements ----------
  // Text items from pdf.js ({str, x, y, w}) grouped into lines: same y (within tolerance), ordered by x.
  // Pages are read top to bottom (PDF y grows upwards, so higher y comes first).
  function linesFromItems(items, tol) {
    tol = tol || 2.5;
    var rows = [];
    (items || []).forEach(function (it) {
      var str = String(it.str || '');
      if (!str.trim()) return;
      var r = null;
      for (var i = 0; i < rows.length; i++) { if (Math.abs(rows[i].y - it.y) <= tol) { r = rows[i]; break; } }
      if (!r) { r = { y: it.y, items: [] }; rows.push(r); }
      r.items.push({ str: str, x: Number(it.x) || 0, w: Number(it.w) || 0 });
    });
    rows.sort(function (a, b) { return b.y - a.y; });
    return rows.map(function (r) {
      r.items.sort(function (a, b) { return a.x - b.x; });
      var out = '', end = null;
      r.items.forEach(function (it) {
        if (end !== null) {
          var gap = it.x - end;
          if (gap > 1 || /\s$/.test(out) || /^\s/.test(it.str)) out += ' ';
        }
        out += it.str;
        end = it.w ? it.x + it.w : it.x + it.str.length * 4;
      });
      return out.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
  }
  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    mac: 3, ogos: 8, ogo: 8, sep_: 9, okt: 10, dis: 12, jan_: 1 };
  function fullYear(y, fallback) {
    if (y == null || y === '') return fallback || null;
    y = Number(y);
    return y < 100 ? 2000 + y : y;
  }
  // Date at the start of a statement line. Returns { date, rest } or null.
  function leadingDate(line, year) {
    var m, s = String(line || '').trim();
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})\b\s*(.*)$/))) { var d0 = fmtDate(+m[1], +m[2], +m[3]); return d0 ? { date: d0, rest: m[4] } : null; }
    if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})\b\s*(.*)$/))) {
      var d1 = fmtDate(fullYear(m[3]), +m[2], +m[1]); return d1 ? { date: d1, rest: m[4] } : null;
    }
    if ((m = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,4})[\s\-]*(\d{4}|\d{2})?\b\s*(.*)$/))) {
      var mo = MONTHS[m[2].toLowerCase()];
      var y = fullYear(m[3], year);
      if (!mo || !y) return null;
      var d2 = fmtDate(y, mo, +m[1]); return d2 ? { date: d2, rest: m[4] } : null;
    }
    return null;
  }
  var MONEY_RE = /^\(?-?(?:RM|MYR|SGD|S\$|\$)?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?[-+]?$|^\(?-?\d+\.\d{2}\)?[-+]?$/i;
  var MARK_RE = /^(DR|CR|DB|D|C|-|\+)$/i;
  // Trailing money columns of a line: [{value, sign}] left to right, plus the text before them.
  function trailingMoney(rest) {
    var toks = String(rest || '').trim().split(/\s+/);
    var money = [], pendingMark = null;
    while (toks.length) {
      var t = toks[toks.length - 1];
      if (MARK_RE.test(t) && money.length === 0 && pendingMark === null) { pendingMark = t.toUpperCase(); toks.pop(); continue; }
      if (MARK_RE.test(t) && money.length > 0) { // marker between two money tokens belongs to the token before it
        toks.pop(); money[0].mark = t.toUpperCase(); continue;
      }
      if (!MONEY_RE.test(t)) break;
      toks.pop();
      var neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-$/.test(t);
      var pos = /\+$/.test(t);
      var val = parseFloat(t.replace(/[^0-9.]/g, ''));
      var item = { value: val, mark: pendingMark, neg: neg, pos: pos };
      pendingMark = null;
      money.unshift(item);
    }
    return { money: money, text: toks.join(' ').trim() };
  }
  function signFromMarks(item) {
    if (!item) return 0;
    if (item.neg) return -1;
    if (item.pos) return 1;
    if (item.mark === 'CR' || item.mark === 'C' || item.mark === '+') return 1;
    if (item.mark === 'DR' || item.mark === 'DB' || item.mark === 'D' || item.mark === '-') return -1;
    return 0;
  }
  var SKIP_RE = /^(date|tarikh|description|butiran|keterangan|page\s*\d|muka\s*surat|statement|penyata|account\s*(no|number)|no\.?\s*akaun|total|jumlah|opening|closing|balance|baki)\b/i;
  var OPEN_RE = /\b(b\/f|brought\s*forward|opening\s*balance|beginning\s*balance|baki\s*(awal|bawa|b\/f)|balance\s*forward)\b/i;
  var CLOSE_RE = /\b(c\/f|carried\s*forward|closing\s*balance|ending\s*balance|baki\s*(akhir|c\/f)|total)\b/i;
  function guessYear(lines) {
    for (var i = 0; i < (lines || []).length; i++) {
      var m = String(lines[i]).match(/\b(20\d{2})\b/);
      if (m) return Number(m[1]);
    }
    return Number(nowMonth().slice(0, 4));
  }
  /* Transactions from statement text lines. Each dated line with money columns becomes a row; the last column is
   * taken as the running balance when there are two or more, and the sign is confirmed from the balance change.
   * Rows whose sign could not be confirmed get sure=false (default: expense) so the user can flip them.
   * Returns rows in the same shape as mapRows: {date, month, desc, type, amount, signed, importKey, sure, balance}. */
  function parseStatement(lines, opts) {
    opts = opts || {};
    var year = opts.year || guessYear(lines);
    var ok = [], bad = [], prevBal = null, last = null, cont = 0;
    (lines || []).forEach(function (raw, idx) {
      var line = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!line) return;
      var ld = leadingDate(line, year);
      if (!ld) {
        if (last && cont < 2 && line.length <= 60 && !SKIP_RE.test(line) && trailingMoney(line).money.length === 0) {
          last.desc = (last.desc + ' ' + line).trim(); cont++;
          last.importKey = importKey(last.date, last.signed, last.desc);
        } else if (/\d\.\d{2}\b/.test(line) && !SKIP_RE.test(line)) bad.push({ line: idx + 1, raw: raw });
        return;
      }
      var rest = ld.rest;
      var again = leadingDate(rest, year); // posting date next to transaction date
      if (again) rest = again.rest;
      var tm = trailingMoney(rest);
      var text = tm.text;
      if (!tm.money.length) { last = null; return; }
      if (OPEN_RE.test(text)) { prevBal = tm.money[tm.money.length - 1].value; last = null; return; }
      if (CLOSE_RE.test(text) || SKIP_RE.test(text)) { last = null; return; }
      var amtItem, balance = null;
      if (tm.money.length >= 2) { amtItem = tm.money[tm.money.length - 2]; balance = tm.money[tm.money.length - 1].value; }
      else amtItem = tm.money[0];
      var amount = amtItem.value;
      if (!(amount > 0)) { bad.push({ line: idx + 1, raw: raw }); last = null; return; }
      var sign = signFromMarks(amtItem), sure = sign !== 0;
      if (!sure && balance != null && prevBal != null) {
        if (Math.abs((balance - prevBal) - amount) < 0.011) { sign = 1; sure = true; }
        else if (Math.abs((prevBal - balance) - amount) < 0.011) { sign = -1; sure = true; }
      }
      if (!sure && opts.hasDebitCredit === false) { /* nothing more to infer */ }
      if (sign === 0) sign = opts.defaultType === 'income' ? 1 : -1;
      if (balance != null) prevBal = balance;
      var signed = sign * amount;
      var desc = text || '（无描述）';
      last = { date: ld.date, month: ld.date.slice(0, 7), desc: desc, type: signed < 0 ? 'expense' : 'income',
        amount: amount, signed: signed, importKey: importKey(ld.date, signed, desc), sure: sure, balance: balance, line: idx + 1 };
      cont = 0;
      ok.push(last);
    });
    return { ok: ok, bad: bad, year: year };
  }
  // Flip one parsed row between expense and income (keeps importKey consistent).
  function flipRow(r) {
    var signed = -r.signed;
    return Object.assign({}, r, { signed: signed, type: signed < 0 ? 'expense' : 'income', sure: true, importKey: importKey(r.date, signed, r.desc) });
  }

  // ---------- loans: payment helpers ----------
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  // Interest for one month on `balance` at `annualRatePct` (flat monthly accrual, as banks show on statements).
  function estimateInterest(balance, annualRatePct) {
    var b = Number(balance), r = Number(annualRatePct);
    if (!(b > 0) || !(r > 0)) return 0;
    return round2(b * r / 100 / 12);
  }
  // Months until a reducing-balance loan is cleared with a fixed monthly payment. null when payment cannot cover interest.
  function monthsToPayoff(balance, annualRatePct, payment) {
    var b = Number(balance), r = (Number(annualRatePct) || 0) / 100 / 12, p = Number(payment);
    if (!(b > 0)) return 0;
    if (!(p > 0)) return null;
    if (r <= 0) return Math.ceil(b / p);
    if (p <= b * r) return null;
    return Math.ceil(Math.log(p / (p - b * r)) / Math.log(1 + r));
  }
  function totalInterestToPayoff(balance, annualRatePct, payment) {
    var n = monthsToPayoff(balance, annualRatePct, payment);
    if (n == null) return null;
    var b = Number(balance), r = (Number(annualRatePct) || 0) / 100 / 12, p = Number(payment), total = 0;
    for (var i = 0; i < n && b > 0; i++) { var it = round2(b * r); total += it; b = b + it - p; }
    return round2(total);
  }

  // ---------- reports ----------
  function monthExpenseByCategory(tx, m) {
    var out = {};
    (tx || []).forEach(function (t) {
      if (t.month !== m) return;
      if (t.type === 'expense') { var c = t.category || '未分类'; out[c] = (out[c] || 0) + (Number(t.amount) || 0); }
      else if (t.type === 'repayment' && Number(t.interest) > 0) out['贷款利息'] = (out['贷款利息'] || 0) + Number(t.interest);
    });
    return out;
  }
  // Category spend for month m with the previous month for comparison; sorted by amount desc.
  function categoryReport(tx, m) {
    var cur = monthExpenseByCategory(tx, m), prev = monthExpenseByCategory(tx, addMonths(m, -1));
    var total = 0; Object.keys(cur).forEach(function (k) { total += cur[k]; });
    return Object.keys(cur).map(function (k) {
      return { name: k, amount: cur[k], prev: prev[k] || 0, pct: total > 0 ? cur[k] / total : 0, delta: cur[k] - (prev[k] || 0) };
    }).sort(function (a, b) { return b.amount - a.amount; });
  }
  // Money in / out per account for month m (transfers count on both sides; repayments leave the paying account).
  function accountFlow(tx, m) {
    var out = {};
    function add(acc, inn, outt) { if (!acc) return; var o = out[acc] = out[acc] || { in: 0, out: 0, n: 0 }; o.in += inn; o.out += outt; o.n++; }
    (tx || []).forEach(function (t) {
      if (t.month !== m) return;
      var a = Number(t.amount) || 0;
      if (t.type === 'income') add(t.account, a, 0);
      else if (t.type === 'expense' || t.type === 'repayment') add(t.account, 0, a);
      else if (t.type === 'transfer') { add(t.account, 0, a); add(t.toAccount, a, 0); }
    });
    return out;
  }
  function yearSummary(tx, year) {
    var rows = [];
    for (var i = 1; i <= 12; i++) {
      var m = year + '-' + String(i).padStart(2, '0');
      var c = cashflow(tx, m);
      rows.push({ month: m, income: c.income, expense: c.expense, net: c.net, savingsRate: c.savingsRate });
    }
    var tot = rows.reduce(function (s, r) { s.income += r.income; s.expense += r.expense; return s; }, { income: 0, expense: 0 });
    tot.net = tot.income - tot.expense; tot.savingsRate = tot.income > 0 ? tot.net / tot.income : null;
    return { rows: rows, total: tot };
  }
  function topExpenses(tx, m, n) {
    return (tx || []).filter(function (t) { return t.month === m && t.type === 'expense'; })
      .sort(function (a, b) { return (Number(b.amount) || 0) - (Number(a.amount) || 0); }).slice(0, n || 5);
  }
  // Most used categories for a type (by count over the last 3 months, ties by recency).
  function frequentCategories(tx, type, n) {
    var cnt = {};
    (tx || []).forEach(function (t) { if (t.type === type && t.category) cnt[t.category] = (cnt[t.category] || 0) + 1; });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a] || a.localeCompare(b); }).slice(0, n || 6);
  }
  function recentNotes(tx, n) {
    var seen = {}, out = [];
    (tx || []).slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''); })
      .forEach(function (t) {
        var k = normalizeText(t.note);
        if (!k || seen[k]) return;
        seen[k] = true; out.push(t.note.trim());
      });
    return out.slice(0, n || 30);
  }
  // Points for a simple SVG line: [{x,y}] in 0..w / 0..h with padding, plus min/max for labels.
  function chartPoints(values, w, h, pad) {
    pad = pad || 6;
    var vs = values.map(Number);
    var min = Math.min.apply(null, vs), max = Math.max.apply(null, vs);
    if (!isFinite(min) || !isFinite(max)) return { points: [], min: 0, max: 0 };
    if (max === min) { max += 1; min -= 1; }
    var n = vs.length;
    return {
      min: min, max: max,
      points: vs.map(function (v, i) {
        return { x: n > 1 ? pad + (w - 2 * pad) * i / (n - 1) : w / 2, y: pad + (h - 2 * pad) * (1 - (v - min) / (max - min)) };
      })
    };
  }

  // ---------- estimates, budgets, goals, insights ----------
  // Cash/deposit account: last recorded balance plus the recorded flows after its asOf date (RM accounts only).
  function cashEstimate(acc, balances, tx, m) {
    if (!acc || acc.currency !== 'MYR' || acc.kind !== 'asset') return null;
    var v = latestBalance(balances, acc.id, m);
    if (!v) return null;
    var asOf = asOfOf(v), delta = 0, n = 0;
    (tx || []).forEach(function (t) {
      if (!(t.date > asOf) || t.month > m) return;
      var a = Number(t.amount) || 0;
      if (t.type === 'income' && t.account === acc.id) { delta += a; n++; }
      else if ((t.type === 'expense' || t.type === 'repayment') && t.account === acc.id) { delta -= a; n++; }
      else if (t.type === 'transfer') { if (t.account === acc.id) { delta -= a; n++; } if (t.toAccount === acc.id) { delta += a; n++; } }
    });
    return { base: v.amount, asOf: asOf, delta: round2(delta), n: n, estimate: round2(v.amount + delta) };
  }
  // Overall month budget: `overall` (when > 0) or the sum of category budgets. Daily allowance uses the days left in m.
  function budgetSummary(categories, tx, m, overall, today) {
    var sum = (categories || []).reduce(function (s, c) { return s + (c.type === 'expense' ? Number(c.budget) || 0 : 0); }, 0);
    var budget = Number(overall) > 0 ? Number(overall) : sum;
    var spent = cashflow(tx, m).expense;
    today = today || todayKuching();
    var dim = daysInMonth(m), day = today.slice(0, 7) === m ? Number(today.slice(8)) : (today.slice(0, 7) > m ? dim : 0);
    var daysLeft = Math.max(0, dim - day + (today.slice(0, 7) === m ? 1 : 0));
    var remaining = budget - spent;
    return { budget: budget, spent: spent, remaining: remaining, pct: budget > 0 ? spent / budget : null,
      daysLeft: daysLeft, daily: budget > 0 && daysLeft > 0 ? Math.max(0, remaining) / daysLeft : null,
      paceOk: budget > 0 ? spent <= budget * (dim - daysLeft) / dim + 1e-9 : null };
  }
  // Savings goal progress. current = linked account value (RM) or goal.saved. Months left to goal.targetMonth.
  function goalProgress(goal, accounts, balances, rates, m) {
    var current = Number(goal.saved) || 0;
    if (goal.accountId && accounts[goal.accountId]) {
      var r = accountValues({ a: accounts[goal.accountId] }, balances, rates, m)[0];
      if (r && r.rm != null) current = r.rm;
    }
    var target = Number(goal.target) || 0;
    var pct = target > 0 ? Math.min(1, current / target) : 0;
    var monthsLeft = null, perMonth = null;
    if (goal.targetMonth) {
      var p1 = m.split('-').map(Number), p2 = goal.targetMonth.split('-').map(Number);
      monthsLeft = Math.max(0, (p2[0] - p1[0]) * 12 + (p2[1] - p1[1]));
      perMonth = monthsLeft > 0 ? Math.max(0, target - current) / monthsLeft : null;
    }
    return { current: current, target: target, pct: pct, remaining: Math.max(0, target - current), monthsLeft: monthsLeft, perMonth: perMonth, done: target > 0 && current >= target };
  }
  // Plain-language observations about month m compared with the month before.
  function insights(tx, m) {
    var out = [];
    var cur = cashflow(tx, m), prev = cashflow(tx, addMonths(m, -1));
    if (prev.expense > 0 && cur.expense > 0) {
      var ch = (cur.expense - prev.expense) / prev.expense;
      if (Math.abs(ch) >= 0.05) out.push({ kind: ch > 0 ? 'warn' : 'ok', text: '本月支出比上月' + (ch > 0 ? '多 ' : '少 ') + Math.abs(ch * 100).toFixed(0) + '%（' + (ch > 0 ? '+' : '-') + Math.abs(cur.expense - prev.expense).toFixed(2) + '）' });
    }
    var rep = categoryReport(tx, m);
    var up = rep.filter(function (r) { return r.prev > 0 && r.delta / r.prev >= 0.3 && r.delta >= 50; }).sort(function (a, b) { return b.delta - a.delta; })[0];
    if (up) out.push({ kind: 'warn', text: '「' + up.name + '」比上月多花 ' + up.delta.toFixed(2) + '（+' + (up.delta / up.prev * 100).toFixed(0) + '%）' });
    var down = rep.filter(function (r) { return r.prev > 0 && -r.delta / r.prev >= 0.3 && -r.delta >= 50; }).sort(function (a, b) { return a.delta - b.delta; })[0];
    if (down) out.push({ kind: 'ok', text: '「' + down.name + '」比上月少花 ' + (-down.delta).toFixed(2) });
    if (cur.savingsRate != null) out.push({ kind: cur.savingsRate >= 0.2 ? 'ok' : 'warn', text: '本月储蓄率 ' + (cur.savingsRate * 100).toFixed(0) + '%' + (cur.savingsRate >= 0.2 ? '，不错' : '，低于 20% 的建议线') });
    if (rep.length) out.push({ kind: 'info', text: '花得最多的是「' + rep[0].name + '」，占支出 ' + (rep[0].pct * 100).toFixed(0) + '%' });
    return out;
  }
  // Possible duplicate of a manual entry: same type, amount, date and category/account already recorded.
  function findSimilar(tx, cand, excludeId) {
    return (tx || []).filter(function (t) {
      return t.id !== excludeId && t.type === cand.type && t.date === cand.date && Math.abs((Number(t.amount) || 0) - (Number(cand.amount) || 0)) < 0.005 &&
        (t.category || '') === (cand.category || '') && (t.account || null) === (cand.account || null);
    });
  }

  // ---------- amount expressions, amortization ----------
  // "12+8.5*2" -> 29 ; only digits . + - * / ( ) are accepted. Returns NaN for anything else.
  function evalAmount(str) {
    var src = String(str == null ? '' : str).replace(/,/g, '').replace(/\s+/g, '');
    if (src === '' || !/^[\d.+\-*/()]+$/.test(src)) return NaN;
    var i = 0;
    function num() {
      var m = src.slice(i).match(/^\d*\.?\d+/); if (!m) return NaN;
      i += m[0].length; return parseFloat(m[0]);
    }
    function factor() {
      if (src[i] === '(') { i++; var v = expr(); if (src[i] !== ')') return NaN; i++; return v; }
      if (src[i] === '-') { i++; return -factor(); }
      if (src[i] === '+') { i++; return factor(); }
      return num();
    }
    function term() {
      var v = factor();
      while (src[i] === '*' || src[i] === '/') { var op = src[i++], r = factor(); v = op === '*' ? v * r : v / r; }
      return v;
    }
    function expr() {
      var v = term();
      while (src[i] === '+' || src[i] === '-') { var op = src[i++], r = term(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    var out = expr();
    return i === src.length && isFinite(out) ? round2(out) : NaN;
  }
  // Month-by-month schedule for a reducing-balance loan (first row = next payment). Stops at payoff or maxRows.
  function amortization(balance, annualRatePct, payment, maxRows, startMonth) {
    var rows = [], b = Number(balance), r = (Number(annualRatePct) || 0) / 100 / 12, p = Number(payment);
    if (!(b > 0) || !(p > 0)) return rows;
    for (var n = 1; n <= (maxRows || 12) && b > 0.005; n++) {
      var it = round2(b * r), pr = Math.min(b, round2(p - it));
      if (pr <= 0) break;
      b = round2(b - pr);
      rows.push({ n: n, month: startMonth ? addMonths(startMonth, n) : null, interest: it, principal: pr, payment: round2(it + pr), balance: b });
    }
    return rows;
  }

  // ---------- calendar / weeks / auto-post ----------
  function dayTotals(tx, m) {
    var out = {};
    (tx || []).forEach(function (t) {
      if (t.month !== m || !t.date) return;
      var o = out[t.date] = out[t.date] || { expense: 0, income: 0, n: 0 };
      var a = Number(t.amount) || 0;
      if (t.type === 'expense') o.expense += a;
      else if (t.type === 'repayment') o.expense += Number(t.interest) || 0;
      else if (t.type === 'income') o.income += a;
      o.n++;
    });
    return out;
  }
  // Weeks (Monday first) covering month m: [[date|null x7], ...]
  function calendarGrid(m) {
    var dim = daysInMonth(m), p = m.split('-').map(Number);
    var first = new Date(Date.UTC(p[0], p[1] - 1, 1)).getUTCDay(); // 0 = Sunday
    var lead = (first + 6) % 7, cells = [], weeks = [];
    for (var i = 0; i < lead; i++) cells.push(null);
    for (var d = 1; d <= dim; d++) cells.push(m + '-' + String(d).padStart(2, '0'));
    while (cells.length % 7) cells.push(null);
    for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    return weeks;
  }
  function weekSummary(tx, m) {
    var dt = dayTotals(tx, m);
    return calendarGrid(m).map(function (w) {
      var days = w.filter(Boolean), s = { start: days[0], end: days[days.length - 1], expense: 0, income: 0, n: 0 };
      days.forEach(function (d) { var o = dt[d]; if (o) { s.expense += o.expense; s.income += o.income; s.n += o.n; } });
      return s;
    });
  }
  // Recurring items flagged autoPost whose date in the current month has arrived and are not yet recorded.
  function dueAutoPost(recurring, tx, today) {
    var m = today.slice(0, 7);
    return recurringForMonth((recurring || []).filter(function (r) { return r.autoPost === true; }), tx, m)
      .filter(function (it) { return !it.done && it.date <= today; });
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
    dedupe: dedupe, toCSV: toCSV,
    linesFromItems: linesFromItems, leadingDate: leadingDate, trailingMoney: trailingMoney, guessYear: guessYear,
    parseStatement: parseStatement, flipRow: flipRow,
    round2: round2, estimateInterest: estimateInterest, monthsToPayoff: monthsToPayoff, totalInterestToPayoff: totalInterestToPayoff,
    monthExpenseByCategory: monthExpenseByCategory, categoryReport: categoryReport, accountFlow: accountFlow, yearSummary: yearSummary,
    topExpenses: topExpenses, frequentCategories: frequentCategories, recentNotes: recentNotes, chartPoints: chartPoints,
    cashEstimate: cashEstimate, budgetSummary: budgetSummary, goalProgress: goalProgress, insights: insights, findSimilar: findSimilar,
    evalAmount: evalAmount, amortization: amortization,
    dayTotals: dayTotals, calendarGrid: calendarGrid, weekSummary: weekSummary, dueAutoPost: dueAutoPost
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof window !== 'undefined' ? window : globalThis);
