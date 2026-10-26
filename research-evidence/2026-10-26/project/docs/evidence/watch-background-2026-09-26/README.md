# Watch / iPhone 持续后台连接修复与非救助证据

日期：2026-09-26。真实源码在 `[PROJECT_ROOT]`。
最新安装：iPhone 与 Watch 均为 version 2.0 / build 4。

## 需求与结论

用户要求：设备仍由系统正常连接时，App 不应因为没有前台打开、锁屏或退后台而丢失业务关联；主链路为 Watch → iPhone → 服务器，独立 Watch 直传仅作备用。

本次已修复传输、授权生命周期和启动接收路径，并安装两台真机。build 3 已出现真实 **iPhone 后台接收 Watch 消息、服务端自动续租、生成并提交后台回复** 的证据。build 4 补上最后一处后台任务收尾顺序保护并再次安装；不能把 build 3 的局部结果当作 build 4 的全量后台验收。

尚未证明双方长时间挂起、系统后台冷启动、临时断线后自动恢复，或任意时刻零延迟可达。Watch 是否全程表盘尚缺用户确认；本次不触发跌倒、SOS、救助事件或外部通知。

## 修复范围

| 已确认的旧实现问题 | 当前实现 |
| --- | --- |
| 只用即时 `sendMessage`，不可达即等待前台重试 | 系统 `transferUserInfo`、受保护持久 mailbox、双向回复恢复；事件观察先入后台队列再尝试即时发送 |
| 手机短期上传租期被当作 Watch 绑定/监控寿命 | 持久身份与短期租期分开；手机使用当前有效 bearer 自动恢复同一绑定，服务器仍拒绝过期或撤销授权 |
| 接收与业务恢复依赖 SwiftUI 前台启动 | AppDelegate 提前接收；watchOS connectivity background task；iPhone BGProcessing 重试入口 |
| 临时网络/5xx 恢复失败导致凭据丢失 | 保留凭据、退避重试；明确401/403仍失效；已轮换但未保存的凭据不重复刷新旧值 |
| 排队/系统传输回执可能被误认成最终业务成功 | 原请求 ID、正文摘要、来源和最终服务器 ACK 分别校验；原事件事实不因传输 ACK 删除 |
| 跨账号/退出后的旧授权或迟到响应污染当前会话 | 单调控制版本、owner摘要、授权代次隔离；明确拒绝持久暂停，同账号重新授权恢复重试 |
| 只用短期实时可达性展示“未连接” | 实时确认与“后台连接”分开；后台配置状态不声称远端此刻有电/即时在线 |
| Watch activation 后台任务先结束、异步恢复后执行的风险 | build 4 将 activation 回调纳入未完成计数，恢复结束后才完成系统任务 |

主要文件：

- `ios/AEDResponse/Services/CompanionBackgroundMailbox.swift`：共享持久协议、队列、身份控制。
- `ios/AEDResponse/Services/CompanionBackgroundScheduler.swift`：系统后台重试。
- `ios/AEDResponse/Services/DeviceServices.swift`、`App/AppStore.swift`、`Services/RemoteNotificationService.swift`、`App/AEDResponseApp.swift`：手机接收、初始化、权限复核与自动授权恢复。
- `ios/AEDResponseWatch/Networking/WatchRelayReporter.swift`、`Services/WatchSystemMonitors.swift`、`Services/WatchPersistence.swift`、`App/WatchRuntimeModel.swift`：手表生命周期、持久身份、后台恢复。
- 共享 Models/Ports、APIClient、RootView/SettingsView/Watch App、project.yml 与生成工程；未更改原始观察内容或独立 App Attest 认证要求。
- mailbox/Watch companion/iPhone authentication/APIClient 回归测试和当前架构/中转契约文档。

## 本地验证

工作与原始日志目录：`/tmp/aed-background-relay-20260926.vSYT1S`。
原始 USB 日志只保留在本机临时目录；本文件仅记方法、状态和时间，不复制账号凭据、位置正文或设备标识。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 独立 SwiftPM Foundation/Watch 逻辑 `swift test` | 46/46，无失败 | `swift-build4.log` |
| 后端 `node --import tsx --test --test-concurrency=1 test/companion-link.test.ts test/watch-relay-http.test.ts` | 19/19，无失败；本地服务，不是线上救助 | `backend-relay-tests.log` |
| generic iOS SDK iPhone+Watch Debug 签名构建 | BUILD SUCCEEDED | `build-signed4.log` |
| generic iPhone XCTest build-for-testing，禁用签名 | TEST BUILD SUCCEEDED；只编译，未运行设备 XCTest | `iphone-tests-build4.log` |
| 手机、嵌入 Watch、独立 Watch 三个 bundle `codesign --verify --deep --strict` | 全部通过 | 命令退出0 |
| 普通 USB `ideviceinstaller install` | InstallComplete 100%；本机查询 CFBundleVersion=4 | `install-build4.log` |
| git diff --check / 源 plist lint | 通过 | 命令退出0 |

无 Simulator、屏幕镜像、DDI、自动紧急事件、服务端部署、提交、推送或 PR。

## 真实设备记录

均为当时设备/服务器所报时间，UTC读数另列；不以墙钟证明传输延迟上界。

1. **22:20:27，build 3 Watch 实装**：appconduitd记 `Finished install`、`Setting state to installed`、`Installation ... acknowledged`；不是仅安装占位符或只检查手机嵌入包。
2. **22:22:47基线**：服务器 Watch `lastSeenAt=13:08:14.529Z`，旧上传租期 `expiresAt=13:21:32.166Z`，已过期；手机最近 bootstrap `13:06:32.166Z`。
3. **22:26:37–22:26:41，build 3**：手机日志先出现前台活跃，然后22:26:38进入后台。22:26:40实际 `didReceiveUserInfo` 路径记录 `background receive method=ping appState=2`；22:26:41记录 `background reply method=ping status=ok appState=2`，并提交 `transferUserInfo` 回复。`appState=2` 是手机后台状态，不是 Watch 前后台证据；OS 提交完成也不是 Watch 应用层已消费回复的证明。
4. **22:28:00只读服务器复核**：Watch `lastSeenAt=14:26:41.029Z`，上传租期恢复到 `14:41:38.868Z`，手机 bootstrap `14:26:38.868Z`。旧过期租期确已自动恢复，不只是旧 UI 绿灯。
5. **22:32:53，build 4 Watch 实装**：真实安装完成、installed、acknowledged；phone查询 CFBundleVersion=4。当前源码额外保证 activation 后台恢复完成前不提前结束系统任务，并记录后台回复 OS 传输结果（不含正文）。
6. **22:34:00只读复核**：仍为上次22:26:41的Watch消息，尚无build 4启动后的新请求证据。事件始终4条历史记录、0条ACTIVE；本轮没有新救助事件。

build 3安装后曾因本地 `plutil -extract ... json` 未指定stdout而改写**临时构建产物**的Info.plist；已通过标准重建重新生成并严格验签。发生在已成功验签/安装之后，不影响当时已安装设备；源码plist没有损坏。当前同一路径是已验签build 4，不可将其当作保留的build 3产物。

## 下一轮非救助操作与验收边界

安装阶段日志已停止；另开仅目标App的10分钟限时日志 `iphone-build4-lock-test.log` 等待用户锁屏，超时自动结束。尚未收到最新build 4锁屏步骤的用户确认；后续先确认日志仍在采集。

- Watch 停在表盘；iPhone 打开更新后的 App 一次，待正常主页面出现后锁屏，不从多任务划掉。先确认这两个前提，避免再把 Watch 前台收发当作双后台结果。
- 先启动仅目标App的普通USB日志，再看 `background receive`、`background reply`、`background response transfer succeeded` 与只读服务器租期/lastSeen；不只看“已连接”。
- 跨上传租期、双方正常息屏/挂起、短暂断线恢复与系统重启后的首次解锁恢复分别验收；不能从一次收发推断永久常驻或零延迟。
- 独立 Watch App Attest 直传仍未通过，不计为已可用备用；本次没有放宽此认证。
- 线上旧基线还缺APNs相关路由等既知部署项，日志中的相关404不是中转ping的200；本轮不擅自部署整个脏后端。

Apple定义：[`isReachable`](https://developer.apple.com/documentation/watchconnectivity/wcsession/isreachable)针对即时消息；[`transferUserInfo`](https://developer.apple.com/documentation/watchconnectivity/wcsession/transferuserinfo(_:))提交后可由系统在App挂起期间继续传输；[`BGProcessingTaskRequest`](https://developer.apple.com/documentation/backgroundtasks/bgprocessingtaskrequest)提供系统安排的执行机会，不保证固定周期或截止时间。
