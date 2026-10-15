# 家庭资产与开销

- `src/` 源码（页面、计算逻辑、数据层、Apps Script 版本）
- `scripts/build.py` 生成 `public/index.html`
- `server.js` VPS 服务（无依赖 Node），数据存 `data/`（不进 git）
- `tests/` 计算逻辑测试：`npm test`
- `scripts/update.sh` 在 VPS 上拉取最新代码并重启服务

VPS 首次部署见 `family-assets.service` 注释。

## 访问密钥

- 密钥来源有两个，会合并：systemd 单元里的 `FAMILY_KEYS=密钥:名字,...`，以及 `data/keys.txt`（每行 `密钥:名字`，`#` 开头为注释）。
- 名字（Chen / Liza）用来标记谁录入、谁修改；每人一把密钥。
- 打开方式：`https://IP:8444/?k=密钥`。页面会把密钥存进 cookie，接口请求也会带上 `?k=`，手机浏览器丢 cookie 也不影响。
- 正式使用前把单元里的临时密钥 `Chen2026` 删掉（删掉 `Environment=FAMILY_KEYS=...` 那一行后 `systemctl daemon-reload && systemctl restart family-assets`），只保留 `data/keys.txt` 里的长密钥。

## 功能备忘

- 首次使用：「导入与设置」里一键导入 2026-10 期初数据（账户、余额、汇率、成员、分类）。
- 记账时可拍照 / 选图附上收据，照片压缩到 1600px 后存到 `data/receipts/`，流水上显示「收据」按钮。
- 「导入与设置」支持 CSV 和 PDF 对账单。PDF 用 pdf.js 3.11.174（`public/vendor/`，同源加载，不依赖外网），按带日期的行识别交易，余额变动判断收支方向；无法判断的行标为「待确认」，点该行可切换。有密码的 PDF 会提示输入。
- 手机上是底部导航（总览 / 余额 / 记账 / 流水 / 更多），宽屏用顶部标签。页面本身不含数据，可以直接打开 `https://IP:8444/` 输入密钥；密钥存在手机 localStorage，可在「更多 → 设置」退出。
- PWA：`public/manifest.webmanifest` + `public/sw.js`（缓存页面壳和 vendor，接口永远走网络），可“添加到主屏幕”。
- 报表页：分类环图与环比、最大支出、成员、账户进出、年度表。总览有预算进度（每天可花多少）、本月观察、储蓄目标。
- 贷款：在余额里填年利率和月供后，还款记账自动算利息，账户详情显示预计还清月份和剩余利息。
- 备份：设置里导出全部 JSON / 合并恢复。集合：accounts balances rates tx recurring categories members reminders snapshots audit goals settings。

## 服务端自动任务（server.js）

- 每小时：定期项目勾选“到期自动入账”的，到日期自动记一笔（byId=auto）。
- 每 6 小时：若上个月没有锁定快照，自动按当时余额锁定（含企业净现金）。
- 每天：`data/backups/YYYY-MM-DD/` 存一份全部 JSON，保留 30 天；抓取 SGD→MYR 汇率写入当月（手动填过的不覆盖）。`FAMILY_NO_FETCH=1` 可关闭抓取。
- 写入校验：流水、余额、账户、汇率、分类、定期、目标都在服务端校验；修改记录最多保留 2000 条；删除流水会一并删除收据文件。
- 密钥保护：同一 IP 10 分钟内输错 8 次，封 15 分钟。只有 owner（第一把密钥的名字，或 `FAMILY_OWNER`）能恢复备份。
- 测试：`npm test` 跑计算逻辑测试和服务端测试（服务端测试用临时目录和随机端口）。

## 密钥管理脚本

```bash
bash scripts/keys.sh list          # 看有哪些成员
bash scripts/keys.sh add Mum       # 给新成员生成密钥（只显示一次）
bash scripts/keys.sh rotate Liza   # 换密钥
bash scripts/keys.sh remove Mum    # 撤销
bash scripts/keys.sh remove-temp   # 删除 systemd 单元里的临时密钥 Chen2026
```

## 功能总览（2026-10-16）

- 总览：净资产、负债率、可动用现金、本月收支与储蓄率、较上月变化、预算进度（每天可花）、本月观察、储蓄目标、紧急备用金、资产结构、净资产折线、支出环图、待处理事项、分享本月小结。
- 余额：按家庭资产 / 家庭负债 / 企业分组，本月批量更新，账户详情可改名、改分类、看历史折线、贷款还款计划和结清比较，现金账户按流水估算当前余额。
- 记账：支出 / 收入 / 转账 / 还款，金额支持算式，常用分类胶囊，备注联想，收据拍照，SGD 账户按本月汇率自动换算，还款自动算利息，重复和未来日期提醒。
- 流水：月份、成员、类型、分类、账户、收据、关键字或金额筛选，日历视图，周汇总，再记一笔，导出 CSV。
- 报表：分类环图与环比、最大支出、成员、账户进出、近 12 个月净资产、年度表，导出 CSV。
- 预算与定期：分类预算、定期项目（确认 / 跳过 / 自动入账）、储蓄目标、提醒。
- 设置：期初数据、CSV / PDF 账单导入、快照、备份与恢复（本地 JSON 和服务器每日备份）、数据体检、成员、偏好（总预算、备用金月数、外观）、已停用账户、使用说明、安装到手机、退出。
- 上架路线见 `docs/play-store.md`。
