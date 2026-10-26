# AEDResponse 公网服务器实机集成验收报告

> 阶段记录：2026-09-08，Asia/Shanghai。当前仅验证 iPhone 17 Pro；用户明确
> 暂不处理 iPhone 16。最新结论：自动业务连接缺口已修复，15:50–15:54 完成
> 真实蜂窝网络下的前台待命 R 上传观察。历史问题和阶段记录保留，但以最新
> 结果与第 9、10 节为准；没有把待命 R 当成患者事件 P 验收。

## 最新：连接已修复，真实位置已入库（15:39–15:54）

### 权限与修复

15:39 在 17 Pro 上直接读取的系统状态：Always=3，精确定位=0（Full）、
通知=2（Authorized），通知提示/声音=2，后台刷新=2（Available），
蜂窝限制=2（NotRestricted）。NWPath satisfied=true、cellular=true、wifi=false。
App 的 authenticated / agreementsComplete / businessAccessReady 均为 true，
但修复前 connectionState=disconnected。用户原有权限确实已开启，未修改开关。

本轮用户要求“马上搞好”后进行了最小连接修复：

- `AppEnvironment` 仅为正常联网构建启用自动连接；离线 TestHost 保持关闭，
  单元测试用显式注入开关验证该行为，不绕过任何权限。
- `AppStore` 在身份、四项协议、通知和 Always+精确定位全部满足后调用既有
  `connect(baseURL:)`。首次失败沿用已有退避重连；前台/权限回调不会重复
  bootstrap；注销或撤权会取消待执行/在途自动连接。
- `LiveSession` 在 bootstrap 返回后检查取消，避免注销后迟到结果重新打开
  Socket。没有改服务端、账号、事件或位置业务定义。
- 新增 6 项自动连接回归，另运行之前新增的 Keychain round-trip，共 7/7
  在 17 Pro 通过。随后整个 iPhone 单元测试为 **209 项：193 通过、16 跳过、
  0 失败**。跳过项为 11 个需本机源码的边界检查和 5 个未 opt-in 的独立公网
  诊断；不是 209 项全都实际执行成功。
- 普通 UI Runner 的现有 profile 不包含此设备，最初组合 scheme 构建被阻塞。
  在 canonical `project.yml` 增加仅运行单元测试的 AEDResponseUnitTests scheme，
  没有改 profile、创建证书或恢复特殊权限。普通 App 签名安装正常。
- 正常 Release generic iOS/watchOS 编译通过（未签名），修复版 ControlledTests
  已真实签名安装到 17 Pro；不是只编译或模拟器结果。

### 实际通信顺序

```text
15:50:45  NETWORK_PATH cellular=true / wifi=false / satisfied=true
15:50:46  AUTOMATIC_CONNECTION_START
15:50:46  POST /api/v2/session/bootstrap → HTTP 201（109 ms）
15:50:46  SOCKET_CONNECTED
15:50:47  SERVER_READY_RECEIVED
15:50:47  APP_PERMISSION_GATE connectionState=connected
之后       PUT /api/v2/me/responder-position → HTTP 200 → POSITION_ACK
```

后端 15:50:46.205 创建/绑定设备 `REDACTED-ID-7a84f23aad91cf92`，
对应原来的 userId `REDACTED-ID-4b0f37dea05bc146`，没有新建第二个用户。
runtimeRole=NEUTRAL，position.kind=R，eventId=null。

### 4 分钟观测统计

观察器从 15:50:43.003 至 15:54:43.478 只读同一业务 SQLite。

| 指标 | 结果 |
| --- | --- |
| 第一条服务器接收时间 | 15:50:47.538 |
| 最后一条服务器接收时间 | 15:54:42.172 |
| 持久化更新/唯一更新 ID | 217 / 217 |
| 对应客户端发送/成功 ACK | 217 / 217 |
| HTTP 结果 | 217 次 200，无客户端请求失败 |
| 平均接收间隔 | 1.0863 秒 |
| 最大接收间隔 | 11.720 秒，启动阶段 |
| 大于 2 秒的间隔 | 3 次，均在启动前约 23 秒内 |
| 后续 213 条区段 | 平均 1.0013 秒，最大 1.121 秒 |
| 平均位置请求往返时间 | 143.26 ms |
| 幂等重复/过期拒绝 | 0 / 0 |
| Socket 建连/断连 | 1 / 0 |
| SQLite 最新坐标快照逐字段匹配 | 216 / 216，无串 user/device；另一条已被更新覆盖，但有持久化 receipt |

长间隔对应相同的新 fix 时间间隔；下一 fix 到服务器接收约 56–81 ms，且没有
超过 1 秒的 HTTP 请求。从现有证据看是启动阶段新位置样本产出间隔，而非
已发送请求丢失；这不证明每个 Core Location 原始回调都被完整审计。

业务库按待命规则只保存最新 R 和有界幂等回执；完整 4 分钟对照来自用户批准
的本次 Debug/只读观察日志，不是新增的普通用户轨迹档案。SQLite 完整性为 ok。

**另发现的未修复需求差异：** 普通待命应为 120 秒或移动 100 米更新；本次
实际近 1 Hz，客户端 latest-only 上报还缺 cadence 控制。因此传输接通已验证，
但“全部定位需求达标”仍不能通过。本次没有顺带更改已冻结的频率规则。

证据：`/tmp/aedresponse-17pro-validation.8BaVWL/autoconnect-live.log`、
`autoconnect-server.jsonl`、`autoconnect-summary.json`；真机单元结果
`/tmp/aedresponse-autoconnect-full-unit-20260908.xcresult`，针对性结果
`/tmp/aedresponse-autoconnect-unit-only-20260908.xcresult`。日志包含本人精确位置，
不包含 token，不能对外发布整个证据目录。

## 15:31 核对更新：协议已签，业务连接入口缺失

- 14:45 从 17 Pro 当前 App 容器只读取得 preferences，当前受控 userId 的四项
  协议均为 v2.0，实际 acceptedAt 为 `2026-09-08T06:27:43.352Z`（14:27:43 CST）。
  **并非用户未签署，不需要重复签署。** 不能根据服务器尚无请求就推断协议未签。
- 手机真实 App 之前已完成 Azure HTTPS 刷新 200；没有证据说明用户关闭了网络。
  但这不替代对当前蜂窝/定位/通知等每个系统开关的直接读取。
- 已确认客户端接线缺陷：`AppStore.connect(baseURL:)` 在 App 源码中没有调用方；
  调用都来自 XCTest。`finishAuthenticationRestore` / `maybeActivateBusinessServices`
  只恢复身份、注册监听等；当前 Settings 只提供 Ping，并不建立设备会话。
  所以即使权限齐全，正常 UI 路径仍不会 bootstrap / Socket connect / 上传位置。
  这与 14:44 服务器仍只有账号会话、没有 devices/位置的事实一致。
- 14:28–14:38 的 600 秒只读观察结束：deviceCount=0、receiptCount=0。它不构成
  有效的持续定位测试窗口，不能解释为定位权限关闭或“没有丢包”。
- 系统权限直接读取未得到有效结果，随后 CoreDevice 连线不可用。15:31 再查
  17 Pro 为 unavailable、ddiServicesAvailable=false，最后连接约 14:50。
  这表示 Mac 调试连接中断，**不等于手机没有网络**。定位 Always、精确定位、
  通知、后台刷新和蜂窝限制的当前实值均保持“尚未确认”，不标为关闭。
- 只补充了 opt-in 的只读权限快照（`AED_PERMISSION_SNAPSHOT=1`），不调用
  requestAuthorization 或改开关。generic iOS 签名构建通过；由于手机离线，
  该快照版尚未安装/运行。没有在本轮修复业务连接缺口或改动任何系统权限。
- 下一步：设备恢复后读取快照，再按用户确认的范围修复业务连接接线并重测。
  原始证据为 `/tmp/aedresponse-17pro-validation.8BaVWL/current-preferences-1444.plist`、
  `permission-check-device-state.json` 与 `server-observation.jsonl`；不公开整个
  preferences 或凭据文件，只引用必要字段。

## 1. 当前架构

| 环节 | 实际实现与已核对内容 |
| --- | --- |
| iPhone | Swift 6 / SwiftUI；Core Location；URLSession REST；Socket.IO Swift 16.1.1 / Starscream 4.0.8 |
| REST | `https://redacted-host.invalid/api/v2/`；账号刷新、设备 bootstrap、P/R、位置批次与任务状态均为原业务接口 |
| 实时通信 | 同一 HTTPS origin，默认 `/socket.io/`；polling/WebSocket，服务端通知，REST 为业务单写与对账来源 |
| 入口 | Azure 公网 IP `[REDACTED-HOST]`，Caddy 80/443，可信 TLS，反代 loopback 8787 |
| 后端 | Node.js 24.18.0 + TypeScript，Node 原生 HTTP server（不是 Express），Zod，Socket.IO 4.8.3 |
| 存储 | better-sqlite3 11.10.0，`/var/lib/aedresponse/state.sqlite`；单进程内存快照写回，不支持多个独立写进程 |
| 身份 | 正式 PHONE/APPLE 验证器仍暂停。本轮使用用户批准的 CONTROLLED_TEST，仅替代首次会话建立；正常刷新、短期设备会话和业务校验不变 |
| 模型 | users/accounts、设备与配对、账号/设备 session、events、deliveries、assignments、latestPosition、位置幂等 receipts、事件逐秒 position batches |

17 Pro 只有在合法 Watch 触发、后端事件成立后才是 Patient。没有手动 iPhone
创建事件入口，不为测试伪造 Fall/SOS、Patient 或响应者身份。待命 R 上传即使
后续通过，也不能代替患者 P/事件批次通过。

## 2. 当前服务器部署状态

- `aedresponse.service`、`caddy.service` 均 active；后端 PID 在本轮账号初始化
  重启后为 20103，以独立 `aedresponse` 用户运行。
- WorkingDirectory：`/opt/aedresponse/current/backend`。
- ExecStart：`/opt/node/bin/node --max-old-space-size=256 dist/src/main.js`。
- 后端仅监听 `127.0.0.1:8787`；Caddy 管理口 `127.0.0.1:2019`，公网 80/443。
- 环境文件 `/etc/aedresponse/backend.env` 保持原内容。实读白名单：
  NODE_ENV=production，SESSION_TTL=900 s，POSITION_MAX_AGE=600 s，
  MAX_CLIENT_CLOCK_SKEW=120 s，MAX_POSITION_ACCURACY=200 m。
  pepper 已配置，operator token 未配置；没有输出任何密钥值。
- 环境中的旧 `AED_NEARBY_RADIUS_METERS=3000` 在当前 service 中没有消费点；
  实际动态招募半径使用 `[1000,1500,2000]` 常量。没有据此擅自修改配置。
- 本轮安装 `aedresponse.service.d/controlled-test.conf`，受控账号开关 true。
  未开放匿名业务 API 或公共测试登录接口。
- 数据库 integrity_check=ok。创建受控账号前备份：
  `/var/lib/aedresponse/backups/before-iphone17pro-account-20260908-1413.sqlite`。
  CLI 只在业务服务停止时写入；随后正常重启，没有恢复旧库或删除业务数据。
- 公网 Mac 直连复测（显式不使用本机代理）：HTTP 200、TLS verify=0、
  remote_ip=[REDACTED-HOST]、约 391 ms。这不是手机蜂窝验证。
- 真实 App 自身 HTTPS 刷新已成功，见第 5 节。没有忽略 TLS 验证。
- 日志：`journalctl -u aedresponse.service`。现有后端没有每条业务请求的
  结构化日志，因此本轮另用只读 SQLite 观察器，与客户端请求/ACK 交叉核对。
- Caddy 仍有先前 `__native-cellular/20260908-native-1131/*` 诊断路由指向
  8788；本轮监听清单无 8788。它不承载 `/api/v2/`，不计本轮证据；记录为
  旧诊断配置清理项，本轮未启动该服务或使用旧回显通道。

## 3. 实际测试环境

| 项目 | 实测状态 |
| --- | --- |
| 手机 | 物理 iPhone 17 Pro，iOS 27.0 beta / 24A5430a，Developer Mode enabled |
| 设备 UDID | `[REDACTED_UDID]` |
| CoreDevice ID | `REDACTED-ID-1b2244d3fb512e43` |
| 开发连接 | 14:08 起 wired、tunnel connected，passcodeRequired=false；不是业务链路类型证明 |
| App | `AEDResponseControlledTests` Debug，展示名 AEDResponse Tests，2.0 / build 3，bundle ID `dev.codex.aedresponse.testhost` |
| App 来源 | 当前正式手机源码，仅首次受控会话导入例外；未包含 AEDRESPONSE_TEST_HOST 或假场景资源 |
| 测试日志 | 仅该 Debug 构建且 `AED_VALIDATION_LOGGING=1` 时启用；不打印 bearer/refresh token、headers 或认证 body |
| iPhone 16 | NOT TESTED，按用户最新要求排除 |
| Simulator | 本轮未使用 |

### 签名证书核对

9 月 6 日成功包与今天最初失败日志使用同一 SHA-1：
`6367E7DB157E439B6FEB203FCB9B52237C32C14C`；同一 provisioning profile：
`REDACTED-ID-3c6627cde91f6f8e`。

- 真实 TeamIdentifier：`GR6YBCDW7R`。
- `H463W287GN` 是证书名称中的后缀，不是该签名团队的 TeamIdentifier。
- 证书有效至 2027-01-03；profile 有效至 2026-09-11T06:52:24Z。
- 14:09 同一身份、明确正确 Team 后签名成功，14:10 真机安装成功；未换证书。
- GUI 工程没有持久设置 Team，直接 GUI build 会报 missing team；本轮用显式
  build 参数处理。之前 errSecInternalComponent 的临时根因尚未证实，不能
  将其与后面发现的手机 Keychain API 参数错误混为一谈。

## 4. 测试过程

1. 14:04 设备仍 unavailable；按用户再次连接后于 14:08 确认真机解锁/可用。
2. 只读比较历史成功与当前失败的证书、profile、Team、有效期。
3. 14:09 签名成功，14:10 安装并回读 build 3。
4. 14:13 原业务数据库建立唯一受控账号，服务重启后健康/SQLite 均正常。
5. 14:14 导入 0600 凭据文件并启动 App；无会话刷新，文件未移除。
6. 加入 opt-in 诊断，14:22 确认阻塞在手机 Keychain 保存，状态 -25303。
7. 最小修正参数，重新签名安装，同一手机、同一受控身份重跑。
8. 14:24:40 Keychain 新建成功、导入成功；14:24:41 Azure 刷新 HTTP 200，
   新会话保存成功。服务器确认原账号会话已撤销、新会话持久化。
9. 14:25 已请用户在手机自行确认四项协议、通知、Always+精确定位。未代签，
   未注入授权状态，未绕过门禁。
10. 14:28 启动仅针对该 userId 的只读数据库观察器。截止本阶段记录仍未看到
    device bootstrap 或位置记录。真实前台/后台/锁屏/网络切换阶段未开始。

## 5. 数据证据

### 修复前（17 Pro 实际进程）

```text
2026-09-08T06:22:04Z IDENTITY_IMPORT_LOOKUP filePresent=true
2026-09-08T06:22:04Z KEYCHAIN_UPDATE status=-25303
2026-09-08T06:22:04Z IDENTITY_IMPORT_FAILED stage=keychain-save
```

### 修复后（同一手机真实 App）

```text
2026-09-08T06:24:40Z KEYCHAIN_UPDATE status=-25300 (不存在旧项，转入正常新增)
2026-09-08T06:24:40Z KEYCHAIN_ADD status=0
2026-09-08T06:24:40Z IDENTITY_IMPORTED
2026-09-08T06:24:40Z CLIENT_SEND POST /api/v2/auth/session/refresh
2026-09-08T06:24:41Z CLIENT_RECEIVE status=200 durationMs=773
2026-09-08T06:24:41Z KEYCHAIN_UPDATE status=0
```

请求 host 为 `redacted-host.invalid`，关联 requestId
为 `REDACTED-ID-944c16a898ec0957`。

服务器实读身份：

- userId：`REDACTED-ID-4b0f37dea05bc146`。
- accountId：`REDACTED-ID-8b01030fef69fd88`。
- 旧 ACCOUNT session：`REDACTED-ID-71165c74439fa39c`，
  revokedAt=`2026-09-08T06:24:40.914Z`。
- 新 ACCOUNT session：`REDACTED-ID-c3e126851188cb4c`，
  issuedAt=`2026-09-08T06:24:40.914Z`，未撤销。
- users=1，accounts=1，ACCOUNT sessions=2（正常轮换历史，不是两个用户）。
  截止上述查询无 devices/events/assignments/position receipts。

位置统计：尚无合格的实际采集观察窗口，首末位置时间、次数、平均/最大间隔、
缺失与重复情况均 **NOT TESTED**，不得将空结果解释为“没有丢包”。

本机证据目录：`/tmp/aedresponse-17pro-validation.8BaVWL`。其中：

- `client-diagnostic.log`：修复前的实际手机输出。
- `client-fixed.log`：修复后实际手机请求、响应与后续输出。
- `server-observation.jsonl`：只读数据库观察，不是伪造服务端 RECEIVE 日志。
- `diagnostic-install.json`、`keychain-fix-install.json`：真实安装结果。
- 凭据文件不属于可公开日志，不能复制到报告或输出其内容。

## 6. Bug

**已修复：正常 App 路径没有业务连接调用。** 详见最新更新，已通过真机回归
和实际设备 bootstrap/Socket/位置入库复测。

**仍待修复：待命 R 上传频率高于 120 秒或 100 米的冻结规则。** 本轮传输
观测与源码共同证实，不能因为服务器能接收就认为 cadence 已符合需求。

**已证实：Keychain 会话保存参数错误。** `SecItemUpdate` 的更新字典混入
`kSecClass` 等查询元数据；iOS 返回 `errSecNoSuchAttr (-25303)`。这是客户端
持久化层失败，发生在任何会话刷新请求前。

本机 Apple SDK `SecItem.h` 的 SecItemUpdate 文档明确更新字典不允许 meta
attributes；真实错误与源码一致。没有证据表明这是证书过期或服务器拒绝。

## 7. 修复

- `ios/AEDResponse/Services/AuthSessionStore.swift`：更新字典只包含数据和
  原保护级别；新增时才与查询字典合并。未删除已有 Keychain 项、未放宽保护。
- `AuthenticationArchitectureTests.swift`：新增唯一隔离 service 名下的
  create/update round-trip 回归用例，不读取或清除用户真实登录项。
- `IntegrationDiagnostics.swift` 及少量调用点：用户允许的 opt-in 诊断，
  区分导入、Keychain、REST、Socket、Lifecycle 与位置 ACK；生产无日志输出。
- 修复前/后结果见第 5 节。新增 XCTest 的 generic build-for-testing 通过，
  尚未单独执行该 XCTest；不能将编译当成测试通过。手机本轮业务路径已实际
  验证 Keychain 新建和刷新后的更新均成功。
- 不新增业务功能、不重构状态机、不改变认证/权限/事件校验，未 commit/push。

## 8. Remaining Issues

1. 权限细项、协议和自动连接已确认并修复；剩余明确偏差是普通待命位置上传
   频率，需按既定 120 秒/100 米规则修正并重新验收。
2. 受控身份刷新已通过，不等于真实 Apple/SMS 登录验证完成。
3. 前台 4 分钟蜂窝上传观察已完成；后台、锁屏、至少一次 Wi-Fi/蜂窝切换仍
   未实测。单元测试中的模拟断线重试不代替真实系统网络切换验收。
4. Patient 事件需要合法 Watch 触发；Watch capability/验证器仍为前置门槛，
   本轮不伪造触发、不拨打真实急救电话。
5. 16 暂不参与，跨设备接收/接受/任务状态/结束闭环不能在本批记为通过。
6. APNs、事件证据、服务器带业务数据重启恢复、Socket 房间清理仍未实测。
7. GUI 默认 Team 未配置；后续正常 GUI 操作需选正确团队或延续显式构建参数。
8. 旧临时诊断反代路由需在确认其精确配置后清理，不影响本轮正式 API。

## 9. Acceptance Matrix

| 模块 | 结果 | 本批依据/未测原因 |
| --- | --- | --- |
| iPhone 17 Pro → Server | PASS | 限本轮前台蜂窝观测：217 次真实位置持久化及对应 ACK |
| 中立待命 R 持续传输 | PASS | 4 分钟观察、216 个最新坐标快照匹配；不等于事件轨迹 |
| 中立待命 R 频率符合需求 | FAIL | 实际近 1 Hz，尚未执行 120 秒/100 米 cadence |
| iPhone 16 → Server | NOT TESTED | 用户明确排除 |
| Patient 持续位置上传 | NOT TESTED | 无合法 Patient event；不得把待命 R 充当 P |
| Responder 持续位置上传 | NOT TESTED | 尚无已接受任务的响应者；待命 R 不能充当响应者事件流 |
| REST API | PARTIAL | 手机认证刷新、bootstrap、presence/事件查询、R 写入通过；任务业务未测 |
| Socket 实时连接 | PASS | 当前真机握手及 system:ready 收到，4 分钟无断线 |
| Socket 自动重连 | NOT TESTED | 模拟失败/重试单元回归通过，未做实机网络切换 |
| Server → Patient | NOT TESTED | 账号 HTTP 响应不等于 Patient 业务推送 |
| Server → Responder | NOT TESTED | 16 排除，无响应者 |
| Patient 创建事件 | NOT TESTED | 不添加或伪造手动事件入口 |
| Responder 接受事件 | NOT TESTED | 双机阶段排除 |
| 任务分配 | NOT TESTED | 无本轮事件/响应接受 |
| 双方位置同步 | NOT TESTED | 仅 17 Pro |
| 状态同步 | NOT TESTED | 无合法业务状态变化 |
| 后台运行 | NOT TESTED | 启动时 scenePhase 切换不构成持续后台测试 |
| 锁屏运行 | NOT TESTED | 本次保持前台，没有专门锁屏观察 |
| 网络切换恢复 | NOT TESTED | 未实测切换；USB 是开发连接 |
| 事件结束清理 | NOT TESTED | 无本轮事件 |
| APNs | NOT TESTED | 未进行真实 APNs 推送 |

## 10. 最终结论（本阶段）

### A. iPhone 是否能稳定、持续地把真实数据发送到新服务器？

**本次前台蜂窝窗口已证实持续上传：217 个更新均有持久化回执和客户端 ACK。**
但待命频率偏高、启动阶段存在最长 11.72 秒新 fix 间隔；后台/锁屏/切网与
Patient 事件流未验收，因此不能扩展为所有场景、全部定位需求已达标。

### B. 是否已在两台真机和新服务器完成完整核心业务闭环？

**没有。** 本轮按用户要求只测 17 Pro；下一步至少还需修正待命 cadence、
完成后台/锁屏/切网和合法事件触发，再恢复 16 的响应/任务/状态与结束联动验证。
