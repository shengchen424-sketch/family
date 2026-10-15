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
