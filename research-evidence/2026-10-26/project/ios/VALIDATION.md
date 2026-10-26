# AEDResponse iOS/watchOS/backend v2.1 验证记录

## 2026-09-10 P0 route/status/Watch admission/AppStore receipt/storage follow-up

- Backend route authority and status-confirmation use-case/scheduler boundaries were migrated and covered by `route-provider-boundary.test.mts` and `status-confirmation-boundary.test.mts`. Backend final run: `npm test` **183/183**, `npm run test:business` **120/120**, `npm run check`, `npm run build`, and `git diff --check` passed.
- `WatchFallbackAdmissionPolicy` keeps the existing reachability rule as the default and supports an explicit unresolved-business-rule block that preserves pending facts. `DeliveryReceiptUploadCoordinator` now owns receipt upload/retry/ACK orchestration; a cross-AppStore restart test was added. iOS Unit and Watch generic `build-for-testing` passed.
- The two targeted Simulator tests did not produce runtime evidence: CoreSimulator launch returned `NSMachErrorDomain Code=-308 (IPC server died)`. This is recorded as an environment failure, not converted into a pass. No physical Watch or OS-background run was performed in this batch.
- Storage probe `npm run architecture:storage-load` passed on isolated synthetic SQLite. The 50k history case was about 9.82 MB, 287 ms reopen, 67 ms full read, 50 ms entity read, 138 ms no-op transaction, and 1.08 s for eight serialized transactions; these are machine-specific synthetic measurements, not production capacity or SLA evidence.

## 2026-09-10 P0 AppStore event-position fact owner

- `EventPositionFactCoordinator.swift` now owns open slots, candidate fixes, clocked/APP_NOT_RUNNING state, draft restoration, movement calculation, and sealed-slot cleanup. AppStore remains the adapter for service authority, queue I/O, batch ACK/隔离 and UI projection.
- `python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-event-position-fact-runner` passed with **33 Phone + 80 Watch component tests and 2 HTTP/restart stages**. Backend process restart retained terminal/history/outbox state.
- `xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` passed. No physical device or Simulator XCTest runtime was used for this batch.

## 2026-09-10 P0 AppStore event-position participation-window reconciliation

- `EventPositionWindowReconciliationCoordinator.swift` now owns value-level window reconciliation: server-confirmed start/end bounds, quarantine reasons, legal pending-batch regrouping, open-draft isolation and persisted old-context recovery. AppStore persists the returned queue state, applies the open-fact snapshot after a successful write, seals valid pre-end slots and keeps transport/permission gates.
- New tests cover pending records before/after the authoritative window, legal record identity preservation, open-fact snapshot isolation and quarantine reasons. `ArchitectureBoundaryTests` asserts the four window helpers no longer live in AppStore. The final runner `/private/tmp/aedresponse-window-outcome-runner3` passed with **38 Phone + 80 Watch component tests and 2 HTTP/restart stages**.
- `xcodebuild -project ios/AEDResponse.xcodeproj -scheme AEDResponseUnitTests -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO build-for-testing` passed (`/tmp/aedresponse-window-outcome-build-for-testing1.log`); `git diff --check` passed.
- A targeted Simulator XCTest attempt was not counted as runtime evidence: the first named destination did not exist, and the available repair simulator then failed launch with `NSMachErrorDomain Code=-308 (IPC server died)` (`/tmp/aedresponse-window-reconcile-xctest-device.log`). No physical iPhone/Watch or OS-background evidence was attempted in this architecture batch.

## 2026-09-10 P0 AppStore event-position batch outcomes

- `EventPositionBatchOutcomeCoordinator.swift` now owns ACK validation/exact removal and permanent rejection isolation. AppStore persists the returned state before updating its projection; the transport coordinator remains single-flight/retry only.
- New tests cover exact batch removal, mismatched ACK retention, blocked permanent rejection, payload preservation and no-match no-op. `ArchitectureBoundaryTests` verifies that ACK validation and blocked-state construction no longer live in AppStore.
- `python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-window-outcome-runner3` passed with **38 Phone + 80 Watch component tests and 2 HTTP/restart stages**. `xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` passed (`/tmp/aedresponse-window-outcome-build-for-testing1.log`); `git diff --check` passed.
- No Simulator runtime, physical device, OS-background or production notification evidence was generated; the prior CoreSimulator `NSMachErrorDomain Code=-308` remains an environment limitation.

## 2026-09-10 P0 assignment timeout REST authority

- `assignmentTimedOut` Socket handling no longer calls `AssignmentProjectionCoordinator.markTimedOut`; it records a REST-reconciliation hint and preserves the existing assignment projection until the backend snapshot is read.
- AppStore regression coverage asserts that a missing/failed REST event read cannot make the local assignment `TIMED_OUT`; the architecture boundary test asserts the removed writer call.
- Final runner `/private/tmp/aedresponse-assignment-timeout-runner1` passed with **38 Phone + 80 Watch component tests and 2 HTTP/restart stages**. iOS `build-for-testing` passed (`/tmp/aedresponse-assignment-timeout-build-for-testing1.log`); `git diff --check` passed.
- No Simulator runtime, physical device, OS-background or production backend timeout evidence was generated.

## 2026-09-10 P0 status-confirmation callback generation

- `continueCurrentStatusConfirmation` now rechecks account, connection generation, patient active event and `confirmationId` before writing the result or error; `disconnect()` releases the in-flight UI gate.
- Added a delayed-response regression and architecture boundary assertions. Final runner `/private/tmp/aedresponse-status-confirmation-generation-runner1` passed with **38 Phone + 80 Watch component tests and 2 HTTP/restart stages**.
- iOS generic `build-for-testing` passed (`/tmp/aedresponse-status-confirmation-generation-build3.log`); `git diff --check` passed. Simulator runtime and physical-device evidence remain unavailable.

## 2026-09-10 P0 companion-ticket callback generation

- Companion ticket task cleanup and error projection now require the captured connection generation; stale failures cannot overwrite a new session or clear a new ticket task.
- Architecture boundary coverage and the existing reachable-Watch ticket test remain compiled. Final runner `/private/tmp/aedresponse-companion-ticket-generation-runner1` passed with **38 Phone + 80 Watch component tests and 2 HTTP/restart stages**.
- iOS generic `build-for-testing` passed (`/tmp/aedresponse-companion-ticket-generation-build1.log`); no Simulator runtime, physical Watch or real pairing-switch evidence was generated.

## 2026-09-10 P0 auth-refresh callback generation

- LiveSession token-refresh callback now checks captured connection generation, authentication state and current user before persisting a rotated session.
- Architecture boundary coverage was added. Final runner `/private/tmp/aedresponse-auth-refresh-generation-runner1` passed with **38 Phone + 80 Watch component tests and 2 HTTP/restart stages**.
- iOS generic `build-for-testing` passed (`/tmp/aedresponse-auth-refresh-generation-build1.log`); no Simulator runtime, physical device or real token-rotation server evidence was generated.

## 2026-09-10 P0 cold-start auth-restore generation

- Cold-start `refreshSession` now has an independent generation; logout/new login cancels and invalidates old restore tasks before they can save or finish authentication.
- Added a blocking-refresh logout regression and restore-generation boundary coverage. Final runner `/private/tmp/aedresponse-auth-restore-generation-runner1` passed with **38 Phone + 80 Watch component tests and 2 HTTP/restart stages**.
- iOS generic `build-for-testing` passed (`/tmp/aedresponse-auth-restore-generation-build1.log`); no Simulator runtime, physical device or real refresh-service evidence was generated.

## 2026-09-10 架构整改后的最新测试结果

- 后端：在 `[PROJECT_ROOT]/backend` 执行 `npm test`，162/162 通过；`npm run check`、`npm run build` 和 `npm run architecture:storage-load` 通过。存储探针使用隔离临时 SQLite，电脑合成生成历史、通知 outbox 和事件位置批次，重启后计数保持；不代表生产容量或并发 SLA。
- iOS：`xcodebuild -project AEDResponse.xcodeproj -scheme AEDResponseUnitTests -destination 'generic/platform=iOS' build-for-testing` 通过。在线物理 iPhone `[REDACTED_UDID]` 上执行全套 XCTest，最终 **309 executed / 0 failed / 29 skipped**。
- 真机缺陷：首轮测试发现 Watch Keychain 的 `SecItemUpdate` 将 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` 作为更新属性，设备返回 `-25303`，导致受保护观察队列写入失败。修复为“更新只写数据，访问级别只在新增时设置”后，原失败用例单项通过，随后全套 XCTest 通过。
- 证据：失败日志 `/tmp/aedresponse-ios-device-tests-20260910.log`；单项修复日志 `/tmp/aedresponse-ios-device-one-test-fix-20260910.log`；全套修复日志 `/tmp/aedresponse-ios-device-tests-fix-20260910.log`。真机测试期间没有触发真实求助或真实通知。
- 边界：Watch 当前未在线；Fall Detection/App Attest profile、APNs、OS 后台频率、真实路线和生产容量仍未验证。generic build 或 iPhone XCTest 不替代物理 Watch 与正式外部能力验收。
- P0-RECOVERY-01：`DeliveryReceiptQueuePersistenceCoordinator` 新增 blocked 队列恢复入口；保存失败的合法回执不会进入发送队列，也不会被清空，重新认证或连接时先重新读取并合并落盘。定向通用 `build-for-testing` 通过。设备在本批定向测试开始前掉线，故未新增真机运行结果；失败原因记录为 destination unavailable。

历史基线：2026-09-04；最新 UI 工作树复验：2026-09-06（Asia/Shanghai）

## 2026-09-06 附近待命人数增量

- 已新增默认列表与可切换的范围地图，后端仅返回 1/1.5/2 公里内的累计匿名人数；真实位置/身份不发给查看者。详情见 [附近人数批次记录](../docs/nearby-volunteers-validation-2026-09-06.md)。
- 后端纯业务 72/72、新模型 macOS XCTest 7/7、`npm run check`、TestHost generic build-for-testing 和 Production Release 构建通过。
- 新增 UI 流程及 API transport stub 用例只完成编译，尚未在 iPhone 执行。用户禁止有线，当前无线设备不可用；不得将下文旧批次 11/11 的真机结果当作本增量已验收。

## 2026-09-06 已批准 UI 批次

- 在物理 iPhone 17 Pro / iOS 27.0 上重新编译、安装和执行新版 TestHost。最终 Tests：177 通过、11 项源码架构检查按设计跳过、0 失败；最终 UITests：11/11 通过、0 跳过。
- 证据：`/tmp/aedresponse-ui-unit-final-20260906.xcresult` 与 `/tmp/aedresponse-ui-physical-20260906-v4.xcresult`。已查看实机主场景、设置、患者两种确认、唯一响应者第三次确认和 AED 目的地切换截图。
- generic TestHost build-for-testing 与生产 Release generic iOS 构建通过；不能把 Release 编译当作生产登录或联网实机验收。
- 患者最新要求为“误报”和“结束救助”分开、各一次确认；下文旧快照中的“单一结束按钮/原因选择尚未实现”已被本次要求替代。响应者退出三次确认已通过本地实机流程，真实服务器 ACK/撤权联调仍暂停。
- 没有使用 Simulator。服务器接收、真实手机号/Apple 登录、真实 Ping、蜂窝公网、Windows/Azure 与物理 Watch 验证继续暂停；本次导航仅为离线 Canvas 示例。
- 详细改动、早期失败原因和重跑结果见 [本批 UI 验证记录](../docs/ui-validation-2026-09-06.md)。其余 UI 按用户要求留到后端测试后再调整。

## 验证边界

本记录严格区分源码/契约检查、SDK 构建、Simulator 基础设施、物理 iPhone XCTest、物理 Watch 和真实多设备网络联调。任一层通过都不替代下一层证据。

后续需求已改为公网 HTTPS/WSS 与蜂窝数据传输。下文已有的私网绑定和 LAN 检查仅是历史开发证据，不满足新的广域网验收；当前仍未配置生产短信/Apple 验证器、公网入口或中国大陆生产资源。

## 2026-09-05 当前工作树复验

- 后端 `npm run check`、`npm test`（85/85）和 `npm run build` 通过。覆盖手机号/Apple 认证端口、稳定 `userId`、refresh rotation、四项同意、Watch companion-link/App Attest 验证端口、1/1.5/2 公里动态招募、30 秒 offer、患者优先时间边界、严格事件位置批次、V2-A11/A12 状态机、16 KiB 边界及异常熔断。
- OpenAPI 3.1 通过系统 Ruby/Psych 解析：30 paths、62 schemas、31 个唯一 operationId、182 个内部 `$ref` 全部可解析；contracts JSON 全部可解析。
- `xcodegen generate` 通过；`AEDResponseTestHost` 的 generic iOS `build-for-testing` 通过，只证明测试 bundle 可编译。最终修改后的 `AEDResponse` Release generic iOS production scheme 已复跑通过。
- 最终修改后的 `AEDResponseWatch` Release generic watchOS 构建通过；同日更早的 Watch generic `build-for-testing` 亦通过。这些结果从不替代物理 Watch 验证。
- 当前 iPhone 已实现手机号/Sign in with Apple 登录、Keychain session、四项同意和 Always+精确定位/通知门禁；候选接受前只解码/显示通用事件类型、距离/ETA 分桶、搜索半径与有效期。Socket.IO 客户端业务写入已移除，delivery receipt 使用 REST 待重试队列。V2-A17 事件位置批次已接入：真实一秒槽、按真实 `CLLocation.timestamp` 跨秒分组、同秒取最新合格 fix、`slotAt`/`fixObservedAt` 分离、`NO_FIX`/`APP_NOT_RUNNING` 缺口、开放草稿安全持久化与 5 秒重启 grace、五秒/五条窗口、累计 10 米提前封口、稳定 batch/record ID 与受保护离线队列。记录在批次首次提交时即永久封口，ACK 只允许删除本地重试副本；封口 slot 不创建 correction，待命/搜索圈仍走最新值接口。
- 当前后端保证已收事件位置记录的跨批唯一性和 append-only，但尚无 `stream-finalized`/`sync-complete` 信号，因此尚未实现全参与窗口的跨批次最终完整性审计，不把乱序重试中的临时缺口写成最终缺口。
- `EmergencyEvent.canPublishEventPosition` 已作为严格必填服务端权限消费；主患者/已接受响应者为 `true` 才采样，次 iPhone 患者视图与终态为 `false` 时保持零事件位置调用。
- iPhone 已实现并编译状态确认 Socket 提示、REST `CONTINUE`、患者界面和 `CLOSED_UNCONFIRMED_NO_RESPONSE` 终态；患者单一结束 UI/原因 + `/end` 与响应者 `/exit` UI/API 仍未实现。
- 当前 Watch 已实现一次性 companion ticket、App Attest 适配端口、受保护 session/outbox、120 秒 Fall 问答语义、Fall+35 分钟重试、24 小时最小去重，以及在 iPhone 不可达且 Watch 有 WAN 时的 5 秒/10 米 fallback 调度。
- 本次没有运行任何 Simulator，也没有启动、同步或修改 Windows 后端、计划任务、隧道、云资源或公网入口。
- Windows 只读核对确认远端仍为旧 v2.1 测试清单，`backend/src/auth.ts` 不存在，端口 8787 无连接/监听；本批认证、动态招募与隐私投影只在 Mac 工作树中完成。连接仅使用 Tailscale SSH 管理路由且校验了既有 ED25519 host key，没有把该链路用于 App 数据。
- 当前 Xcode 登录的 Personal Team `GR6YBCDW7R`、Apple Development identity 和覆盖 iPhone 17 Pro 的 profiles 均有效；证书名称（CN）括号中的 `H463W287GN` 不是 Team ID，强制把它当作 `DEVELOPMENT_TEAM` 才会出现 `No Account for Team`。证书 subject 的 `OU=GR6YBCDW7R` 与签名 App 的 `TeamIdentifier=[TEAM]` 才是当前 Team 证据。`xcrun devicectl list devices` 已显示 iPhone 17 Pro 为 connected，且 Xcode destination 可用；其他 iPhone 和物理 Watch 仍不构成本轮可用目标。
- 首次正确 Team 真机运行在桌面 DerivedData 因 File Provider `FinderInfo`/xattr 无法 codesign；改用 `/tmp` 后 TestHost 已成功签名、安装并启动。它在 XCTest 连接前因 TestHost Info.plist 未声明后台定位、源码却无条件设置 `allowsBackgroundLocationUpdates=true` 而触发 Core Location `NSInternalInconsistencyException`；该次诊断保存在 `/tmp/aedresponse-xcdiag-20260905-1553`。`DeviceServices.swift` 已修为仅在当前 bundle 声明 `UIBackgroundModes/location` 时启用，随后真机重跑已跨过该启动崩溃并实际进入 XCTest。
- 首轮物理 iPhone 结果曾为 `Failed`：172 total / 135 passed / 26 failed / 11 skipped，证据为 `/tmp/aedresponse-iphone-physical-20260905-1605.xcresult`。这些失败暴露并修复了真机资源路径、异步 REST 屏障、严格一秒槽时间锚、assignment revision、患者优先批次竞态、Socket payload、日期精度和 Watch fallback 测试快照等问题。
- 最终物理 iPhone unit 结果为 `Passed`：172 total / 161 passed / 0 failed / 11 skipped；11 项均为必须读取 Mac 仓库源码的 `ArchitectureBoundaryTests`，在真机 bundle 中按设计跳过。证据：`/tmp/aedresponse-iphone-physical-final-20260905-1643.xcresult`。
- 最终物理 iPhone UI 结果为 `Passed`：4 passed / 0 failed / 0 skipped，覆盖四项协议、患者自动进入、`FETCH_AED` 的 R→A→P/AED 获取状态，以及 TestHost 患者/响应者预览切换。证据：`/tmp/aedresponse-iphone-ui-physical-20260905-1638.xcresult`。

以下 2026-09-04 章节只保留为旧 v2.1 快照，不能替代上述当前工作树和后续真机/公网验收。

## 环境

- macOS 26.5.2（arm64），Xcode 26.6（17F113），XcodeGen 2.46.0。
- 物理 iPhone：曹煜璋的 iPhone，iPhone 17 Pro，iOS 27.0。
- 物理 Watch：Apple Watch Series 11，已配对；当前仍不是 Watch scheme 的可用 Xcode destination。
- Windows：Windows 10 build 19045，Node.js 18.20.7，npm 10.8.2。

## 后端与契约

### Mac

在 `backend/` 执行：

```text
npm run check  PASS
npm test       PASS 50/50
npm run build  PASS
```

覆盖范围包括账号限权 session、四项同意、Watch/iPhone pair、Watch observation 幂等、iPhone R/P 与 presence、位置时效/精度/半径边界、患者优先、N=1...5、R→A→P、`AED_ACQUIRED`、`AED_UNAVAILABLE`、误报/显式结束、REST/Socket 重连恢复、SQLite 持久化/回滚/旧 JSON 迁移，以及 Watch 一次性问答、120 秒触发窗口、35 分钟 outbox、5 秒/10 米 WAN fallback、来源优先级与竞态。

### 契约

- `contracts/openapi.yaml`：OpenAPI 3.1，可解析；19 paths、42 schemas、20 个唯一 operationId、118 个内部 schema ref 全部可解析。
- `contracts/safety.json`、`contracts/positioning-policy.schema.json`、`contracts/fixtures/demo-scenario.json`：JSON 解析通过。
- `PatientPosition` 的 `source` 明确区分 `WATCH_TRIGGER_SNAPSHOT`、`IPHONE_PRIMARY`、`WATCH_FALLBACK`；事件上的 P、source 与对应时间字段保持同有/同无。
- 定位策略明确后端 10 秒来源仲裁与 Watch 5 秒位置调度；没有把 5 秒写成后台系统保证。

## Windows v2.1 同步

- Live：`C:\Users\REDACTED\Documents\AEDResponseBackend`
- 备份：`C:\Users\REDACTED\Documents\AEDResponseBackend\.deploy\backups\20260904-110735`
- Staging：`C:\Users\REDACTED\Documents\AEDResponseBackend\.deploy\staging\20260904-110806`
- 后端版本：2.1.0。

staging 和 live 均通过：

```text
npm ci          PASS
npm run check   PASS
npm test        PASS 50/50
npm run build   PASS
better-sqlite3  PASS, SQLite 3.49.2
```

在该次部署验证时，Mac、staging、live 的 29 个同步源文件逐项 SHA-256 一致；当时的规范 manifest SHA-256：

```text
fe4a1d67994e2dac513be062185eb5382ad7184cd256bcb0ba3c2ac7cee8cec2
```

后续蜂窝/WAN需求修订仅存在于本地 canonical 文档，尚未同步到 Windows；因此上述 hash 只代表上一轮部署快照，不代表当前本地文档与 Windows 仍完全相同。

第一次 staging `npm ci` 受 Windows 用户配置中失效的 `127.0.0.1:10809` proxy 影响；最终仅在该安装命令进程内禁用 proxy 后成功，没有修改用户或全局 npm 配置。

数据与运行状态保护：

- 首次源码同步期间，`.data/state.json`、`.data/state.json.bak`、`.run/backend.pid` 和两个既有 log 的 length、mtime、SHA-256 均未变化；当时没有启动 live 服务。
- 后续联调准备在 `.deploy/backups/20260904-120740-pre-e2e` 保存了数据、运行记录、日志、任务 XML 和 manifest 快照。
- 服务曾由现有脚本短暂绑定 `[REDACTED-HOST]:8787`，脚本自身 `/healthz` 校验为 ok；用户随即要求暂停，尚未发送 iPhone 业务请求，服务立即停止。
- 该首次启动按设计从旧 JSON 导入 SQLite：metadata 为 storage format 1、schema 2.0、revision 1，`quick_check=ok`；2 AED、3 devices、3 sessions、1 event、1 delivery、1 timeline 的 ID 与旧 JSON 一致。旧 JSON 未变，没有新增业务记录。
- 只读 WAL 检查没有改变主数据库或 WAL 哈希，但 SQLite 协调会更新瞬态 `state.sqlite-shm`；因此不声称所有 `.data` 文件字节完全不变。
- 最终计划任务 `AEDResponseBackend-v2-Development` 为 `Ready`，无后端 Node、无 TCP 8787 listener、无 PID 文件。未修改计划任务、autostart、trigger 或防火墙。

## XcodeGen 与构建

- `xcodegen generate`：通过，`ios/project.yml` 仍是 canonical 工程源。
- `AEDResponseTests` 的 `build-for-testing`：通过，仅证明测试 bundle 编译；定向覆盖响应 offer 隐私投影、`response:offer-expired` 匹配清除、REST receipt 失败留队，以及事件位置批次的 1 Hz 槽、`NO_NEW_FIX`、5 秒/5 条、10 米提前、离线保留、终态迟到 ACK 与受保护队列损坏保护。
- `AEDResponse`，`generic/platform=iOS`，unsigned：通过。
- `AEDResponseWatch`，watchOS device SDK，unsigned：通过；仅证明设备 SDK 编译，不代表签名安装或物理 Watch 行为。
- Watch 构建仅有 `ONLY_ACTIVE_ARCH=YES` 配合多个 ARCHS 的警告；此前无效的 `@preconcurrency` conformance 警告已消除。

历史 Simulator test runner 曾停在 worker materialization/系统运行时阶段，没有进入完整断言。本阶段不运行 Simulator destination/test，也不把 build-for-testing 写成测试通过。

## 物理 iPhone XCTest

签名使用本机已有 Personal Team profile 临时取得 Team 设置；Team 未保存或写入工程。最初在桌面 DerivedData 中签名失败，原因是 macOS File Provider 给生成的 framework 添加了 FinderInfo/fileprovider xattr。将 DerivedData 放到 `/tmp` 后正常完成签名、安装和 XCTest。

最终结果目录：

```text
/tmp/aedresponse-device-v21-final.z4UNc7/Logs/Test/
```

结果：

```text
testTerminalSocketQueuesImmediateRestoreWhileInitialRestoreIsInFlight
1 passed / 0 failed / 0 skipped

AEDResponseTests full suite
100 total / 90 passed / 10 skipped / 0 failed
```

10 个 skip 都属于 `ArchitectureBoundaryTests`：这些测试需要读取 Mac 仓库源码，真机 bundle 明确跳过。其余 90 项在 iPhone 17 Pro / iOS 27.0 上实际执行并通过，包括 Watch fallback coordinator/API、iPhone R/P、登录账号 session、自动角色、分配公式、AED 回执、误报撤销、恢复不自动结束，以及 REST/Socket 收敛竞态。

## 物理 iPhone UI 自动化

当前共有 4 条 UI 流程，覆盖：

- 首次使用分别签署患者/响应者协议且无角色选择器；
- 后端激活后自动进入患者态且无手动 SOS/时间线；
- `FETCH_AED` 的 R→A→P 和 `AED_ACQUIRED`；
- TestHost 患者与响应者预览切换。

用户明确选择卸载手机上的 MahjongTing 开发版后，`AEDResponseUITests-Runner` 已成功安装。首次真机全套实际执行为 3 passed / 1 failed；唯一失败是测试把 SwiftUI identifier 限定为 `Other`，而真机 accessibility hierarchy 将同一 identifier 暴露在子元素上。测试改为按稳定 identifier、跨 element type 查询，没有修改产品逻辑。

修复后的真机结果：

```text
testTestHostCanSwitchFromPatientToResponderPreview
1 passed / 0 failed

AEDResponseUITests full suite
4 passed / 0 failed / 0 skipped
```

保留的 xcresult：

```text
/tmp/aedresponse-device-v21-final.z4UNc7/Logs/Test/
Test-AEDResponseTestHost-2026.09.04_12-03-48-+0800.xcresult
Test-AEDResponseTestHost-2026.09.04_12-05-04-+0800.xcresult
```

在该 2026-09-04 历史快照中，手机上的三个 Personal Team 开发 App 为 AEDResponse TestHost、AEDResponseUITests-Runner 和 KeepOne；Xcode Accounts 当时为空，安装依赖缓存的 7 天 profile。这不是 2026-09-05 当前账号状态，当前状态以本文首节为准。

## 物理 Watch 与 Apple 能力门槛

- CoreDevice 能看到 Apple Watch Series 11 为 available/paired，但 `AEDResponseWatch -showdestinations` 仍把它列为 ineligible，原因是 unknown architecture。
- 没有当前源码的物理 Watch signed install、`CMFallDetectionManager` 授权、真实 Fall 回调、WatchConnectivity 断连场景或真实 Emergency SOS → `CXCallObserver` 观察证据。
- Personal Team 不支持 Fall Detection Notifications capability。需要 Apple Developer Program Team，并由 Apple 单独批准 `com.apple.developer.health.fall-detection`。工程 entitlement 声明、Apple 账号登录、Simulator 或 unsigned device SDK build 都不是批准证据。
- Watch 5 秒 fallback 调度只在 App 进程获得执行时间时成立；没有 extended runtime 或已冻结的后台策略，不能声称息屏/挂起时严格 5 秒。

## 尚未验证

- Windows 在联调准备阶段短暂绑定 `[REDACTED-HOST]:8787`，但用户随即要求暂停测试，未发送 iPhone 业务请求；服务已停止。因此尚未完成真实 production iPhone CoreLocation → Windows live SQLite → 距离筛选/任务编排 → Socket.IO → 多台真实 iPhone 的现场闭环。
- 公网域名/TLS 入口与 Windows 安全回源尚未部署；关闭 Wi-Fi 的物理 iPhone 尚未通过蜂窝数据完成 R/P、WSS 通知和网络切换重连。历史 LAN base URL 不再是最终验收目标，iPhone 也不得依赖 Tailscale。
- App 挂起/终止后的招募通知；当前没有 APNs。
- pair proof/App Attest、TLS、滥用防护，以及正式的位置 retention、降精度、访问审计和删除策略。
- 真实 Emergency SOS 是否会被 `CXCallObserver` 稳定暴露；没有触发任何真实紧急电话，模拟 observation 不替代此证据。
- 已冻结但尚未全部实现：高德 300 秒绕行与改道确认、患者结束与响应者退出的 iPhone UI/API 接入、APNs、分层留存/hash chain、生产数据层及 P20 压测。响应者禁止重入与 T+30/T+35 后端状态机已经实现；事件位置批次在锁屏/挂起/终止后的系统调度、断网/重启/身份切换真机验收仍待物理设备与后端环境，本批不启用 extended runtime。30 秒 offer、Socket 只读、动态招募圈和高并发验收目标已不再是待确认项。

## 两台 iPhone 蜂窝联调预检（2026-09-04）

- 角色已选定：iPhone 17 Pro / iOS 27.0 为患者，iPhone 16 / iOS 18.7.8 为响应者；两台均连接 Xcode 且 Developer Mode 可用。
- 用户重新登录 Xcode Apple Account 后，自动签名生成的新 profile 同时包含两台设备。iPhone 16 已由用户完成首次开发者信任。
- 两台均安装了 iPhone-only live 构建。该构建使用当前 production iPhone REST/Socket.IO 源码，但不嵌 Watch、不含 `demo-scenario.json`/OpenAPI fixture、没有 `AEDRESPONSE_TEST_HOST` 或本地场景符号；canonical 项目文件未为此修改。
- live app 签名验证通过。iPhone 16 与 iPhone 17 Pro 均成功启动过；切换公网方案后两个进程均已终止，避免继续重试旧 LAN 地址。
- Windows 在 LAN 方案下短暂启动，但 SQLite 未出现本轮指定的两台 device ID，没有 bootstrap、R/P 或事件记录；随后服务停止。
- 用户明确禁止用 Tailscale 作为业务跳板。准备蜂窝方案时曾短暂产生 Funnel 配置，但在任何 App 请求前已经 reset；最终 handlerCount=0、status 为空。Tailscale 只保留开发者 SSH 管理用途。
- Windows 业务网卡为私网 IPv4 `[REDACTED-HOST]/20`；netcheck 显示 IPv4 位于映射随目标变化的 NAT 后，UPnP、NAT-PMP、PCP 均不可用，原生 IPv6 不可用。唯一全局形式 IPv6 是 Teredo tunnel，默认网关的 HTTP/HTTPS 管理端口均超时。当前没有可供蜂窝网络直接访问的域名、可信 HTTPS、端口映射或原生公网地址。
- 结论：两机安装与签名已就绪，但真实蜂窝端到端请求尚未发生。继续测试需要用户指定公网服务器，或为 Windows 提供不依赖 Tailscale 转发的可控公网 HTTPS 入口。

## 结论

v2.1 的源码、契约、Mac 后端、Windows 安装态、物理 iPhone 单元/领域/契约测试及 4 条 TestHost UI 自动化已经通过，Runner 已安装。两台 iPhone 的 live 签名安装也已完成，但蜂窝公网入口缺失，尚未产生真实前后端业务请求。Windows 当前安全停止；公网网络闭环、物理 Watch entitlement/安装/后台行为仍是明确的外部验收门槛。
