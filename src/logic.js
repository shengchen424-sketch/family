/* Family assets & expenses — pure calculation logic (no DOM, no storage).
 * Used by the page in the browser and by node tests.
 * Money is in RM unless a function says otherwise. Months are 'YYYY-MM'. Dates are 'YYYY-MM-DD'.
 */
(function (root) {
  'use strict';

  var DEFAULT_RATE = 3.1953;
  var LIQUID = ['现金与定存', '电子钱包'];
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
        if (LIQUID.indexOf(c) >= 0) t.liquid += r.rm;
      } else {
        t.liabs += r.rm;
      }
    });
    t.net = t.assets - t.liabs;
    t.ratio = t.assets > 0 ? t.liabs / t.assets : null;
    return t;
  }
  function familyTotals(accounts, balances, rates, m) { return groupTotals(accounts, balances, rates, m, 'family'); }
  // Investable net worth: family assets minus liabilities, excluding the home and vehicles (they produce no income).
  var NON_PRODUCTIVE = ['房产', '车辆'];
  function investableNet(accounts, balances, rates, m) {
    return accountValues(accounts, balances, rates, m).reduce(function (s, r) {
      if (r.acc.group !== 'family' || r.status === 'missing' || NON_PRODUCTIVE.indexOf(r.acc.category || '') >= 0) return s;
      return s + (r.acc.kind === 'asset' ? r.rm : -r.rm);
    }, 0);
  }
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
    if (r.type === 'transfer') t.toAccount = r.toAccount || null;
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
    if (!acc || acc.currency !== 'MYR' || acc.kind !== 'asset' || LIQUID.indexOf(acc.category) < 0) return null;
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
    if (goal.kind === 'networth') current = familyTotals(accounts, balances, rates, m).net;
    else if (goal.kind === 'investable') current = investableNet(accounts, balances, rates, m);
    else if (goal.accountId && accounts[goal.accountId]) {
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
  function insights(tx, m, opts) {
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
    (budgetStatus(opts && opts.categories, tx, m) || []).forEach(function (b) {
      if (b.over) out.push({ kind: 'warn', text: '「' + b.name + '」已超预算 ' + (b.spent - b.budget).toFixed(2) });
      else if (b.pct >= 0.8) out.push({ kind: 'warn', text: '「' + b.name + '」预算已用 ' + (b.pct * 100).toFixed(0) + '%' });
    });
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

  // ---------- data health check ----------
  // Problems a family book accumulates over time: references to missing accounts/categories, stale balances, etc.
  function healthCheck(d) {
    var out = [], accounts = d.accounts || {}, cats = {}, m = d.month || nowMonth();
    (d.categories || []).forEach(function (c) { cats[c.name] = c; });
    var txs = d.tx || [], badAcc = 0, badCat = 0, badLoan = 0, noMember = 0;
    txs.forEach(function (t) {
      if (t.account && !accounts[t.account]) badAcc++;
      if (t.toAccount && !accounts[t.toAccount]) badAcc++;
      if ((t.type === 'income' || t.type === 'expense') && t.category && !cats[t.category]) badCat++;
      if (t.type === 'repayment' && t.loanId && !accounts[t.loanId]) badLoan++;
      if (!t.member) noMember++;
    });
    if (badAcc) out.push({ level: 'warn', text: badAcc + ' 笔流水指向不存在的账户' });
    if (badCat) out.push({ level: 'warn', text: badCat + ' 笔流水的分类已不存在（在分类里重新建同名分类即可恢复统计）' });
    if (badLoan) out.push({ level: 'warn', text: badLoan + ' 笔还款指向不存在的贷款' });
    if (noMember) out.push({ level: 'info', text: noMember + ' 笔流水没有归属成员' });
    (d.recurring || []).forEach(function (r) {
      if (r.active === false) return;
      if (r.account && !accounts[r.account]) out.push({ level: 'warn', text: '定期项目「' + r.name + '」的账户不存在' });
      if (r.type === 'repayment' && (!r.loanId || !accounts[r.loanId])) out.push({ level: 'warn', text: '定期项目「' + r.name + '」没有有效的贷款' });
      if (r.type !== 'repayment' && r.category && !cats[r.category]) out.push({ level: 'warn', text: '定期项目「' + r.name + '」的分类不存在' });
    });
    (d.goals || []).forEach(function (g) { if (g.accountId && !accounts[g.accountId]) out.push({ level: 'warn', text: '目标「' + g.name + '」关联的账户不存在' }); });
    var stale = 0, inactiveWithBal = 0;
    activeAccounts(accounts).forEach(function (a) {
      var v = valueAt(d.balances || {}, a.id, m);
      if (v.status === 'carried' && addMonths(v.b.month, 3) <= m) stale++;
    });
    if (stale) out.push({ level: 'info', text: stale + ' 个账户的余额已超过 3 个月没更新' });
    Object.keys(accounts).forEach(function (id) {
      var a = accounts[id];
      if (a.active === false && a.kind === 'liability') {
        var lb = latestBalance(d.balances || {}, id, m);
        if (lb && lb.amount > 0) inactiveWithBal++;
      }
    });
    if (inactiveWithBal) out.push({ level: 'info', text: inactiveWithBal + ' 个已停用的负债账户仍有余额记录（停用的账户不计入总额）' });
    var dupKeys = {}, dups = 0;
    txs.forEach(function (t) { if (t.importKey) { if (dupKeys[t.importKey]) dups++; dupKeys[t.importKey] = true; } });
    if (dups) out.push({ level: 'warn', text: dups + ' 笔导入的流水疑似重复（相同日期、金额、描述）' });
    if (!out.length) out.push({ level: 'ok', text: '没有发现问题' });
    return out;
  }

  // ---------- first-run setup (onboarding) ----------
  // Every kind of asset / liability a Malaysian or Singaporean family is likely to hold, with how to value it.
  var SETUP_TYPES = [
    { key: 'cash', kind: 'asset', group: 'family', category: '现金与定存', label: '现金与银行户口', hint: '手上现金、储蓄/往来户口按银行 App 显示的当前余额填；定存填本金。', ph: 'Maybank 储蓄、Public Bank 定存、手上现金' },
    { key: 'ewallet', kind: 'asset', group: 'family', category: '电子钱包', label: '电子钱包', hint: 'TNG eWallet、GrabPay、Boost、ShopeePay 等的余额。', ph: 'TNG eWallet' },
    { key: 'epf', kind: 'asset', group: 'family', category: '退休金', label: '退休金', hint: 'EPF/KWSP 看 i-Akaun 的总额（第一、二户口加起来），PRS、新加坡 CPF 同理。每人一条。', ph: 'EPF（爸爸）、EPF（妈妈）' },
    { key: 'invest', kind: 'asset', group: 'family', category: '投资', label: '股票、基金与投资账户', hint: '券商账户（MooMoo、Rakuten、M+）按当前市值；ASNB、Tabung Haji、单位信托按 App 余额；机器人投顾（StashAway、Mytheo）按当前价值。', ph: 'MooMoo、ASNB、StashAway' },
    { key: 'crypto', kind: 'asset', group: 'family', category: '投资', label: '加密货币', hint: 'Luno、Binance 等按现在的市值（App 首页显示的总额）。', ph: 'Luno' },
    { key: 'gold', kind: 'asset', group: 'family', category: '投资', label: '黄金白银', hint: '实物按当前金价 × 克数；黄金户口（Maybank Gold、HelloGold）按 App 余额。', ph: '金条、黄金户口' },
    { key: 'insurance', kind: 'asset', group: 'family', category: '保险', label: '保险现金价值', hint: '只填有现金价值的保单（储蓄险、投资连结险），看年度保单报表上的 cash value / surrender value。纯医药卡和定期寿险没有现金价值，不用填。', ph: '储蓄险（爸爸）、投资连结险（妈妈）' },
    { key: 'property', kind: 'asset', group: 'family', category: '房产', label: '房产', hint: '自住或出租的房子按市值：参考附近同类型最近成交价、银行估值或 PropertyGuru/iProperty 挂牌价打九折。房贷另外填在负债。', ph: '自住的房子、出租的公寓' },
    { key: 'vehicle', kind: 'asset', group: 'family', category: '车辆', label: '车辆', hint: '车、摩托按二手行情：到 mudah.my、carlist.my 找同款同年份的挂牌价取中间值。车贷另外填在负债。', ph: 'Mazda CX-5 2018' },
    { key: 'lend', kind: 'asset', group: 'family', category: '其他资产', label: '借给别人的钱', hint: '预计真的能收回的金额，收不回的就不要算。', ph: '借给弟弟' },
    { key: 'bizcash', kind: 'asset', group: 'business', category: '企业现金', label: '生意的户口', hint: '公司或个体生意的银行户口。单独显示，不计入家庭净资产；从生意提款到家里时记一笔"农场提款"收入。', ph: '公司的 Maybank 户口' },
    { key: 'mortgage', kind: 'liability', group: 'family', category: '房贷', label: '房贷', hint: '填银行 App 显示的 outstanding balance（剩余本金）。顺便填月供和年利率，以后记还款会自动算利息。', ph: '自住房的房贷', loan: true },
    { key: 'carloan', kind: 'liability', group: 'family', category: '车贷', label: '车贷', hint: 'Hire purchase 看 statement 上的 balance；不确定的话用 剩余期数 × 月供 粗估。', ph: '车贷（Hilux）', loan: true },
    { key: 'personal', kind: 'liability', group: 'family', category: '个人贷款', label: '个人贷款', hint: '银行或合作社贷款的剩余本金。', ph: 'Personal loan', loan: true },
    { key: 'card', kind: 'liability', group: 'family', category: '信用卡', label: '信用卡欠款', hint: '当前账单还没还的金额。每月全额还清的可以填 0。', ph: 'Maybank Visa' },
    { key: 'study', kind: 'liability', group: 'family', category: '学贷', label: '学贷', hint: 'PTPTN 等的剩余欠款，看 App 或年度 statement。', ph: 'PTPTN', loan: true },
    { key: 'bnpl', kind: 'liability', group: 'family', category: '其他负债', label: '先买后付 / 分期', hint: 'Atome、SPayLater、手机分期等剩下还没付的总额。', ph: 'Atome' },
    { key: 'borrow', kind: 'liability', group: 'family', category: '其他负债', label: '向别人借的钱', hint: '欠亲友的钱，按还没还的金额。', ph: '欠爸妈' },
    { key: 'bizdebt', kind: 'liability', group: 'business', category: '企业透支', label: '生意的透支或贷款', hint: '生意户口的 overdraft 或商业贷款余额，单独计算。', ph: '公司的 OD 户口' }
  ];
  var SETUP_CATEGORIES = [
    ['饮食', 'expense'], ['日用', 'expense'], ['交通与油费', 'expense'], ['孩子', 'expense'], ['水电网', 'expense'], ['房屋', 'expense'],
    ['车辆', 'expense'], ['保险', 'expense'], ['医疗', 'expense'], ['娱乐', 'expense'], ['人情', 'expense'], ['其他支出', 'expense'],
    ['工资', 'income'], ['生意提款', 'income'], ['投资收益', 'income'], ['其他收入', 'income']
  ];
  // Turns the wizard answers into documents. answers = { members:[names], items:{typeKey:[{name,amount,currency,rate,pay}]},
  // incomes:[{name,amount,day,accountIdx}], budget, month, today }. Returns { accounts:{id:doc}, balances:{id:doc}, members:{}, ... }.
  function buildSetup(answers) {
    var m = answers.month, today = answers.today || (m + '-01'), out = { accounts: {}, balances: {}, members: {}, categories: {}, recurring: {}, settings: {}, errors: [] };
    var sort = 0, cashIds = [];
    (answers.members || []).map(function (x) { return String(x || '').trim(); }).filter(Boolean).forEach(function (name, i) {
      var id = name.replace(/[^\w一-龥-]/g, '') || ('m' + (i + 1));
      out.members[id] = { name: name, sort: i + 1 };
    });
    SETUP_TYPES.forEach(function (tp) {
      ((answers.items || {})[tp.key] || []).forEach(function (row) {
        var name = String(row.name || '').trim(), amt = evalAmount(row.amount);
        if (!name && !isFinite(amt)) return;
        if (!name) { out.errors.push(tp.label + '：有一行没有名称'); return; }
        if (!isFinite(amt) || amt < 0) { out.errors.push(tp.label + '「' + name + '」的金额不正确'); return; }
        var id = 'a-' + tp.key + '-' + (++sort) + '-' + Math.random().toString(36).slice(2, 6);
        var acc = { name: name, kind: tp.kind, group: tp.group, category: tp.category, currency: row.currency === 'SGD' ? 'SGD' : 'MYR', sort: sort, active: true };
        if (tp.loan) {
          var r = Number(row.rate), p = evalAmount(row.pay);
          if (r > 0) acc.rate = r;
          if (p > 0) acc.monthlyPayment = p;
        }
        out.accounts[id] = acc;
        out.balances[m + '__' + id] = { month: m, asOf: today, accountId: id, amount: round2(amt), currency: acc.currency, note: '新手设置' };
        if (tp.key === 'cash' || tp.key === 'ewallet') cashIds.push(id);
      });
    });
    SETUP_CATEGORIES.forEach(function (c, i) { out.categories['c-' + (i + 1)] = { name: c[0], type: c[1], budget: 0, sort: i + 1 }; });
    (answers.incomes || []).forEach(function (inc, i) {
      var name = String(inc.name || '').trim(), amt = evalAmount(inc.amount);
      if (!name || !(amt > 0)) return;
      out.recurring['r-income-' + (i + 1)] = { name: name, type: 'income', amount: round2(amt), dayOfMonth: Math.min(31, Math.max(1, Number(inc.day) || 1)),
        category: '工资', account: cashIds[Number(inc.accountIdx) || 0] || cashIds[0] || null, member: 'shared', startMonth: m, endMonth: null, active: true, autoPost: !!inc.auto, skipped: [] };
    });
    var budget = evalAmount(answers.budget);
    out.settings.prefs = { monthlyBudget: budget > 0 ? budget : 0, emergencyMonths: 6 };
    out.settings.onboarding = { done: true, at: today };
    return out;
  }

  // ---------- planning tools ----------
  var RECURRING_TEMPLATES = [
    { name: '房贷', type: 'repayment', category: '', day: 1 }, { name: '车贷', type: 'repayment', category: '', day: 5 },
    { name: '人寿保费', type: 'expense', category: '保险', day: 10 }, { name: '医药卡保费', type: 'expense', category: '保险', day: 10 },
    { name: '车险', type: 'expense', category: '车辆', day: 1, yearly: true }, { name: '路税', type: 'expense', category: '车辆', day: 1, yearly: true },
    { name: '水费', type: 'expense', category: '水电网', day: 15 }, { name: '电费', type: 'expense', category: '水电网', day: 15 },
    { name: '网络（Unifi）', type: 'expense', category: '水电网', day: 20 }, { name: '手机话费', type: 'expense', category: '水电网', day: 20 },
    { name: 'Netflix / 订阅', type: 'expense', category: '娱乐', day: 25 }, { name: '学费 / 托儿', type: 'expense', category: '孩子', day: 1 },
    { name: '管理费 / 门牌税', type: 'expense', category: '房屋', day: 1 }, { name: '给父母家用', type: 'expense', category: '人情', day: 1 },
    { name: '工资', type: 'income', category: '工资', day: 28 }, { name: '生意提款', type: 'income', category: '生意提款', day: 1 }, { name: '租金收入', type: 'income', category: '其他收入', day: 5 }
  ];
  // Credit card cycle: statement day → due day (dueDay may fall in the next month). spent = charges since the last statement.
  function cardCycle(acc, tx, today) {
    var sd = Number(acc.statementDay) || 0, dd = Number(acc.dueDay) || 0;
    if (!sd) return null;
    var m = today.slice(0, 7), day = Number(today.slice(8));
    var lastStmt = day > sd ? dateInMonth(m, sd) : dateInMonth(addMonths(m, -1), sd);
    var nextStmt = day > sd ? dateInMonth(addMonths(m, 1), sd) : dateInMonth(m, sd);
    var due = null;
    if (dd) { due = dd > sd ? dateInMonth(lastStmt.slice(0, 7), dd) : dateInMonth(addMonths(lastStmt.slice(0, 7), 1), dd); }
    var spent = 0;
    (tx || []).forEach(function (t) { if (t.account === acc.id && t.type === 'expense' && t.date > lastStmt && t.date <= today) spent += Number(t.amount) || 0; });
    var daysToDue = due ? Math.round((Date.parse(due) - Date.parse(today)) / 864e5) : null;
    return { lastStatement: lastStmt, nextStatement: nextStmt, due: due, daysToDue: daysToDue, spent: round2(spent), overdue: daysToDue != null && daysToDue < 0 };
  }
  // Net-worth goal: months to reach target at the average monthly change over the available trend.
  function netWorthForecast(trend, target) {
    if (!trend || trend.length < 2) return { rate: null, months: null, when: null };
    var first = trend[0], last = trend[trend.length - 1];
    var span = Math.max(1, (Number(last.month.slice(0, 4)) - Number(first.month.slice(0, 4))) * 12 + (Number(last.month.slice(5)) - Number(first.month.slice(5))));
    var rate = (last.net - first.net) / span;
    if (!(target > last.net)) return { rate: rate, months: 0, when: last.month };
    if (!(rate > 0)) return { rate: rate, months: null, when: null };
    var months = Math.ceil((target - last.net) / rate);
    return { rate: round2(rate), months: months, when: addMonths(last.month, months) };
  }
  // Category remembered from earlier entries with the same note (most recent wins).
  function categoryForNote(tx, note, type) {
    var k = normalizeText(note);
    if (!k) return '';
    var best = null;
    (tx || []).forEach(function (t) {
      if (t.type !== type || !t.category) return;
      var n = normalizeText(t.note);
      if (n !== k && !(n && k.indexOf(n) === 0 && n.length >= 3)) return;
      if (!best || (t.date || '') > (best.date || '')) best = t;
    });
    return best ? best.category : '';
  }
  function memberCategoryMatrix(tx, m) {
    var rows = {}, cats = {};
    (tx || []).forEach(function (t) {
      if (t.month !== m || t.type !== 'expense') return;
      var mem = t.member || '未指定', c = t.category || '未分类';
      rows[mem] = rows[mem] || {}; rows[mem][c] = (rows[mem][c] || 0) + (Number(t.amount) || 0); cats[c] = (cats[c] || 0) + (Number(t.amount) || 0);
    });
    var catList = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; });
    return { members: Object.keys(rows), categories: catList, cell: function (mem, c) { return (rows[mem] || {})[c] || 0; }, total: function (mem) { return catList.reduce(function (s, c) { return s + ((rows[mem] || {})[c] || 0); }, 0); } };
  }
  // Cash-flow projection: liquid cash today, then each month + recurring income − recurring expense − average other spending.
  function cashflowForecast(liquid, recurring, tx, m, n) {
    var out = [], bal = Number(liquid) || 0;
    var recMonthly = (recurring || []).filter(function (r) { return r.active !== false; });
    var avgAll = avgMonthlyExpense(tx, m, 3);
    var recExpAvg = recMonthly.reduce(function (s, r) { return s + (r.type === 'expense' ? Number(r.amount) || 0 : r.type === 'repayment' ? Number(r.interest) || 0 : 0); }, 0);
    var other = Math.max(0, avgAll - recExpAvg);
    for (var i = 1; i <= (n || 3); i++) {
      var mm = addMonths(m, i), inc = 0, exp = 0;
      recMonthly.forEach(function (r) {
        if ((r.startMonth && r.startMonth > mm) || (r.endMonth && r.endMonth < mm)) return;
        if (r.type === 'income') inc += Number(r.amount) || 0;
        else exp += Number(r.amount) || 0; // repayments leave cash in full
      });
      bal = round2(bal + inc - exp - other);
      out.push({ month: mm, income: round2(inc), fixed: round2(exp), other: round2(other), balance: bal });
    }
    return out;
  }
  // Financial independence: FI number = yearly expense × 25; years to reach it with monthly saving at a return rate.
  function fiCalc(opts) {
    var annual = (Number(opts.monthlyExpense) || 0) * 12, target = annual * (Number(opts.multiple) || 25);
    var net = Number(opts.investable) || 0, save = Number(opts.monthlySaving) || 0, r = (Number(opts.returnPct) || 0) / 100 / 12;
    if (target <= 0) return { target: 0, years: null, pct: null };
    if (net >= target) return { target: target, years: 0, pct: 1 };
    var months = 0, b = net;
    while (b < target && months < 1200) { b = b * (1 + r) + save; months++; }
    return { target: round2(target), years: months >= 1200 ? null : round2(months / 12), pct: Math.min(1, net / target), monthlyPassive: round2(target * 0.04 / 12) };
  }
  // Extra monthly repayment: months and interest saved.
  function prepaySim(balance, ratePct, payment, extra) {
    var base = monthsToPayoff(balance, ratePct, payment), baseInt = totalInterestToPayoff(balance, ratePct, payment);
    var np = Number(payment) + Number(extra || 0);
    var alt = monthsToPayoff(balance, ratePct, np), altInt = totalInterestToPayoff(balance, ratePct, np);
    if (base == null || alt == null) return null;
    return { months: alt, monthsSaved: base - alt, interestSaved: round2(baseInt - altInt), interest: altInt };
  }
  // Life cover rule of thumb: 10× annual income + debts − liquid assets.
  function coverCheck(opts) {
    var need = round2(Math.max(0, (Number(opts.annualIncome) || 0) * 10 + (Number(opts.debts) || 0) - (Number(opts.liquid) || 0)));
    var have = Number(opts.cover) || 0;
    return { need: need, have: have, gap: round2(Math.max(0, need - have)), ok: have >= need };
  }
  // Malaysian household spending shares (DOSM HES 2022, rounded) for a rough comparison.
  var MY_HOUSEHOLD_SHARES = [['饮食', 17], ['房屋', 23], ['水电网', 4], ['交通与油费', 13], ['娱乐', 5], ['医疗', 2], ['孩子', 3], ['保险', 4], ['日用', 6], ['其他支出', 23]];
  function compareShares(report) {
    var total = (report || []).reduce(function (s, r) { return s + r.amount; }, 0);
    return MY_HOUSEHOLD_SHARES.map(function (x) {
      var r = (report || []).filter(function (q) { return q.name === x[0]; })[0];
      var mine = total > 0 && r ? r.amount / total * 100 : 0;
      return { name: x[0], mine: round2(mine), ref: x[1], diff: round2(mine - x[1]) };
    });
  }
  // "Giant 买菜 85 块 3 毛" -> { amount: 85.3, note: 'Giant 买菜' } for voice / free-text entry.
  function parseSpeech(text) {
    var t = String(text || '').replace(/[，,]/g, ' ').trim();
    var amount = NaN, m = t.match(/(\d+(?:\.\d+)?)\s*(?:块|元|令吉|ringgit|rm)?\s*(\d+)\s*(?:毛|角)/i);
    if (m) amount = Number(m[1]) + Number(m[2]) / 10;
    else { var ms = t.match(/\d+(?:\.\d+)?/g); if (ms) amount = Number(ms[ms.length - 1]); }
    var note = t.replace(/(?:rm|ringgit)?\s*\d+(?:\.\d+)?\s*(?:块|元|令吉|ringgit|rm)?\s*(?:\d+\s*(?:毛|角))?/ig, ' ').replace(/\s+/g, ' ').trim();
    return { amount: isFinite(amount) ? round2(amount) : NaN, note: note };
  }

  // ---------- receipt OCR text → amount / date / merchant / category (rules, no AI service) ----------
  var MERCHANT_WORDS = [
    ['饮食', 'giant|tesco|lotus|lotuss|everrise|mydin|econsave|aeon|jaya grocer|village grocer|99 speedmart|speedmart|speed mart|ck mart|emart|farley|ta kiong|unaco|supermarket|hypermarket|pasar|mamak|restoran|restaurant|cafe|kopitiam|bakery|kfc|mcdonald|mcd|pizza|domino|dominos|starbucks|zus|tealive|chatime|sushi|nasi|mee|kopi|food|bistro|dim sum|hawker|coffee|cafe|bak kut teh|laksa|kolo'],
    ['水电网', 'tnb|tenaga nasional|sarawak energy|sesco|kuching water|laku|indah water|unifi|telekom|maxis|celcom|celcomdigi|digi|u mobile|yes 4g|astro|netflix|spotify|youtube premium|icloud|google one|time dotcom|streamyx|internet|broadband|electric|elektrik|water bill|bil air'],
    ['交通与油费', 'petronas|shell|petron|caltex|bhp|grab|touch n go|touchngo|tng|toll|plus|parking|parkir|car park|carpark|lrt|mrt|ktm|rapidkl|rapid|bus|airasia|malaysia airlines|flight|taxi|e-hailing|ron95|ron97|diesel|petrol|fuel|minyak'],
    ['日用', 'mr diy|mr d i y|mrdiy|watsons|guardian|daiso|eco shop|ecoshop|ikea|homepro|hardware|pharmacy|farmasi|caring|alpro|big pharmacy|shopee|lazada|taobao|temu|uniqlo|padini|h&m|brands outlet|toiletries|detergent'],
    ['医疗', 'clinic|klinik|hospital|medical|dental|dentist|poliklinik|specialist|optical|optometrist|doctor|dr\\.'],
    ['孩子', 'tadika|kindergarten|school|sekolah|tuition|tuisyen|nursery|toys|mothercare|kiddy|anakku|pampers|huggies|enfagrow|similac|dutch lady|childcare|diaper'],
    ['车辆', 'service centre|servis|workshop|bengkel|tyre|tayar|battery|myeg|jpj|road tax|roadtax|insurans|insurance|takaful|puspakom|car wash|cuci kereta|toyota|mazda|perodua|proton|honda|engine oil'],
    ['房屋', 'majlis|mbks|dbku|cukai|assessment|quit rent|management fee|maintenance|sinking fund|renovation|plumber|electrician|courts|senheng|harvey norman|furniture'],
    ['娱乐', 'cinema|gsc|tgv|mbo|karaoke|ktv|bowling|arcade|steam|playstation|nintendo|concert|ticket|movie'],
    ['保险', 'aia|prudential|great eastern|allianz|etiqa|manulife|zurich|tokio marine|premium|premi'],
    ['人情', 'angpow|ang pao|wedding|gift|hadiah|donation|derma|temple|church|masjid|sedekah']
  ];
  var MERCHANT_RULES = MERCHANT_WORDS.map(function (x) {
    return { cat: x[0], re: new RegExp('(?:^|[^a-z0-9])(' + x[1].split('|').map(function (w) { return w.replace(/[.*+?^${}()[\]\\]/g, function (c) { return c === '.' ? '\\.' : '\\' + c; }).replace(/ /g, '\\s*'); }).join('|') + ')(?![a-z0-9])', 'i') };
  });
  var MONEY_LINE = /(?:rm|myr|\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})\s*$/i;
  var TOTAL_RE = /(grand\s*total|total\s*(amount|due|payable|sales|incl|inclusive|\(?rm\)?)?|jumlah\s*(besar|bayaran|keseluruhan)?|amount\s*(due|payable)|net\s*total|nett|amt\s*due|to\s*pay)/i;
  var NOT_TOTAL_RE = /(sub\s*-?\s*total|subtotal|change|baki|balance|tender|cash|card|visa|master|debit|credit|saving|discount|diskaun|rounding|sst|gst|tax|cukai|point|mata|earned)/i;
  var DATE_RE = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b|\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{2,4})\b/i;
  function parseReceipt(text, opts) {
    opts = opts || {};
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var amount = NaN, amountLine = -1, candidates = [];
    lines.forEach(function (l, i) {
      var m = l.match(MONEY_LINE); if (!m) return;
      var v = parseFloat(m[1].replace(/,/g, '')); if (!(v > 0) || v > 1e6) return;
      candidates.push({ v: v, i: i, total: TOTAL_RE.test(l) && !NOT_TOTAL_RE.test(l), bad: NOT_TOTAL_RE.test(l) });
    });
    var totals = candidates.filter(function (c) { return c.total; });
    if (totals.length) { var t = totals[totals.length - 1]; amount = t.v; amountLine = t.i; }
    else {
      var good = candidates.filter(function (c) { return !c.bad; });
      if (good.length) { var best = good.reduce(function (a, b) { return b.v >= a.v ? b : a; }); amount = best.v; amountLine = best.i; }
    }
    var date = null;
    for (var i = 0; i < lines.length && !date; i++) {
      var d = lines[i].match(DATE_RE); if (!d) continue;
      if (d[1]) date = fmtDate(fullYear(d[3]), +d[2], +d[1]);
      else if (d[4]) date = fmtDate(+d[4], +d[5], +d[6]);
      else if (d[7]) { var mo = MONTHS[d[8].toLowerCase()]; if (mo) date = fmtDate(fullYear(d[9]), mo, +d[7]); }
      if (date && opts.today && date > opts.today) date = null;
    }
    var merchant = '';
    for (var j = 0; j < Math.min(lines.length, 6); j++) {
      var l2 = lines[j];
      if (/^\d|^(tel|fax|gst|sst|no\.|invoice|receipt|resit|tax|www|http|\(|\d{3,})/i.test(l2) || l2.length < 3 || /\d{5,}/.test(l2)) continue;
      if (/[A-Za-z一-龥]{3,}/.test(l2)) { merchant = l2.replace(/\b(sdn\.? ?bhd\.?|berhad|enterprise|trading|s\/b)\b/ig, '').replace(/[^\w\s&'一-龥-]/g, ' ').replace(/\s+/g, ' ').trim(); break; }
    }
    var all = lines.join(' '), plain = all.replace(/[.'\-]/g, '');
    var category = '', hit = null;
    for (var k = 0; k < MERCHANT_RULES.length && !category; k++) {
      var mm = all.match(MERCHANT_RULES[k].re) || plain.match(MERCHANT_RULES[k].re);
      if (mm) { category = MERCHANT_RULES[k].cat; hit = mm[1] || mm[0]; }
    }
    var type = /(salary|gaji|payment received|credit advice|dividend|dividen|refund|bayaran balik|interest credited)/i.test(all) ? 'income' : 'expense';
    return { amount: isFinite(amount) ? round2(amount) : NaN, amountLine: amountLine >= 0 ? lines[amountLine] : '', date: date, merchant: merchant, category: category, matched: hit, type: type, lines: lines.length };
  }

  // ---------- action loop: health diagnosis → allocatable cash → allocation plan (deterministic rules, versioned) ----------
  var RULES_VERSION = 'v1';
  var EPF_RIA = { basic: 390000, adequate: 650000, enhanced: 1300000 }; // KWSP Retirement Income Adequacy 2026 reference levels
  function scoreBands(v, bands) { // bands: [[threshold, score], ...] descending thresholds
    if (v == null || !isFinite(v)) return null;
    for (var i = 0; i < bands.length; i++) if (v >= bands[i][0]) return bands[i][1];
    return bands[bands.length - 1][1];
  }
  function avgIncome(tx, m, n) {
    var ms = monthRange(m, n || 3).map(function (x) { return cashflow(tx, x).income; }).filter(function (v) { return v > 0; });
    return ms.length ? ms.reduce(function (a, b) { return a + b; }, 0) / ms.length : 0;
  }
  function recurringMonthly(recurring) {
    var inc = 0, fixed = 0, debt = 0;
    (recurring || []).forEach(function (r) {
      if (r.active === false) return;
      if (r.type === 'income') inc += Number(r.amount) || 0;
      else if (r.type === 'repayment') { fixed += Number(r.amount) || 0; debt += Number(r.amount) || 0; }
      else fixed += Number(r.amount) || 0;
    });
    return { income: round2(inc), fixed: round2(fixed), debt: round2(debt) };
  }
  // d = { accounts, balances, rates, tx, recurring, month, prefs:{lifeCover, birthYear, emergencyMonths}, snapshots }
  function healthDiagnosis(d) {
    var m = d.month, tx = d.tx || [], acc = d.accounts || {}, prefs = d.prefs || {};
    var tot = familyTotals(acc, d.balances || {}, d.rates || {}, m);
    var income = avgIncome(tx, m, 3), rec = recurringMonthly(d.recurring);
    var incomeM = income || rec.income;
    var expense = avgMonthlyExpense(tx, m, 3);
    var dims = [];
    // 1 cash flow
    var sr = incomeM > 0 ? (incomeM - (expense || rec.fixed)) / incomeM : null;
    dims.push({ key: 'cashflow', name: '现金流', value: sr, text: sr == null ? '还没有收入记录，无法计算储蓄率' : '储蓄率 ' + (sr * 100).toFixed(0) + '%（近 3 个月平均）', score: scoreBands(sr, [[0.3, 100], [0.2, 80], [0.1, 55], [0, 25], [-1e9, 0]]), hint: '目标 20% 以上；先付自己 + 固定支出清单最有效' });
    // 2 liquidity
    var em = expense > 0 ? tot.liquid / expense : (rec.fixed > 0 ? tot.liquid / rec.fixed : null);
    var target = Number(prefs.emergencyMonths) || 6;
    dims.push({ key: 'liquidity', name: '流动性', value: em, text: em == null ? '还没有支出记录' : '可动用现金够 ' + em.toFixed(1) + ' 个月开销（目标 ' + target + '）', score: scoreBands(em, [[target, 100], [3, 65], [1, 35], [0, 10]]), hint: '阶梯式：先 RM1,000 → 1 个月 → 3 个月 → ' + target + ' 个月' });
    // 3 debt
    var dsr = incomeM > 0 ? rec.debt / incomeM : null;
    var highCost = activeAccounts(acc).filter(function (a) { return a.kind === 'liability' && (a.category === '信用卡' || a.category === '个人贷款' || a.category === '其他负债') && (valueAt(d.balances || {}, a.id, m).b || {}).amount > 0; });
    var debtScore = dsr == null ? (highCost.length ? 40 : null) : scoreBands(dsr, [[0.5, 15], [0.35, 45], [0.2, 75], [0, 100]].reverse());
    if (debtScore != null && highCost.length) debtScore = Math.min(debtScore, 50);
    dims.push({ key: 'debt', name: '债务', value: dsr, text: (dsr == null ? '' : '月供占收入 ' + (dsr * 100).toFixed(0) + '%（银行红线 35–40%）') + (highCost.length ? (dsr == null ? '' : '；') + '有 ' + highCost.length + ' 笔高息债务（' + highCost.map(function (a) { return a.name; }).join('、') + '）' : ''), score: debtScore, hint: '高息债先清（信用卡 15–18%），房贷车贷可按期', highCost: highCost.map(function (a) { return a.id; }) });
    // 4 protection
    var cover = Number(prefs.lifeCover);
    var cc = incomeM > 0 ? coverCheck({ annualIncome: incomeM * 12, debts: tot.liabs, liquid: tot.liquid, cover: cover || 0 }) : null;
    dims.push({ key: 'cover', name: '保障', value: cc ? (cc.need > 0 ? cc.have / cc.need : 1) : null, text: !cc ? '需要收入记录' : !(cover > 0) ? '还没填人寿保额（报表 → 人寿保障够不够）' : cc.ok ? '人寿保额足够' : '人寿保额还差 ' + cc.gap.toFixed(0), score: !cc ? null : !(cover > 0) ? 30 : cc.ok ? 100 : Math.round(Math.min(100, cc.have / cc.need * 100)), hint: '保额 ≈ 年收入 × 10 + 负债 − 现金；医药卡每人一张' });
    // 5 retirement
    var retire = tot.byCategory['退休金'] || 0;
    var age = prefs.birthYear ? Number(m.slice(0, 4)) - Number(prefs.birthYear) : null;
    var expected = age ? EPF_RIA.basic * Math.min(1, Math.max(0.05, (age - 22) / 38)) : EPF_RIA.basic;
    var rp = retire / expected;
    dims.push({ key: 'retire', name: '退休', value: rp, text: '退休金 ' + retire.toFixed(0) + (age ? '，按 ' + age + ' 岁进度应有约 ' + expected.toFixed(0) : '，KWSP 基本储蓄参考 ' + EPF_RIA.basic) + '（完成 ' + (rp * 100).toFixed(0) + '%）', score: Math.round(Math.min(100, rp * 100)), hint: 'KWSP 三档：基本 39 万、适足 65 万、充裕 130 万（55 岁）；自雇可用 i-Saraan' });
    // 6 growth
    var trend = netWorthTrend(acc, d.balances || {}, d.rates || {}, monthRange(m, 12)).map(function (x) { var sn = (d.snapshots || {})[x.month]; return sn ? { month: x.month, net: sn.net } : x; });
    var fc = netWorthForecast(trend, Infinity);
    var gr = fc.rate != null && incomeM > 0 ? fc.rate / incomeM : null;
    dims.push({ key: 'growth', name: '财富增长', value: gr, text: fc.rate == null ? '需要至少两个月的净资产记录' : '净资产每月' + (fc.rate >= 0 ? '增加' : '减少') + ' ' + Math.abs(fc.rate).toFixed(0) + (gr != null ? '（相当于收入的 ' + (gr * 100).toFixed(0) + '%）' : ''), score: gr == null ? null : scoreBands(gr, [[0.3, 100], [0.2, 85], [0.1, 65], [0, 40], [-1e9, 10]]), hint: '长期靠定投和再平衡；单一资产（如房产）占比过高要注意' });
    var scored = dims.filter(function (x) { return x.score != null; });
    var index = scored.length >= 3 ? Math.round(scored.reduce(function (a, x) { return a + x.score; }, 0) / scored.length) : null;
    return { index: index, dims: dims, confidence: scored.length, preliminary: scored.length < 5, income: round2(incomeM), expense: round2(expense), liquid: round2(tot.liquid), emergencyMonths: em, emergencyTarget: target, highCost: highCost, net: round2(tot.net), retire: round2(retire) };
  }
  // Money the family can decide about this month: income − fixed commitments − typical variable spending.
  // state: 'unknown' (no income data), 'unknown-expense' (no spending data), 'interrupted' (income stopped recently),
  //        'negative' (committed spending exceeds income), 'ok'. Missing data is never treated as zero money.
  function allocatable(d) {
    var tx = d.tx || [], m = d.month, rec = recurringMonthly(d.recurring), p = d.prefs || {};
    var incomeTx = avgIncome(tx, m, 3), est = Number(p.incomeEstimate) || 0;
    var income = rec.income || incomeTx || est, basis = rec.income ? 'recurring' : incomeTx ? 'average' : est ? 'estimate' : 'none';
    var expAvg = avgMonthlyExpense(tx, m, 3), expEst = Number(p.expenseEstimate) || 0;
    var variable = expAvg > 0 ? Math.max(0, expAvg - rec.fixed) : expEst > 0 ? Math.max(0, expEst - rec.fixed) : 0;
    var expenseKnown = expAvg > 0 || rec.fixed > 0 || expEst > 0;
    var taxReserve = round2(income * (Number(p.taxReservePct) || 0) / 100);
    // income interruption: the last two months had no income although the three before did
    var recent = [m, addMonths(m, -1)].map(function (x) { return cashflow(tx, x).income; }), earlier = monthRange(addMonths(m, -2), 3).map(function (x) { return cashflow(tx, x).income; });
    var interrupted = !rec.income && recent.every(function (v) { return v === 0; }) && earlier.some(function (v) { return v > 0; });
    var raw = round2(income - rec.fixed - variable - taxReserve);
    var state = interrupted ? 'interrupted' : basis === 'none' ? 'unknown' : !expenseKnown ? 'unknown-expense' : raw < 0 ? 'negative' : 'ok';
    var buffer = Number(p.cashBuffer) || 0, liquid = Number(d.liquid) || 0;
    return { income: round2(income), fixed: rec.fixed, variable: round2(variable), taxReserve: taxReserve, raw: raw, amount: state === 'ok' ? Math.max(0, raw) : 0,
      basis: basis, state: state, gap: raw < 0 ? -raw : 0, belowBuffer: buffer > 0 && liquid < buffer, buffer: buffer, interrupted: interrupted };
  }
  // Allocation rules: ordered, each takes a share of what is left; amounts rounded to RM10; sum equals the input.
  function allocationPlan(diag, amount, goals, m, al) {
    var left = Math.floor((Number(amount) || 0) / 10) * 10, out = [];
    var state = al && al.state ? al.state : 'ok';
    if (state === 'unknown') return { version: RULES_VERSION, tasks: [], left: 0, state: state, note: '还不知道你每月有多少收入。添加定期收入，或先填一个大概的月收入估计。' };
    if (state === 'unknown-expense') return { version: RULES_VERSION, tasks: [], left: 0, state: state, note: '还不知道每月要花多少。记几笔开销，或先填一个大概的月开销估计。' };
    if (state === 'interrupted') return { version: RULES_VERSION, tasks: [{ key: 'protect-cash', title: '收入中断：暂停新增投资，保住现金', amount: 0, reason: '近两个月没有收入记录。先确认收入状况；现有现金优先留给必要开支和月供，不做新的长期投资。', kind: 'protect', id: m + '__protect-cash', month: m }], left: 0, state: state };
    if (state === 'negative') return { version: RULES_VERSION, tasks: [{ key: 'fix-gap', title: '补上每月 ' + (al.gap || 0).toFixed(0) + ' 的资金缺口', amount: 0, reason: '固定支出加平均开销超过收入。先看固定支出里能停的订阅、能重组的贷款，再谈储蓄。', kind: 'protect', id: m + '__fix-gap', month: m }], left: 0, state: state };
    if (al && al.belowBuffer) { var need = Math.min(left, Math.ceil((al.buffer - (diag.liquid || 0)) / 10) * 10); if (need > 0) { out.push({ key: 'buffer', title: '先把现金补到安全线 ' + al.buffer.toFixed(0), amount: need, reason: '你设定的最低现金缓冲还没达到。', kind: 'save' }); left -= need; } }
    if (left <= 0 && !out.length) return { version: RULES_VERSION, tasks: [], left: 0, state: state, note: '本月没有可分配的钱：收入刚好覆盖固定支出和平均开销。' };
    function take(key, title, share, reason, kind) {
      if (left <= 0) return;
      var amt = Math.min(left, Math.max(10, Math.floor(left * share / 10) * 10));
      out.push({ key: key, title: title, amount: amt, reason: reason, kind: kind });
      left -= amt;
    }
    var em = diag.emergencyMonths, tgt = diag.emergencyTarget;
    if (em != null && em < 1) take('emergency', '存入紧急备用金', 0.6, '可动用现金不到 1 个月开销，这是第一优先。', 'save');
    if (diag.highCost && diag.highCost.length) take('debt', '多还高息债务（信用卡 / 个人贷款）', em != null && em < 1 ? 0.5 : 0.4, '高息债务的利率远高于任何稳健投资的回报，先还最划算。', 'debt');
    if (em != null && em >= 1 && em < tgt) take('emergency', '继续补备用金到 ' + tgt + ' 个月', 0.4, '现在够 ' + em.toFixed(1) + ' 个月，目标 ' + tgt + ' 个月。', 'save');
    take('retire', '长期储蓄 / 退休（EPF 自愿缴、PRS、定投）', 0.3, '不管处于哪个阶段，都保留至少两成给长期，复利需要时间。', 'invest');
    var active = (goals || []).filter(function (g) { return !g.done && g.perMonth > 0; });
    if (active.length && left > 0) {
      var totalNeed = active.reduce(function (a, g) { return a + g.perMonth; }, 0);
      active.forEach(function (g) { take('goal:' + g.id, '存入目标「' + g.name + '」', Math.min(1, g.perMonth / Math.max(totalNeed, left)), '到 ' + (g.targetMonth || '目标月份') + ' 每月需存 ' + g.perMonth.toFixed(0) + '。', 'goal'); });
    }
    if (left > 0) out.push({ key: 'free', title: '自由支配或加码定投', amount: left, reason: '以上都安排好了，这部分可以奖励自己或多投一点。', kind: 'free' });
    out.forEach(function (t) { t.id = m + '__' + t.key.replace(/[^\w:-]/g, ''); t.month = m; });
    return { version: RULES_VERSION, tasks: out, left: 0 };
  }

  // ---------- saving methods: catalog + schedules + progress + before/after comparison ----------
  var SAVING_METHODS = [
    { key: 'ratio', group: '比例法', name: '50 / 30 / 20', who: '刚开始、收入稳定', rule: '必需 50%、想要 30%、储蓄与还债 20%；比例可自己调', params: [['save', '储蓄比例 %', 20]] },
    { key: 'pyf', group: '比例法', name: '先付自己（Pay Yourself First）', who: '所有人，最有效', rule: '发薪日先转一个比例到不可动账户，剩下才花', params: [['save', '每次收入先存 %', 20]] },
    { key: 'percent', group: '比例法', name: '按收入比例存（不固定收入）', who: '自雇、佣金、生意', rule: '每一笔进账先存固定比例，收入多存多、少存少', params: [['save', '每笔收入存 %', 30]] },
    { key: 'raise', group: '比例法', name: '加薪全存 / 奖金一半', who: '收入在涨的人', rule: '收入高于基线的部分 100% 存，奖金至少存一半', params: [['base', '月收入基线 RM', 0]] },
    { key: 'c52', group: '挑战', name: '52 周递增', who: '喜欢游戏感', rule: '第 n 周存 n × 单位（单位 1 → 全年 RM1,378；单位 10 → RM13,780）', params: [['unit', '单位 RM', 10]], weeks: 52 },
    { key: 'c52r', group: '挑战', name: '52 周递减', who: '年底开销大', rule: '从 52 × 单位开始递减，前紧后松', params: [['unit', '单位 RM', 10]], weeks: 52 },
    { key: 'c365', group: '挑战', name: '365 天固定', who: '养成每天的习惯', rule: '每天存固定金额，日历打卡', params: [['unit', '每天 RM', 5]], days: 365 },
    { key: 'grid100', group: '挑战', name: '100 格存钱', who: '收入不固定、小生意', rule: '100 个格子写 1–100 × 单位，随机存一格划掉，满格共 5050 × 单位', params: [['unit', '单位 RM', 1]], cells: 100 },
    { key: 'roundup', group: '挑战', name: '零头归整', who: '常刷卡、电子钱包', rule: '每笔支出凑到整十，差额月底一次转存', params: [['to', '凑整到 RM', 10]] },
    { key: 'nospend', group: '挑战', name: '无消费日', who: '想戒冲动消费', rule: '每周挑 N 天只花必需，日历打卡', params: [['days', '每周目标天数', 2]] },
    { key: 'envelope', group: '结构法', name: '信封预算', who: '控制不住刷卡', rule: '每个分类设月预算，花完即停（用分类预算实现）', params: [] },
    { key: 'zero', group: '结构法', name: '零基预算', who: '想精细控制现金流', rule: '月初把每一元收入分配到用途，未分配为零', params: [] },
    { key: 'kakeibo', group: '结构法', name: '日本家计簿 Kakeibo', who: '喜欢反思', rule: '月初写收入与固定支出和想存的数；月末回答四问：有多少、想存多少、花了多少、如何改进', params: [['save', '本月想存 RM', 0]] },
    { key: 'sinking', group: '目标法', name: '沉没基金', who: '每年被大额账单打乱', rule: '车险、路税、保费、学费按月摊存（定期项目标“年缴”）', params: [] },
    { key: 'ladder', group: '目标法', name: '紧急备用金阶梯', who: '所有人第一步', rule: 'RM1,000 → 1 个月开销 → 3 个月 → 6 个月，一级一级来', params: [] },
    { key: 'fd12', group: '目标法', name: '12 存单定存', who: '要利息也要流动性', rule: '每月存一张 12 个月定存，一年后每月都有一张到期', params: [['unit', '每月 RM', 1000]] }
  ];
  function methodByKey(k) { for (var i = 0; i < SAVING_METHODS.length; i++) if (SAVING_METHODS[i].key === k) return SAVING_METHODS[i]; return null; }
  function addDaysISO(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
  // Schedule for challenge methods: items with index, due date, amount; done = array of indexes already saved.
  function methodSchedule(m, today) {
    var def = methodByKey(m.key), unit = Number((m.params || {}).unit) || 1, start = m.startDate || today, done = m.done || [], out = [];
    if (!def) return out;
    var isDone = function (i) { return done.indexOf(i) >= 0; };
    if (def.weeks) for (var w = 1; w <= def.weeks; w++) out.push({ idx: w, date: addDaysISO(start, (w - 1) * 7), amount: round2((def.key === 'c52r' ? 53 - w : w) * unit), done: isDone(w), due: addDaysISO(start, (w - 1) * 7) <= today });
    else if (def.days) for (var d = 1; d <= def.days; d++) out.push({ idx: d, date: addDaysISO(start, d - 1), amount: unit, done: isDone(d), due: addDaysISO(start, d - 1) <= today });
    else if (def.cells) for (var c = 1; c <= def.cells; c++) out.push({ idx: c, date: null, amount: round2(c * unit), done: isDone(c), due: true });
    return out;
  }
  // Round-up: how much the month's expenses would add if each were rounded up to `to`.
  function roundupAmount(tx, month, to) {
    to = Number(to) || 10; var sum = 0;
    (tx || []).forEach(function (t) { if (t.month !== month || t.type !== 'expense') return; var a = Number(t.amount) || 0; var r = Math.ceil(a / to) * to - a; if (r > 0 && r < to) sum += r; });
    return round2(sum);
  }
  // Progress of one method for month `month`.
  function methodProgress(m, ctx) {
    var def = methodByKey(m.key), tx = ctx.tx || [], month = ctx.month, today = ctx.today, p = m.params || {};
    if (!def) return null;
    var cf = cashflow(tx, month), saved = Math.max(0, cf.net), out = { key: m.key, name: def.name, target: null, actual: null, pct: null, text: '' };
    if (def.key === 'ratio' || def.key === 'pyf' || def.key === 'percent' || def.key === 'kakeibo') {
      var pctWant = def.key === 'kakeibo' ? null : (Number(p.save) || 20) / 100;
      out.target = def.key === 'kakeibo' ? round2(Number(p.save) || 0) : round2(cf.income * pctWant);
      out.actual = round2(saved);
      out.pct = out.target > 0 ? Math.min(1, out.actual / out.target) : (cf.income > 0 ? 0 : null);
      out.text = cf.income > 0 ? '本月收入 ' + cf.income.toFixed(0) + '，目标存 ' + out.target.toFixed(0) + '，目前结余 ' + out.actual.toFixed(0) : '本月还没有收入记录';
    } else if (def.key === 'raise') {
      var base = Number(p.base) || 0, extra = Math.max(0, cf.income - base);
      out.target = round2(extra); out.actual = round2(Math.min(saved, extra)); out.pct = extra > 0 ? Math.min(1, out.actual / extra) : null;
      out.text = extra > 0 ? '本月收入比基线多 ' + extra.toFixed(0) + '，这部分应全部存起来' : '本月收入没有超过基线 ' + base.toFixed(0);
    } else if (def.weeks || def.days || def.cells) {
      var sch = methodSchedule(m, today), due = sch.filter(function (x) { return x.due; }), dn = sch.filter(function (x) { return x.done; });
      out.target = round2(sch.reduce(function (a, x) { return a + x.amount; }, 0)); out.actual = round2(dn.reduce(function (a, x) { return a + x.amount; }, 0));
      out.pct = out.target > 0 ? out.actual / out.target : 0;
      var overdue = due.filter(function (x) { return !x.done; }).length;
      out.text = '已存 ' + dn.length + ' / ' + sch.length + (def.cells ? ' 格' : def.weeks ? ' 周' : ' 天') + '，共 ' + out.actual.toFixed(0) + ' / ' + out.target.toFixed(0) + (overdue ? '，有 ' + overdue + ' 期还没打卡' : '');
      out.overdue = overdue;
    } else if (def.key === 'roundup') {
      out.target = roundupAmount(tx, month, p.to); out.actual = (m.collected || {})[month] ? out.target : 0; out.pct = out.target > 0 ? (out.actual ? 1 : 0) : null;
      out.text = '本月零头合计 ' + out.target.toFixed(2) + ((m.collected || {})[month] ? '，已转存' : '，月底转存到储蓄户口');
    } else if (def.key === 'nospend') {
      var days = (m.marks || []).filter(function (d) { return d.slice(0, 7) === month; }).length, weeks = Math.max(1, Math.ceil(Number(today.slice(8)) / 7));
      out.target = (Number(p.days) || 2) * weeks; out.actual = days; out.pct = Math.min(1, days / out.target);
      out.text = '本月无消费日 ' + days + ' 天（目标到今天约 ' + out.target + ' 天）';
    } else if (def.key === 'ladder') {
      var liquid = ctx.liquid || 0, exp = ctx.avgExpense || 0, steps = [1000, exp, exp * 3, exp * 6].filter(function (x) { return x > 0; });
      var idx = 0; while (idx < steps.length && liquid >= steps[idx]) idx++;
      out.target = steps[Math.min(idx, steps.length - 1)] || 1000; out.actual = round2(liquid); out.pct = out.target ? Math.min(1, liquid / out.target) : null;
      out.text = idx >= steps.length ? '备用金阶梯已全部完成' : '第 ' + (idx + 1) + ' 级：目标 ' + out.target.toFixed(0) + '，现在 ' + liquid.toFixed(0);
    } else {
      out.text = def.rule;
    }
    return out;
  }
  // Did the method help? Savings rate in the months since start vs the 3 months before.
  function methodComparison(m, tx, month) {
    var start = (m.startDate || month).slice(0, 7);
    var after = [], before = [];
    for (var x = start; x <= month; x = addMonths(x, 1)) { var c = cashflow(tx, x); if (c.income > 0) after.push(c.net / c.income); if (after.length > 24) break; }
    monthRange(addMonths(start, -1), 3).forEach(function (bm) { var c = cashflow(tx, bm); if (c.income > 0) before.push(c.net / c.income); });
    var avg = function (a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; };
    var b = avg(before), a = avg(after);
    return { before: b, after: a, delta: b != null && a != null ? a - b : null, monthsAfter: after.length, monthsBefore: before.length };
  }

  // ---------- financial pyramid: level status from the diagnosis (learning unlocks progressively; actions never hard-locked) ----------
  var PYRAMID = [
    { key: 'protect', name: '必要保障与现金流安全', test: function (d) { return byKey(d, 'cover').score >= 70 && byKey(d, 'cashflow').score >= 25; }, why: '医药卡、人寿保额、正的现金流', cards: ['人寿保额 ≈ 年收入 × 10 + 负债 − 现金', '每人一张医药卡；看年限额、终身限额、等候期', '储蓄率先过 10%，再谈其他'] },
    { key: 'emergency', name: '应急备用金', test: function (d) { return d.emergencyMonths != null && d.emergencyMonths >= 3; }, why: '可动用现金 ≥ 3 个月开销（目标 6）', cards: ['阶梯：RM1,000 → 1 个月 → 3 个月 → 6 个月', '放定存阶梯或货币市场基金，不放股票', '自雇或单收入家庭建议 9–12 个月'] },
    { key: 'debt', name: '高成本债务管理', test: function (d) { return !(d.highCost && d.highCost.length) && (byKey(d, 'debt').score == null || byKey(d, 'debt').score >= 70); }, why: '没有信用卡/个人贷款余额，月供 ≤ 35% 收入', cards: ['信用卡 15–18%：任何稳健投资都跑不赢，先还', '雪球（先小额，有成就感）vs 雪崩（先高息，省最多）', '房贷利率差 > 0.5% 可考虑再融资；AKPK 可免费重组'] },
    { key: 'retire', name: '退休储蓄', test: function (d) { return byKey(d, 'retire').score >= 70; }, why: 'EPF/PRS 进度跟得上年龄', cards: ['KWSP 三档：基本 RM390k、适足 RM650k、充裕 RM1.3m（55–60 岁）', '自雇用 i-Saraan（政府配对）和 PRS（减免 RM3,000）', '退休开支约为在职的 70%'] },
    { key: 'base', name: '低风险资金底仓', test: function (d) { return d.liquid > 0 && d.emergencyMonths >= 6; }, why: '1–3 年内要用的钱放稳健工具', cards: ['定存阶梯、ASB/ASNB、Tabung Haji、货币市场基金', '新加坡 T-bills / SSB', '收益 3–5%，目标是不亏'] },
    { key: 'invest', name: '长期定期投资', test: function (d) { return byKey(d, 'growth').score != null && byKey(d, 'growth').score >= 65; }, why: '每月定投、分散、低费用、年度再平衡', cards: ['全球/美股指数 ETF、马股 ETF、低费用单位信托、REITs', '股票比例 ≈ 100 − 年龄；每年再平衡一次', '马新买卖股票没有资本利得税'] },
    { key: 'satellite', name: '高风险卫星投资', test: function () { return false; }, why: '只用可承受损失的一小部分', cards: ['个股、加密货币不超过可投资资产 5–10%', '黄金白银 5–10% 对冲', '保证月回报 > 1% 的都是骗局'] },
    { key: 'property', name: '房产与重大长期资产', test: function () { return false; }, why: '自住优先；投资房看租金回报与持有成本', cards: ['租金回报 3–5%；算入维修、空置、管理费、门牌税', 'RPGT：前 3 年卖 30%，第 6 年起 0%（个人）', '单一资产占净资产 > 60% 要注意'] },
    { key: 'legacy', name: '财富传承与遗产安排', test: function () { return false; }, why: '遗嘱 / Wasiat、受益人、文件库', cards: ['EPF、保险、PRS 的受益人指定', '遗嘱（非穆斯林）/ Wasiat + Hibah（穆斯林）', '重要文件库与数字资产交接'] }
  ];
  function byKey(d, k) { for (var i = 0; i < d.dims.length; i++) if (d.dims[i].key === k) return d.dims[i]; return { score: null }; }
  // Returns levels with status: done | current (first not done) | open (actions allowed, learning unlocked when previous done) | later
  function pyramidStatus(diag) {
    var out = [], currentSet = false;
    PYRAMID.forEach(function (lv, i) {
      var done = false; try { done = !!lv.test(diag); } catch (e) { done = false; }
      var status = done ? 'done' : (!currentSet ? 'current' : (i <= 5 ? 'open' : 'later'));
      if (!done && !currentSet) currentSet = true;
      out.push({ key: lv.key, level: i + 1, name: lv.name, why: lv.why, cards: lv.cards, status: status });
    });
    return out;
  }

  var api = {
    DEFAULT_RATE: DEFAULT_RATE, TX_TYPES: TX_TYPES,
    todayKuching: todayKuching, nowMonth: nowMonth, addMonths: addMonths, monthRange: monthRange,
    daysInMonth: daysInMonth, dateInMonth: dateInMonth, isDate: isDate, parseDate: parseDate,
    rateFor: rateFor, latestBalance: latestBalance, valueAt: valueAt, toRM: toRM,
    activeAccounts: activeAccounts, accountValues: accountValues,
    groupTotals: groupTotals, familyTotals: familyTotals, investableNet: investableNet, businessTotals: businessTotals,
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
    dayTotals: dayTotals, calendarGrid: calendarGrid, weekSummary: weekSummary, dueAutoPost: dueAutoPost,
    healthCheck: healthCheck, SETUP_TYPES: SETUP_TYPES, SETUP_CATEGORIES: SETUP_CATEGORIES, buildSetup: buildSetup, LIQUID: LIQUID,
    RECURRING_TEMPLATES: RECURRING_TEMPLATES, cardCycle: cardCycle, netWorthForecast: netWorthForecast, categoryForNote: categoryForNote,
    memberCategoryMatrix: memberCategoryMatrix, cashflowForecast: cashflowForecast, fiCalc: fiCalc, prepaySim: prepaySim, coverCheck: coverCheck,
    compareShares: compareShares, parseSpeech: parseSpeech, MY_HOUSEHOLD_SHARES: MY_HOUSEHOLD_SHARES,
    parseReceipt: parseReceipt, MERCHANT_RULES: MERCHANT_RULES,
    RULES_VERSION: RULES_VERSION, EPF_RIA: EPF_RIA, healthDiagnosis: healthDiagnosis, allocatable: allocatable, allocationPlan: allocationPlan, recurringMonthly: recurringMonthly,
    SAVING_METHODS: SAVING_METHODS, methodByKey: methodByKey, methodSchedule: methodSchedule, methodProgress: methodProgress, roundupAmount: roundupAmount, methodComparison: methodComparison,
    PYRAMID: PYRAMID, pyramidStatus: pyramidStatus
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof window !== 'undefined' ? window : globalThis);
