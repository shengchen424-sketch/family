# 上架 Google Play 的路线

目前的应用是一个 PWA（可安装的网页应用），数据放在自己的 VPS。要上 Play Store 有两条路，建议先走 A。

## A. 自家用：TWA 打包（Trusted Web Activity）

适合"给自己家用、顺便放到 Play Store 内测"。不改后端，只是把现在的网页包成 Android App。

前提（缺一不可）：

1. **一个域名**（例如 `family.example.com`）解析到 187.77.128.30。
2. **正式 TLS 证书**（Let's Encrypt 免费）。自签证书的站点 TWA 会直接打不开。
   ```bash
   apt install certbot
   certbot certonly --standalone -d family.example.com   # 需要 80 端口临时可用
   # 然后把 family-assets.service 里的 TLS_CERT / TLS_KEY 指到
   # /etc/letsencrypt/live/family.example.com/fullchain.pem 和 privkey.pem，restart 服务
   ```
3. Google Play 开发者账号（一次性 25 美元）。

打包步骤（在任何一台装了 Node 和 JDK 17 的电脑上）：

```bash
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://family.example.com/manifest.webmanifest
#   应用名：家庭资产   包名：com.yourname.family   其余默认
bubblewrap build          # 得到 app-release-signed.apk 和 app-release-bundle.aab
```

`bubblewrap init` 会生成签名用的 keystore，**务必备份**；丢了就不能更新同一个应用。
它还会打印一段 `assetlinks.json`，要放到服务器的 `https://family.example.com/.well-known/assetlinks.json`
（server.js 已为 `/.well-known/` 预留静态路径，把文件放进 `public/.well-known/` 即可）。

上传 `.aab` 到 Play Console → 内部测试 → 添加家人的 Gmail 为测试者。

## B. 卖给别人：需要改成多用户产品

这是另一个量级的工作，核心差异：

| 现状 | 上架销售需要 |
|---|---|
| 一个家庭一台 VPS，密钥登录 | 账号系统（邮箱/Google 登录）、每个家庭独立数据空间 |
| 数据 JSON 文件 | 数据库（SQLite 起步即可）+ 自动备份 |
| 自签证书 + IP | 域名 + 正式证书 + 隐私政策页面 |
| 无付费 | Play 应用内购买或订阅（Google Play Billing） |
| 种子数据写死马来西亚账户 | 通用的新手引导 |

建议顺序：先把 A 跑通，在家里真用一两个月，确认功能顺手；再决定是否投入 B。

## 隐私政策（上架必填）

Play Console 要求一个公开的隐私政策网址。可以放在 `public/privacy.html`，内容要点：

- 收集的数据：用户自己输入的财务记录和收据照片；不收集设备信息、不做广告追踪。
- 存储位置：用户自己（或运营方）的服务器；传输全程 HTTPS。
- 第三方：汇率来自 open.er-api.com（只请求汇率，不发送任何用户数据）。
- 删除：用户可在应用内导出并删除全部数据，或联系运营方删除。
