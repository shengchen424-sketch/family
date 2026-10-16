#!/usr/bin/env python3
"""Personal-finance notifier for Sheng Chen's WhatsApp self-chat assistant.

Runs hourly (systemd timer family-assistant.timer). Reads the family-assets app
data on this VPS (/root/family/data) and the Strategy 1 BTC monitor state, and
queues messages into the Agrijoy assistant's self-chat outbound table
(assistant_outbound, drained by the Agrijoy assistant tick). Every message has a
dedup_key so re-runs never double-send.

Daily at 08:00 MYT:
  - 1st of month: ask the owner to update account balances (lists accounts).
  - reminders due in 7 days / today (family app reminders).
  - recurring items due today (auto-posted or needing confirmation).
  - 1st of Jan/Apr/Jul/Oct: quarterly review (investable net, FI progress).
Every run:
  - Strategy 1 bull score changed → note.
"""
import datetime as dt
import json
import os
import subprocess
import sys

DATA = os.environ.get("FAMILY_DATA", "/root/family/data")
STATE = os.path.join(DATA, "assistant_notify_state.json")
BULL = "/root/smart-trader/data/strategy1/bull_signals.json"
APP_URL = "https://chen-family424.duckdns.org:8444/"
MYT = dt.timezone(dt.timedelta(hours=8))
PREFIX = "【理财助理】"
RECIPIENT = os.environ.get("FAMILY_RECIPIENT", "Chen")  # messages go to the owner's own WhatsApp self-chat
NON_PRODUCTIVE = ("房产", "车辆")


def load(name):
    try:
        with open(os.path.join(DATA, name + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(s):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def enqueue(kind, dedup, body, dry=False):
    """Insert one pending row into assistant_outbound (ON CONFLICT dedup → skip)."""
    sql = (
        "INSERT INTO assistant_outbound (id, kind, dedup_key, body) "
        "VALUES (gen_random_uuid(), :'k', :'d', :'b') ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING;\n"
    )
    if dry:
        print(f"--- {kind} [{dedup}]\n{body}\n")
        return True
    # psql -v is safest for quoting: pass values as variables.
    # psql only interpolates :'var' in stdin scripts (not in -c), so feed the SQL on stdin.
    cmd = [
        "docker", "exec", "-i", "agrijoy-db-1", "psql", "-U", "agrijoy", "-d", "agrijoy", "-q",
        "-v", "ON_ERROR_STOP=1", "-v", f"k={kind}", "-v", f"d={dedup}", "-v", f"b={body}",
    ]
    r = subprocess.run(cmd, input=sql, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        print("enqueue failed:", r.stderr.strip(), file=sys.stderr)
        return False
    return True


def fmt(n):
    return f"{n:,.2f}"


def dmy(iso):
    y, m, d = iso.split("-")
    return f"{int(d)}/{int(m)}/{y}"


def rate_for(rates, month):
    keys = sorted(k for k in rates if k <= month)
    if keys:
        return float(rates[keys[-1]].get("sgdMyr") or 0) or None
    return None


def visible_to_recipient(a):
    """Private accounts (account.private = member id) belong to that member only; the recipient
    (family owner, RECIPIENT) may see them only when flagged auditable. Same rule as server.js."""
    p = a.get("private")
    return not p or p == RECIPIENT or bool(a.get("auditable"))


def account_rows(accounts, balances, rates, month):
    """Latest balance per active account as of month (RM)."""
    rate = rate_for(rates, month) or 1.0
    out = []
    for aid, a in accounts.items():
        if a.get("active") is False or not visible_to_recipient(a):
            continue
        best = None
        for b in balances.values():
            if b.get("accountId") != aid or b.get("month", "") > month:
                continue
            if best is None or b["month"] > best["month"]:
                best = b
        rm = None
        if best:
            rm = best["amount"] * (rate if a.get("currency") == "SGD" else 1)
        out.append({"id": aid, "a": a, "b": best, "rm": rm})
    out.sort(key=lambda r: (r["a"].get("sort") or 0, r["a"].get("name", "")))
    return out


def investable(rows):
    s = 0.0
    for r in rows:
        if r["a"].get("group") != "family" or r["rm"] is None or r["a"].get("category") in NON_PRODUCTIVE:
            continue
        s += r["rm"] if r["a"].get("kind") == "asset" else -r["rm"]
    return s


def family_net(rows):
    s = 0.0
    for r in rows:
        if r["a"].get("group") != "family" or r["rm"] is None:
            continue
        s += r["rm"] if r["a"].get("kind") == "asset" else -r["rm"]
    return s


def monthly_balance_prompt(today, accounts, balances, rates):
    month = today.strftime("%Y-%m")
    rows = account_rows(accounts, balances, rates, month)
    lines = [f"{PREFIX}{int(today.day)}/{int(today.month)}/{today.year} 月初余额更新", "请在 App「余额 → 本月批量更新」填这些账户的最新余额（上月数字会带过来，改了的才需要填）："]
    fam = [r for r in rows if r["a"].get("group") == "family"]
    biz = [r for r in rows if r["a"].get("group") == "business"]
    for r in fam + biz:
        cur = r["a"].get("currency", "MYR")
        last = f"{cur} {fmt(r['b']['amount'])}（{r['b']['month']}）" if r["b"] else "还没填过"
        lines.append(f"• {r['a']['name']}：{last}")
    lines.append(f"打开：{APP_URL}")
    lines.append("更新完回我「余额更新好了」，我会把本月净资产和财务自由进度算给你。")
    return "\n".join(lines)


def reminders_due(today, reminders):
    out = []
    for rid, r in reminders.items():
        if r.get("done") or not r.get("date"):
            continue
        try:
            d = dt.date.fromisoformat(r["date"])
        except ValueError:
            continue
        delta = (d - today).days
        if delta in (7, 0):
            out.append((rid, r, delta))
    return out


def recurring_due(today, recurring, tx):
    month = today.strftime("%Y-%m")
    done = {t.get("recurringKey") for t in tx.values() if t.get("recurringKey")}
    out = []
    for rid, r in recurring.items():
        if r.get("active") is False:
            continue
        if r.get("startMonth") and r["startMonth"] > month:
            continue
        if r.get("endMonth") and r["endMonth"] < month:
            continue
        if month in (r.get("skipped") or []):
            continue
        day = min(int(r.get("dayOfMonth") or 1), 28 if today.month == 2 else 30 if today.month in (4, 6, 9, 11) else 31)
        if day != today.day:
            continue
        key = f"{rid}__{month}"
        out.append((rid, r, key in done))
    return out


def quarterly_review(today, accounts, balances, rates, goals, snapshots):
    month = today.strftime("%Y-%m")
    rows = account_rows(accounts, balances, rates, month)
    inv = investable(rows)
    net = family_net(rows)
    goal = next((g for g in goals.values() if g.get("kind") == "investable"), None)
    lines = [f"{PREFIX}季度回顾（{today.year} 年第 {(today.month - 1) // 3 + 1} 季）"]
    lines.append(f"• 家庭净资产：RM {fmt(net)}")
    lines.append(f"• 可投资资产（不含房车）：RM {fmt(inv)}")
    if goal:
        tgt = float(goal.get("target") or 0)
        pct = inv / tgt * 100 if tgt else 0
        lines.append(f"• 财务自由目标 RM {fmt(tgt)}：{pct:.1f}%，还差 RM {fmt(max(0, tgt - inv))}")
    # compare with the snapshot 3 months back
    prev_m = (today.replace(day=1) - dt.timedelta(days=1))
    prev_m = prev_m.replace(day=1) - dt.timedelta(days=1)
    prev_m = prev_m.replace(day=1) - dt.timedelta(days=1)
    pk = prev_m.strftime("%Y-%m")
    sn = snapshots.get(pk)
    if sn and sn.get("net") is not None:
        lines.append(f"• 对比 {pk} 月结：净资产 {'+' if net - sn['net'] >= 0 else ''}{fmt(net - sn['net'])}")
    lines.append("这季要做的：核对贷款余额、检查定投有没有照做、看 App「报表」的支出环比。")
    lines.append(f"打开：{APP_URL}")
    return "\n".join(lines)


def strategy1_note(state):
    try:
        with open(BULL, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    score = d.get("last_score")
    hist = d.get("history") or []
    last = hist[-1] if hist else {}
    ts = last.get("ts") or ""
    if score is None or ts == state.get("s1_ts") and score == state.get("s1_score"):
        return None
    prev = state.get("s1_score")
    state["s1_ts"], state["s1_score"] = ts, score
    if prev is None:
        return None  # first run: just record
    on = [k for k, v in (d.get("signals") or {}).items() if v.get("triggered")]
    body = [f"{PREFIX}Strategy 1 BTC 牛市信号：{score}/8（之前 {prev}/8）", f"BTC ${last.get('btc', 0):,.0f} · {ts}", "已触发：" + "、".join(on)]
    if score >= 6 and (prev or 0) < 6:
        body.append("6/8 以上 = 二级确认，按 Strategy 1 规则分批建仓（docs/strategy1.md）。")
    return "\n".join(body)


def main():
    dry = "--dry" in sys.argv
    force_day = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--day=")), None)
    now = dt.datetime.now(MYT)
    today = dt.date.fromisoformat(force_day) if force_day else now.date()
    state = load_state()
    accounts, balances, rates = load("accounts"), load("balances"), load("rates")
    reminders, recurring, tx = load("reminders"), load("recurring"), load("tx")
    goals, snapshots = load("goals"), load("snapshots")
    sent = 0

    daily_slot = force_day is not None or now.hour == 8
    if daily_slot and state.get("daily_done") != today.isoformat():
        iso = today.isoformat()
        if today.day == 1:
            if enqueue("finance_monthly", f"finance:monthly:{iso[:7]}", monthly_balance_prompt(today, accounts, balances, rates), dry):
                sent += 1
            if today.month in (1, 4, 7, 10):
                if enqueue("finance_quarter", f"finance:quarter:{iso[:7]}", quarterly_review(today, accounts, balances, rates, goals, snapshots), dry):
                    sent += 1
        for rid, r, delta in reminders_due(today, reminders):
            when = "今天到期" if delta == 0 else f"7 天后到期（{dmy(r['date'])}）"
            body = f"{PREFIX}提醒：{r['title']} — {when}" + (f"\n{r['note']}" if r.get("note") else "") + f"\n做完在 App 勾掉：{APP_URL}"
            if enqueue("finance_reminder", f"finance:rem:{rid}:{delta}:{r['date']}", body, dry):
                sent += 1
        for rid, r, posted in recurring_due(today, recurring, tx):
            if posted or r.get("autoPost"):
                body = f"{PREFIX}今天「{r['name']}」RM {fmt(float(r['amount']))} 已{'自动' if r.get('autoPost') else ''}记入 App。"
            else:
                body = f"{PREFIX}今天该做：{r['name']} RM {fmt(float(r['amount']))}。做了在 App「预算与定期」按确认。\n{APP_URL}"
            if enqueue("finance_recurring", f"finance:rec:{rid}:{iso[:7]}", body, dry):
                sent += 1
        if not dry:
            state["daily_done"] = iso

    note = strategy1_note(state)
    if note and enqueue("finance_strategy1", f"finance:s1:{state.get('s1_ts')}:{state.get('s1_score')}", note, dry):
        sent += 1

    if not dry:
        save_state(state)
    print(f"{now.strftime('%Y-%m-%d %H:%M MYT')} queued {sent}")


if __name__ == "__main__":
    main()
