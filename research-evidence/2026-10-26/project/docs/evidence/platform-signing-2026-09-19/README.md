# 跌倒权限与 APNs 接线验证（2026-09-19）

## 已确认

- 用户确认 Fall Detection 已获批；本机 2026-09-17 创建的 Watch profile 含 `com.apple.developer.health.fall-detection=true`。
- 完整 `AEDResponse` Debug 开发签名构建通过。嵌入 Watch 的实际代码签名及 profile 都包含跌倒 entitlement。
- iPhone 正式 target 新增 `aps-environment=development`；Xcode 自动签名已取得含该 key 的新 profile，实际签名一致。ControlledTests 使用独立 Apple-only entitlement 文件，未给离线 TestHost 增加推送能力。
- 完整 App 已安装并启动于 iPhone 17 Pro；这只证明开发签名安装/启动，不代表登录、Watch 授权或远程推送成功。
- 现有 Azure `/healthz` 返回 HTTP 200、status=ok；未部署后端，未核实远端代码版本或推送凭据。

## 本轮修改

- `RemoteNotificationService`：SwiftUI UIApplicationDelegate 接线；全部业务门禁通过后向 APNs 注册，内存接收 token，按 embedded profile 的实际 APNs 环境上传；通知只使用不透明 messageId，经 REST 查询后恢复当前业务状态。离线/受控测试 target 不启动 OS 推送注册。
- `PushRegistrationCoordinator`：只对已认证设备会话上传，token 轮换串行提交，失败在重连/前台重试；断开后旧完成回调不改变当前状态；不将 token 保存到磁盘或打印到日志。
- `APIClient`：接入已有 POST `/me/push-token` 和 GET `/notifications/{messageId}`，使用设备 bearer；拒绝通知 id 中的路径/查询注入字符。
- `AppStore`：在已有门禁、会话生命周期、退出和恢复流程接入推送；通知不能直接接受请求或改变任务。账户退出的服务器 token 清理由既有退出协议负责。
- `project.yml`、工程文件、正式/受控 entitlements、App 入口、相关测试和 smoke 测试过滤表同步。

## 验证

- 完整 iPhone+Watch Debug 签名 build：通过（未使用 CODE_SIGNING_ALLOWED=NO）。
- Watch 独立 Debug 签名 build：通过。
- 最后增量版本完整签名构建通过：`/tmp/aedresponse-push-final-build-20260919.log`。
- `PushRegistrationTests` 4 项 + `APIClientSessionRotationTests` 23 项：27/27，0 失败。
- AppStore 推送会话门禁/退出隔离、旧通知对账 2 项：2/2，0 失败。
- `git diff --check` 本轮涉及的既有文件：通过。
- 实际 profile/签名摘录见 `entitlement-summary.json`。
- 日志：`/tmp/aedresponse-push-build-20260919.log`、`/tmp/aedresponse-watch-signing-20260919.log`、`/tmp/aedresponse-push-tests-20260919.log`、`/tmp/aedresponse-push-integration-20260919.log`。测试为 Simulator 行为测试，不是 APNs 真实送达证据。

## 剩余步骤与阻塞

1. iPhone 上由用户完成 Apple 登录、协议确认和系统权限；尚未取得本次真实登录/设备 token 上传结果。
2. 真实 APNs 发送需要 `.p8` 密钥路径、Key ID 及目标后端的配置。服务端读取 `AED_APNS_KEY_ID`、`AED_APNS_TEAM_ID`、`AED_APNS_KEY_PATH`、`AED_APNS_BUNDLE_ID`、可选 `AED_APNS_ENVIRONMENT`。不得将私钥写入仓库。
3. Watch 列表显示 available (paired)，但实际安装出现 CoreDevice 4000 / RemotePairing 1001 隧道超时，后续只读设备详情也超时。需恢复设备开发连接后再安装/启动/授权/配对。
4. App Attest：profile 同时允许 development/production；开发签名未出现 environment key。Apple 官方说明开发时省略该键默认 sandbox，不能将缺键单独判为配对故障。真实 `isSupported`、证明与服务端验证仍待实机；未删除或绕过验证器。
5. 获批没有改变“跌倒相关不做实测”的既有范围。没有触发真实跌倒、Emergency SOS 或公共紧急呼叫。
6. 下一阶段用已有“上报发现的患者”入口执行受控业务闭环；未取得实际登录与测试设备就绪结果前，不创建真人救助事件。

官方依据：
- [注册 APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns)
- [App Attest 环境默认值](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.devicecheck.appattest-environment)

无提交、推送、PR、服务器部署或数据库变更。保留原有脏工作树和并行 UI 修改。

## 21:51 同网络复查

用户将手表与 Mac 连到同一网络后，实际设备查询确认 `tunnelState=connected`、`developerModeStatus=enabled`，原先网络/开发模式阻塞解除。手表已启动并在重启后解锁，`passcodeRequired=false`。安装仍未成功：CoreDevice 12040，MobileImageMounter `0xe8000076 / Could not support development`，失败于 `/Library/Developer/DeveloperDiskImages/watchOS_DDI` 挂载。本机唯一 Xcode 为 26.6，DDI build 17F113；手表 watchOS 27.0 (24R364)。DDI 本机元数据 isUsable=true 仅证明主机可用，不证明实际设备挂载成功。下一步核对/更新设备支持组件，优先使用对应 watchOS 27 的 Xcode 27；未执行系统/Xcode升级，未重置配对。设备查询证据 `/tmp/aed-watch-same-network.json`。

## 21:58 DDI 深入排查及前述升级建议更正

- Apple Xcode 支持表的 Device Support 与 SDK/Deployment Target 是不同列；26.6 的真机支持列写 watchOS 8 or later。因此不能凭 SDK 26.5 推断必须升级 Xcode/macOS，前节升级建议仅为后续对照方案，未证实根因。
- `xcrun devicectl manage ddis update --no-clean --verbose` 完成，候选镜像与现有集合一致。未使用 clean。
- `xcodebuild -checkFirstLaunchStatus` exit 0；`xcodebuild -runFirstLaunch -checkForNewerComponents` exit 0，返回 `No new updates for 17F113`。
- `hdiutil verify` 对实际报错的 `022-21782-062.dmg` 校验 VALID；BuildManifest SupportedProductTypes 包含 Watch7,20。
- 更底层 CoreDeviceService 日志先出现 copying personalization manifest 0xe8003ffe，然后尝试 fetching new personalization ticket；后续已 ready 的设备隧道 HTTP/2 连接报 Connection reset by peer，最终挂载失败 0xe8000076。日志不足以区分设备端服务异常、链路中断或版本协议问题，不能宣称已证明唯一根因。
- 已请求用户正常重启手表后解锁，以验证临时设备状态；不重置、不重新配对、不关闭安全措施。
- 日志位于 /tmp/aed-ddi-investigation.log、/tmp/aed-ddi-mobiledevice.log、/tmp/aed-ddi-update.log、/tmp/aed-device-support-update.log。诊断包命令失败，仅生成部分本地包，未上传。

## 22:00 手表重启后复测

首次查询遇网络发现延迟；日志随后确认 Bonjour/DNS 解析完成并重新建立隧道。实际安装命令明确取得 tunnel connection 后仍在启用 DDI 时失败，错误与重启前一致：12040 / 0xe8000076，DDI 17F113。重启未解决挂载问题；没有安装成功，不重复配对。可先通过已安装的 iPhone companion 在 Watch App 中尝试安装，单独验证运行（不等于 Mac 调试链路恢复）；若仍失败则以新版开发工具作对照。
