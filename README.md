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

## 新手引导（第一次打开）

没有任何账户时会自动弹出，也可在「设置 → 新手引导」随时再跑：

1. 家里有谁会用（成员）、有没有 SGD 账户。
2. 勾选拥有的资产类型：现金与银行、电子钱包、退休金（EPF/PRS/CPF）、股票基金与投资账户、加密货币、黄金白银、保险现金价值、房产、车辆、借出款、生意户口。
3. 勾选负债类型：房贷、车贷、个人贷款、信用卡、学贷（PTPTN）、先买后付、借入款、生意透支。
4. 每一类逐项填名称和当前价值，每类都有估值方法提示（房产看成交价、车看二手行情、保险看 cash value、贷款看 outstanding balance 等）；贷款可填月供和利率。
5. 固定收入（金额、几号、进哪个户口、是否自动入账）和每月总预算。
6. 确认页显示将建立的账户和净资产，保存后直接进入总览。

类型清单和构建逻辑在 `src/logic.js` 的 `SETUP_TYPES` / `buildSetup`，有单元测试。

## 多家庭（多用户）与方案

- `data/keys.txt` 每行 `密钥:名字:家庭编号`，没有家庭编号的属于默认家庭（数据在 `data/` 本身）。其他家庭的数据在 `data/families/<编号>/`，各自有收据、每日备份、自动月结、自动入账、汇率；完全隔离，互相看不到。
- 每个家庭第一把密钥的人是该家庭 owner（可恢复备份）。默认家庭的 owner 是运营者，可调用 `setPlan(家庭, free|pro, 到期日)` 和 `listFamilies()`。
- 方案：没有设置就是完整版（自家用永远不限）。设为 `free` 后：最多 8 个账户、不能上传收据照片；到期日过了自动降为免费版。页面设置里显示当前方案。
- 付费订阅的接法：Android 版接 Google Play Billing，购买成功后由后端验证收据并调用 `setPlan(家庭, 'pro', 到期日)`；续费同样更新到期日。这一步要等 Android 打包（需要域名）之后做。
- 新家庭开通：`bash scripts/keys.sh add "名字" 家庭编号`，把生成的链接发给对方即可；对方第一次打开会进入新手引导。
- 不用 SSH 也行：运营者在「更多 → 设置 → 运营者 · 家庭与密钥」填名字和家庭编号，`addKey` 会生成密钥、追加到 `data/keys.txt`（立即生效，不用重启）并显示一次性链接；填已有家庭编号则是加成员。「查看所有家庭」列出每个家庭的 owner、成员、账户数和方案。要从零测试新界面，就新建一个家庭（例如 `demo`），在无痕窗口打开链接。

## 域名与证书（2026-10-16 起）

- 域名 `chen-family424.duckdns.org`（DuckDNS 免费）指向 187.77.128.30；`data/domain.txt` 记录域名，`keys.sh` 生成链接时会用它。
- 证书：Let's Encrypt，`certbot certonly --webroot -w /var/www/html -d chen-family424.duckdns.org`（80 端口由现有 nginx 提供验证目录）。证书在 `/etc/letsencrypt/live/chen-family424.duckdns.org/`，systemd 单元的 TLS_CERT / TLS_KEY 指向它；`/etc/letsencrypt/renewal-hooks/deploy/family-assets.sh` 在续期后自动重启服务。certbot 的 systemd timer 每天检查续期。
- 端口仍是 8444（443 被 sshd 占用）。访问地址：`https://chen-family424.duckdns.org:8444/`。

## 行动闭环（2026-10-16 晚）

- **首页"我的家庭财务计划"**：本月可分配金额 = 定期收入（或近 3 个月平均收入）− 固定支出与月供 − 平均其他开销；分配规则 `RULES_VERSION v1`（备用金 < 1 个月 → 60%；高息债务 → 40%；备用金未达标 → 40%；长期/退休 ≥ 30%；目标按每月需存额；其余自由支配），生成当月任务（`tasks` 集合，编号 `月份__规则`，不重复），可"已完成 / 跳过"，下月重算。
- **财务健康指数**：六维（现金流、流动性、债务、保障、退休、财富增长）各 0–100，取均值；点开看依据与做法；出生年份与保额存在 `settings/prefs`。
- **存钱法**（预算与定期页顶部 / 首页提示）：16 种（比例、挑战、结构、目标），挑战类有打卡格子，进度从现金流算，开始后对比前后储蓄率。存在 `settings/savingMethods`。
- **学习与规划页**：九层进阶路线按诊断标注已达到 / 现在 / 可并行 / 之后；LHDN YA2025 减免清单可勾选（`settings/tax`）；KWSP 三档；Belanjawanku 基准对比；债务利率与 AKPK；投资原则（教育）；传承清单。所有数字带来源与核对日期，在 `src/knowledge.js`。
- **轻量模式**：设置里切换，中键变"更新余额"，隐藏日常记账细节。
- **底座**：`tests/accounting.test.js` 14 项账务正确性测试；私人账户（服务端过滤）；匿名使用事件 `track` 与运营者 `usageStats`；owner 可删除本家庭全部数据。
- 上架清单见 `docs/play-store-checklist.md`。

## 发布流程（2026-10-16 起）

- **Staging**：`/root/family-staging`，服务 `family-assets-staging`，端口 8446，`https://chen-family424.duckdns.org:8446/`，密钥在它自己的 `data/keys.txt`，只放虚构数据。`bash scripts/update.sh staging` 部署。
- **Production**：`bash scripts/update.sh`。脚本会先跑三套测试，staging 服务挂掉时拒绝部署生产。
- **规则**：自动开发可以自动提交、测试、部署到 staging。涉及 `server.js`、数据校验、权限、删除、存储结构的改动，生产部署前要人工批准；其余（页面、逻辑、知识库）通过测试后可自动上生产。所有测试只用虚构家庭数据，永远不清空真实家庭资料。健康评分与分配规则带版本号（`RULES_VERSION`），任务记录生成时所用的版本。
- **删除与恢复**：owner 删除本家庭数据需输入 DELETE 和自己的密钥；数据归档在 `data/deleted/` 30 天，运营者可 `restoreDeleted`；30 天后自动清除。
- **私人账户**：`private = 成员编号` 只有本人可见（owner 也看不到，只看到数量）；`auditable = true` 时 owner 可查看。服务端过滤，不只是页面隐藏。
