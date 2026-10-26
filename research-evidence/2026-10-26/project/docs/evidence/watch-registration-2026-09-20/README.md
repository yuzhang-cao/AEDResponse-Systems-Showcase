## 2026-09-20 Watch 注册与签名刷新复测

Apple Developer 网页已实查手表注册记录，UDID 正确。首次 generic build 仍复用旧 profile；将该缓存文件移至 `/tmp/aed-old-watch-profile-20260920` 保留后，重新执行 `-allowProvisioningUpdates`，成功生成 2026-09-20 01:20:34 UTC 的 Watch profile，包含本表 UDID 且 fall-detection=true。完整 Debug 签名 build 与 codesign --verify --deep --strict 通过，嵌入 Watch 签名也含跌倒权限。

更新后的完整 App 已实际覆盖安装到 iPhone 17 Pro，保留应用数据。产物 `/tmp/aedresponse-registered-20260920/Build/Products/Debug-iphoneos/AEDResponse.app`，日志 `/tmp/aedresponse-profile-refresh-20260920.log`。Mac 直装 Watch 本轮在连接隧道阶段再次报 4000/1001，尚未进入 DDI/安装；不能称 DDI 已解决，也不能用本轮结果判断它仍必然失败。已请用户通过 iPhone Watch App 重试安装，等待实际结果。没有启动跌倒/SOS/救助事件；没有代码修改、提交或部署。


## 09:24 手机实时安装日志与本机签名复查

控制台选择真实 iPhone，筛选 aedresponse。appconduitd 日志显示占位包成功后开始实际包传输，09:24:30 返回 ACXErrorDomain 17 → IXUserPresentableErrorDomain 14 → MIInstallerErrorDomain 13 / 0xe8008017，明确资源签名完整性验证失败。

直接对子 Watch bundle 执行 codesign --verify --strict 复现：file modified: embedded.mobileprovision。独立 Watch 包与嵌入 Watch 包都失败。独立包资源签名文件 mtime=09:19:09，profile mtime=09:20:35；刷新 profile 后增量构建没有重新更新 Watch 资源签名。先前对外层 iPhone 包的 deep 校验不足以替代对子包的显式校验，因此撤回“新包完整签名已验证”的笼统结论。现在以全新 /tmp/aedresponse-resigned-20260920 重建，安装前分别验证三个 bundle 及各 dylib。

## 09:27 全新目录重建与重新安装

/tmp/aedresponse-resigned-20260920 全新构建 BUILD SUCCEEDED。对独立 Watch、嵌入 Watch、外层 iPhone 三个 bundle 分别执行 codesign --verify --strict，全通过；各 bundle 顶层 dylib 也分别通过。两份 Watch profile 均包含目标 UDID，实际签名 fall-detection=true。新完整 App 已安装至 iPhone，databaseSequenceNumber=2728。等待用户再次通过 Watch App 安装，设备端成功尚未确认。签名资源错误在本地产物已修正，Mac DDI 与手表运行状态仍独立验证。

## 09:28 Watch 安装成功

用户确认成功。iPhone 控制台 appconduitd 实时记录 09:28:14.596776 `Setting state to installed for dev.codex.aedresponse.watchkitapp`；09:28:14.597956 `Installation ... acknowledged`；随后 installed state=2，Bridge 枚举已安装 Watch App。这次是实际应用安装成功证据，不是占位包成功。控制台采集已停止。尚未验证启动、用户授权、App Attest/业务配对、跌倒回调或 APNs；Mac DDI 问题未关闭。

## 09:32 Watch 503 根因与本地修复

Watch 已收到 iPhone 封包并调用公网 `/api/v2/watch/session/redeem`，界面报告 HTTP 503。为区分真实证明校验失败与服务器未启用验证器，向同一端点提交格式正确但不存在的探测票据；服务器在查询票据前即返回：`Authentication unavailable` / `WATCH authentication is not configured on this backend`。探测不含真实票据或证明，不创建会话，也不消耗现有票据。

根因是 Azure 初始化链缺少验证器的完整配置：`main.ts` 只有在 `AED_WATCH_APP_ATTEST_APP_ID` 和 `AED_WATCH_BUNDLE_VERSIONS` 同时存在时才构造验证器，但 `backend.env.example` 与 `initialize-env.mjs` 只处理前者。现已在本地补齐 bundle 版本和 App Attest 环境，并让 production 缺任一项时拒绝启动；当前开发签名包对应值为 App ID `[TEAM].dev.codex.aedresponse.watchkitapp`、bundle version `2`、environment `development`。

验证：`npm run check` 通过；配置、发布门禁、Watch attestation、companion-link 定向测试 26/26；环境模板门禁通过；既有完整后端回归 682/682。远端 Azure 配置和服务尚未修改或重启，因此 Watch 当前仍会得到 503。
