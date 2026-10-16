# Android 包（TWA，Bubblewrap）

- `twa-manifest.json`：包名 `com.chenfamily.assets`，站点 `https://chen-family424.duckdns.org:8444/`。
- 签名：`keystore/android.keystore`（别名 `family`），密码在 `keystore/password.txt`。**两者都不进 git，务必另外备份**；丢了就无法再更新同一个应用。
- 站点验证：`public/.well-known/assetlinks.json` 里的 SHA256 必须与 keystore 一致（`keytool -list -v -keystore keystore/android.keystore -alias family`）。

重新打包（在 VPS 上，已装 JDK 17 + Android SDK + bubblewrap）：

```bash
cd ~/family/android
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
PW=$(grep '^keystore=' keystore/password.txt | cut -d= -f2)
# 改版本：twa-manifest.json 里 appVersionCode +1、appVersionName 改号
BUBBLEWRAP_KEYSTORE_PASSWORD="$PW" BUBBLEWRAP_KEY_PASSWORD="$PW" bubblewrap build --skipPwaValidation
# 产物：app-release-signed.apk（直接装手机测试）、app-release-bundle.aab（上传 Play Console）
```

把 apk 拿到手机：`https://chen-family424.duckdns.org:8444/` 不提供下载；用 `scp` 或临时放到 nginx 的 `/var/www/html/` 再删除。
