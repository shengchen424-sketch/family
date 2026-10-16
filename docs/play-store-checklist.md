# Google Play 上架清单（家庭资产与开销 / com.chenfamily.assets）

状态：2026-10-16。打钩表示已就绪。

## 账号与测试
- [ ] Google Play 开发者账号（一次性 USD 25，用 shengchen424@gmail.com 注册）
- [ ] 2023-11-13 之后创建的个人账号：需要 **12 位测试者连续 14 天**参加封闭测试才能申请正式发布。先建"封闭测试"轨道，邀请家人朋友的 Gmail。
- [x] 上传用的 `app-release-bundle.aab`（android/，Bubblewrap TWA，minSdk 24）
- [x] 签名 keystore 与密码（android/keystore/，**已另外备份？**）
- [x] Digital Asset Links：`https://chen-family424.duckdns.org:8444/.well-known/assetlinks.json`

## 商店资料
- [ ] 应用名：家庭资产与开销（英文：Family Assets & Expenses）
- [ ] 简短说明（80 字）与完整说明（4000 字）：强调"记录 → 诊断 → 每月行动"，不含投资建议措辞
- [x] 图标 512×512（public/icons/icon-512.png）
- [ ] 功能图 1024×500，手机截图至少 2 张（用真实但虚构数据的 demo 家庭截图）
- [ ] 分类：Finance；内容分级问卷（无用户生成公开内容、无赌博）
- [ ] 联系邮箱、网站 `https://chen-family424.duckdns.org:8444/`

## 政策申报
- [x] 隐私政策网址：`https://chen-family424.duckdns.org:8444/privacy.html`
- [ ] **Data Safety 表**：收集"财务信息（用户输入）、照片（收据，可选）"，用途"应用功能"，加密传输，用户可请求删除，不与第三方共享，无广告 ID
- [ ] **Financial Features Declaration**：选"个人财务管理 / 预算工具"，**不是**贷款、投资建议、支付或加密货币交易
- [ ] 账号删除：应用内"设置 → 删除全部数据"已有；需提供网页入口 → `https://chen-family424.duckdns.org:8444/privacy.html#delete`（待加说明段落）
- [ ] 目标 API 级别：当前 targetSdk 36（满足 2026 要求）
- [ ] 若上架付费订阅：接 Google Play Billing，马来西亚标准服务费 15%（订阅）；在应用内外说明价格与取消方式

## 法律
- [ ] 服务条款页面
- [ ] PDPA 2024 修正案：资料处理通知（已有隐私政策，需补"资料外泄通报"与"跨境传输"段）、删除流程（已有）
- [ ] 不提供个性化证券/基金/保险推荐（SC 受监管活动）；所有投资内容为通用教育并标注

## 发布前技术
- [x] 正式证书（Let's Encrypt，自动续期）
- [x] 账务正确性测试 14 项、服务端测试 13 项、逻辑测试 68 项
- [x] 多家庭隔离、私人账户、备份恢复、数据删除
- [ ] 独立的测试环境（现在用本地 8445 临时实例；上架前建一个常驻 staging 家庭）
- [ ] 崩溃与错误监控（服务端日志不含金额）
