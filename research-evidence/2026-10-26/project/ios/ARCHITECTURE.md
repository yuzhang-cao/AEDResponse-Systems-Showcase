# AEDResponse iOS/watchOS Architecture v2

状态：冻结实现基线。

> 2026-09-26 更新优先于下文旧传输边界：Watch 原始观察允许经手机原样中转，采用即时 RPC、系统后台 mailbox、持久回执和进程启动接收。持久绑定/监控授权不等于上传租期或瞬时 isReachable；过期上传凭证仍不可使用，由手机自动恢复授权租期。后台传输成功不等于服务器确认，Watch 原 outbox 只按最终业务 ACK 清理。详见 [当前契约](../contracts/watch-relay.md)。

## Target 与职责

| Target | 负责 | 明确禁止 |
| --- | --- | --- |
| `AEDResponse` (iOS) | 手机号/Apple 登录、四项同意、持续 P/R 位置上报、后端事件消费、自动角色、响应决定、地图/导航、任务与 AED 协同 | `CMFallDetectionManager`、用 iPhone CallKit 触发、主动创建 Fall/SOS 事件 |
| `AEDResponseTestHost` (iOS Debug) | 本地 fixture 的患者、未决响应请求与两种响应任务 UI 验证 | 连接/写入后端、进入生产 target 或 Release |
| `AEDResponseWatch` (watchOS) | 持久 companion 绑定、Fall Detection 授权/监听、Watch 外拨状态观察、一次性帮助问答、原始观察经 WCSession 即时/后台中转、独立授权的 WAN fallback、稳定 ID、受保护 outbox | 未绑定时启动业务监控、主动拨号、响应者/AED 编排、患者/响应者业务 UI、把手机 bearer 当 Watch 直传凭据 |
| Backend | Watch/iPhone 隔离、设备关联、幂等、事件/招募/分配/AED 状态真相 | 依赖客户端显示文案推断状态 |

Watch App 使用现代单 target SwiftUI watchOS companion，不创建旧式 WatchKit extension target。

## 依赖方向

```text
iOS Views → AppStore/Application → Domain/Ports ← iOS adapters

Watch View/AppDelegate → FallEmergencyCoordinator → Watch ports
                                               ↑
                  CoreMotion/CallKit/Location/REST adapters
```

Domain 与 coordinator 保持 Foundation-only。`CoreMotion`、`CallKit` 与 `WatchKit` 只允许出现在 Watch target 的 adapter/composition root。iOS target 的源码边界测试会拒绝这些触发依赖。

## iOS 状态所有权

- `AppStore` 是唯一 UI `ObservableObject` facade。
- 生产 `RuntimeRole` 只能由后端事件/assignment 关系推导：`PATIENT > RESPONDER > NEUTRAL`。响应请求在中立状态展示，接受成功后才成为响应者。TestHost Debug 只能用同样的 event/request/assignment 模型推导预览状态，不直接改写 `runtimeRole`。
- `AppEnvironment` 注入通知、定位、协议存储、事件位置受保护队列、REST、Socket.IO、时钟和 ID。
- Socket ready 后必须先用 REST 恢复未完成事件、当前 delivery/assignment，完成后才恢复位置与 presence 上报。重连前遗留的患者提示不能绕过该门槛。
- `EmergencyEvent.canPublishEventPosition` 是服务端对当前认证设备的严格写权限判定：患者视图只有该值为 `true` 才进入事件 P 采样；同一用户的次 iPhone 即使能查看患者态也保持 `false` 并不上传事件位置；已接受响应者仅按服务端 `true` 进入事件 R 采样。终态投影必须为 `false`。
- iPhone CoreLocation 使用连续更新并只消费真实 `CLLocation.timestamp`。中立/搜索圈设备继续向 `PUT /me/responder-position` 上报最新 R；患者和已接受响应者在服务端为本设备签发的 `[eventPositionParticipationStartedAt, eventPositionParticipationEndedAt)` 内，对每个合法 UTC 整秒槽严格生成一条 P/R `FIX` 或 `NO_NEW_FIX`。批量回调按 fix 时间的 UTC 整秒分组；一个 slot 首次提交前只保留观测时间最晚的合格 fix，跨 slot 各自保留。`FIX` 发送 `slotAt`、实际 `fixObservedAt` 与位置；缺口发送无坐标 `NO_NEW_FIX` 和明确原因。开放窗口的 clocked slots 与最新候选 fix 按 server namespace/user/device/event/role/generation 原子持久化；恢复时等待 5 秒接收系统历史 callback，旧进程已 clock 的无 fix 槽保持 `NO_FIX`，真正停机空缺写 `APP_NOT_RUNNING`。每个事件批次最多五个连续槽，正常每五秒首次提交，累计移动达到 10 米时可提前提交 1–4 条。首次提交后记录内容永久封口，只能原样重试，不创建 correction；受保护队列保留已封口批次到 REST ACK。只有当未 ACK 传输批次后来被权威时间窗判定为跨界时，客户端才可用新 `batchId` 重组原样的合法 records，并将越界 records 原样追加到本地隔离证据；`recordId`、状态、时间和坐标都不得更改。Watch 的触发时位置只是初始快照。iPhone 与 Watch adapter 共同使用 `LocationFixValidity`，拒绝非有限/越界/非正精度和未来时间，但不新增产品 freshness 窗口。
- 生产 REST/Socket 目标是公网可达的 HTTPS/WSS 域名，必须允许 iPhone 在关闭 Wi-Fi 时仅经蜂窝数据工作；同一 LAN、私有 Windows IP 或 iPhone Tailscale 都不是生产前提。开发用 HTTP 仍需与生产配置隔离。
- Wi-Fi、蜂窝数据和离线状态切换继续沿用 connection generation、稳定幂等 ID 与 REST-first 恢复；Socket 重连成功本身不能跳过事件/任务真相对账。
- 待命/搜索圈 P/R 继续使用 generation 隔离的 latest-wins 队列；事件参与者使用独立的稳定 `batchId`/`recordId` append-only 队列。网络断开、重启或身份/事件/角色切换不会删除未 ACK 批次，也不会把旧批次发送到新的身份、事件或角色；只有匹配上下文的事件恢复后才允许逐批重试，绝不合并成超大 payload。
- iPhone 声明 `UIBackgroundModes=location` 并设置 `allowsBackgroundLocationUpdates`，但这不保证系统在锁屏、挂起或终止后按 1 Hz 调度；本批只实现进程获得执行时间时的槽语义，不启用 extended runtime，也不把未执行的系统秒伪装成真实 fix。
- bootstrap 与 `PUT /me/presence` 携带通知/定位 capability 和自动可参与状态；它们不构成手动角色选择。位置真相只走 REST，Socket.IO 不作为生产位置写入通道。
- 不存在公开的 `startSOS`、20 秒计时器、角色 picker、duty toggle 或固定接受顺位。
- REST 是状态真相。`event:patient-position-updated`、`event:coordination-updated`、`response:decision-recorded` 等 Socket.IO 消息只校验强类型 payload 并触发 REST reconcile；其他参与者的 assignment 明细不会广播成本机任务。
- 中立响应者收到的 `response:requested` 只解码 `FALL_ASSISTANCE`、`SEARCH_RING`、距离/ETA 分桶、当前招募半径与 `expiresAt` 等粗粒度字段；接受前拒绝患者 P、地址卡、触发细节和 coordination。只有接受成功并通过 REST 对账后，才显示该设备可见的精确 P、可选地址卡和匿名协同摘要。
- `response:offer-expired` 只清除同时匹配 `eventId + deliveryId` 的本地 pending offer。`DELIVERED`/`VIEWED` 排入 REST receipt 队列，接受/拒绝走独立 REST decision endpoint；失败会保留或对账并暴露错误，Socket.IO 生产 adapter 没有任何业务写路径。
- timeline 模型和 reducer 仅保留本地诊断/旧协议解码兼容；角色与任务恢复不请求后端内部审计，iPhone 患者/响应者 UI 不提供时间线入口。
- TestHost 本地 fixture 同时禁止 bootstrap、presence、P/R REST 和 Socket 连接；真实网络患者测试必须由后端 Watch observation 激活，不能把离线患者预览接入生产网络。

## 患者位置来源仲裁

- iPhone 患者态持续 P 是正常且优先的 `IPHONE_PRIMARY`；Watch emergency observation 中的 P 只标记为 `WATCH_TRIGGER_SNAPSHOT`。
- Watch 不向后端提交独立的 reachability report，也不等待客户端 permit。事件 active 且不同时满足 `ACTIVATED + reachable` 时，Watch 只在自身 `NWPathMonitor` 为 WAN 可用时直报 fallback P；payload 携带 `activationState`、`iphoneReachable` 和 `networkAvailable=true`，后端负责连续 10 秒来源仲裁。
- fallback 首条位置立即发送，之后至少间隔 5 秒，移动达到 10 米可提前；网络断开或 iPhone 恢复可达只暂停发送并保留受保护队列，不删除或把旧 Watch 样本伪装成当前主 P。恢复可发送时复用原 `positionUpdateId`，ACK 后才删除。
- 触发 outbox 使用 Keychain，位置 fallback 使用受文件保护的原子队列；Fall 后35分钟仍是首次创建截止，超期未确认正文不删除，仅允许GET确认已有事件及权限后的精确重放。正文ACK原子交接恢复索引，24小时仅裁剪最小去重marker。位置来源切换只更新投影和coordination，不触发事件创建、终止或角色变化。
- 初始触发快照也保留 `CLLocation.timestamp`，通过 `WatchPositionSnapshot.observedAt` 和 `WatchEmergencyObservation.patientPositionObservedAt` 原样编码/排队/重试。旧队列缺该字段保持缺失，不用当前时间补全；后端只保留其原观察证据，不以未知采样时间的坐标初始化有效P。

## Watch coordinator

`FallEmergencyCoordinator` 接收两个独立 port 的信号：

1. Fall signal：`fallDetectedAt + fallResolution`，建立/恢复稳定 `eventId` 上下文并只展示一次帮助问答。
2. `NEEDS_HELP` 立即生成 `FALL_CONTEXT`；`DECLINED` 清除上下文；未回答时仅把 120 秒内新的 outgoing 观察编码为 `NO_RESPONSE + callFirstObservedAt`。
3. `fallResolution` 始终保留为 Apple 独立字段；不读取号码、不推断接通/时长/短信。
4. 首次发送前通过contract codec规范化并保存原观察；首次/重试共用单事件inflight、授权代次与退避入口。超过35分钟禁止新创建，保留未ACK观察并先查询已存在事件；只有原PUT的匹配ACK才释放正文，同次Keychain写入保留恢复事件ID。24小时只裁剪最小去重marker，不删除未确认事实。

事件创建成功后，Watch runtime 另行启动 direct fallback coordinator：事件 active 且 iPhone 不是 `ACTIVATED + reachable`、Watch WAN 可用时立即提交位置，之后每 5 秒或移动至少 10 米提前；iPhone 恢复可达立即停止。`scenePhase == .active`、进程启动和进程内周期机会共同进入同一恢复协调入口，重新核对会话、待确认触发和已知事件状态。该进程内定时器不证明降腕、息屏或挂起后的严格后台执行；当前冻结边界明确不启用 extended runtime，也不承诺挂起后严格 5 秒。事件终态停止该 coordinator；触发监控语义不因此改变。

生产 `CMFallDetectionManager` adapter 仅在设备能力可用时创建单一 manager，并尽早设置 delegate。Fall Detection entitlement 文件随工程声明，但其存在不构成 Apple 已批准或 profile 已包含的证据。

### 2026-09-10 P0-APPSTORE-EVENT-WINDOW：参与时间窗对账

`EventPositionWindowReconciliationCoordinator` 是客户端事件位置参与时间窗的唯一值级对账 owner。它只消费 REST/事件投影已经确认的开始/结束时间，按该窗口把开放事实和未 ACK 批次分成合法证据与 `quarantinedEvidence`，并原样保留合法记录的 `recordId`、采样时间、状态和坐标；合法批次需要新 `batchId` 时由协调器重组，不能改写记录内容。`EventPositionFactCoordinator` 通过 `EventPositionOpenFacts` 提供快照和应用边界，受保护队列仍由 `EventPositionQueuePersistenceCoordinator` 写入，ACK/发送仍由 AppStore 与 `EventPositionBatchUploadCoordinator` 处理。

AppStore 只负责当前认证/事件 context、后端窗口门禁、持久化成功后的快照应用、开放槽封口以及旧事件退出 ACK 的恢复触发。退出 ACK 在当前 UI 已切换到新事件时，使用 `reconcilePersistedBatches` 只处理旧 context 的持久批次，不读取或修改新事件的开放事实。没有改变后端 `canPublishEventPosition`、终态、退出资格、补招、人数或 AED 规则；窗口缺失时停止新采集并保留事实，不能清队列。

本批 generic build-for-testing 与隔离 runner 通过；Simulator XCTest 启动受 `NSMachErrorDomain Code=-308` 阻塞，不能将编译证据写成运行通过。物理 iPhone/Watch、OS 后台频率、真实路线和 APNs 仍属于后续验收。

### 2026-09-10 P0-APPSTORE-EVENT-OUTCOME：批次 ACK 与永久拒绝

`EventPositionBatchOutcomeCoordinator` 负责已封口批次的结果状态变换：验证 ACK 是否匹配原 batch，按 `serviceNamespace/user/device/event/role/batchId` 只删除被确认的 pending 记录，或将一个永久拒绝批次原样标记为 `blockedReason`。它不读取权限、不上传、不重试、不判断参与窗口，也不清除任何事实。`EventPositionBatchUploadCoordinator` 仍只负责 immutable batch 的 REST single-flight、代次复验和退避。

AppStore 仍是队列快照与受保护持久化的组合入口，只有 outcome 结果成功写入后才更新内存队列和 `lastEventPositionBatchAck`/错误投影。没有匹配的永久拒绝返回 no-op，避免对已被 ACK/切换代次的旧回调再次写盘；不匹配或错误 ACK 继续让 transport 重试。永久拒绝不会阻塞其它合法批次，事件位置事实与 `blocked` payload 保留待人工/后续对账。

### 2026-09-10 P0-APPSTORE-ASSIGNMENT-TIMEOUT-REST：Socket 超时只触发 REST 对账

`assignmentTimedOut` 是通知，不是本地任务状态写入口。AppStore 在 event/assignment 仍匹配时可以暂停终态相关采集并记录“等待 REST 真值”的 timeline，但不再调用 `AssignmentProjectionCoordinator.markTimedOut`；随后通过 `reconcileEvent` 读取后端快照，再由统一 assignment projection owner 应用真实 revision/status。这样 Socket 丢失、乱序或服务端重派时不会让客户端先行制造 `TIMED_OUT` 投影，也不改变后端超时、重派或接受规则。

### 2026-09-10 P0-APPSTORE-STATUS-CONFIRMATION-GENERATION：状态确认旧回调抑制

患者提交 `CONTINUE` 状态确认时，AppStore 捕获 event ID、confirmation ID、账号和 connection generation。REST 返回或错误只有在当前仍为同一认证账号、连接代次、患者 active event 且 confirmationId 未变时，才可更新 `lastStatusConfirmationResult` 或错误；断开/切号会释放提交 gate，旧响应不能触发新会话恢复。状态确认的服务端截止、幂等和终态语义仍由后端用例维护。

### 2026-09-10 P0-APPSTORE-COMPANION-TICKET-GENERATION：Watch 票据旧回调抑制

Watch companion ticket 请求捕获连接代次。请求结束时，只有同一代次才可清理 `companionLinkTask`；失败回调还要确认当前账号仍认证且业务服务仍激活，旧连接/旧账号错误不能覆盖新会话。成功票据继续复验代次和业务门禁后才创建临时 envelope 并发送，票据不落盘、不携带业务数据。

### 2026-09-10 P0-APPSTORE-AUTH-REFRESH-GENERATION：token rotation 旧回调抑制

LiveSession 创建 API client 时捕获 connection generation 与账号 userId。API client 的 refresh callback 只有在当前仍是同一代次、同一认证账号且会话有效时，才可调用 `persistRefreshedAuthSession`；旧连接的轮换结果不能覆盖重连或切号后的 Keychain session。认证 token rotation 的服务端语义和存储格式不变。

### 2026-09-10 P0-APPSTORE-AUTH-RESTORE-GENERATION：冷启动恢复取消

冷启动 `refreshSession` 使用独立 authentication restore generation。logout、显式新登录或恢复失败会取消并使旧 generation 失效；refresh 返回、保存 session 和失败处理前均复验 generation、`isRestoringAuthentication` 和未认证状态。旧账号恢复不能重新设置 signed-in、读取业务队列或激活定位/Watch 服务。

## 领域不变量

- P/R/A 类型不可合并；AED 路径编码/解码都验证精确 `R → A → P`。
- `AssignmentPlanner` 只按最终有效 N 计算两类任务数量，不按“第一/第二/第三接受者”赋予固定角色。
- `AedAcquiredReceiptMachine` 对相同 receipt/业务键返回幂等，对冲突回执拒绝。
- `EmergencyEventMachine` 只接受明确误报确认或显式人工 resolve；所有被动恢复信号都是 no-op。
- append-only timeline 以 entry ID 去重、按时间排序。

## 验证证据分类

- 领域/契约测试：纯业务和 JSON 边界。
- test bundle 的 generic `build-for-testing`：只证明测试源码可编译，不证明断言已执行。
- generic device build：设备架构编译，不代表签名或安装。
- signed build/profile inspection：仅证明 profile/entitlement 组合。
- 物理 iPhone unit/UI、物理 Watch Fall Detection/Emergency SOS 与蜂窝 E2E：分别执行并保留证据，不得由前三类推断；本项目不以 Simulator 结果替代真机验收。


### 2026-09-09 C3 结束用例边界

`Application/EventEndCoordinator.swift`实际接管结束请求内容生成、原子持久化、同内容重试、失败后授权快照恢复和错误分类。`Services/EventEndIntentPersistence.swift`维护独立受保护意图日志，context含服务namespace/user/auth method/device/event，不写token；未确认条目在登出、换号、断网时保留。服务器明确终态仅标记该context的记录，不能表示现实AED已归还。HTTP403/409等在恢复不到终态时进入requiresAttention，不自动无限重发；用户同一操作重试仍用原ID/时间。

实际患者按钮和现有resolveCurrentEvent不再在AppStore内生成新ID并直发请求。患者使用现有`/events/{id}/end`理由契约，响应者仍是`/resolve`且仅professional takeover；旧API方法保持兼容但不作为按钮主写路径。AppStore仅保存操作UI状态和投影更新钩子；事件/任务仍由其既有applyServerSnapshot/replaceEvent维护，未在协调器复制业务状态。每次回调检查连接代次、操作lease、账号context和当前event；旧结果不能清理新任务或应用新账户投影。

终态继续经prepareForTerminalRestore、replaceEvent及原快照对账执行封口/合法补传，没有修改位置队列格式或停止/清空所有队列。新日志使用同一contract codec先规范化时间精度再保存/发送；损坏或读失败保留原文件，保存失败不发送新请求；已知服务器终态不因本地记账失败而被隐藏。新源文件已加入三个iPhone源target，project.yml原目录规则自动包含它们，Watch target未加入这些文件。


### 2026-09-09 C4b Watch已知事件恢复

WatchAPIReporter以独立GET读取原触发Watch的四字段状态，FallbackCoordinator维护本地恢复投影与原位置队列；Runtime只组合监控适配器、会话机会执行和带代次的展示回调。原clearActiveEvent删除队列路径已停用。每次新采集前确认已授权ACTIVE；明确终态先停止采集并持久封口，再清采集context。停止监控/连接改变只使旧代次失效，不删除未确认记录。手机可达仍能查询终态及补传合法历史，但不会由此改变原新采集门槛。

受保护文件分别保存pending、sealedEvents和quarantined。合法历史使用原body/ID/采样时间，ACK只移除该pending；越界或服务端内容拒绝把完整单条事实与依据原子隔离，不能重写或删除其他事件记录。历史积压不会阻断当前事件的新位置机会；未知窗口、读写失败均保留。旧队列缺少新增字段可以读取；代码回退须保留新字段读取/写回能力，旧decoder不得覆盖新文件。没有容量/保留期清理策略或性能修复的声明。

401/403暂停相同授权代次的写请求并停止新采集；400/409/422隔离单条内容，不推定终态；临时错误按1至60秒退避，等待实际执行机会。请求返包匹配当前token/config/授权代次；暂时刷新失败保留凭据，明确撤权等待重新配对。Runtime会话校验失败保留恢复heartbeat机会，权限不满足时只能状态恢复/历史处理，不能采集。进程内5秒机会不是watchOS后台保证。首次触发ACK丢失与过期保留的后续实现见C4c；配对并发缺口和全链运行证据仍开放。


### C4c触发确认与恢复交接

FallEmergencyCoordinator的submit接管首次发送和重试，旧两段独立report/ACK及discardExpired路径停用。未确认正文在Keychain中保持不可变；400/404/409/422内容拒绝另存状态并暂停自动写，401/403等待新授权代次，临时错误1至60秒退避。暂停新采集时恢复只能GET已存在事件再重放；GET尚不存在只进入退避查询，不能永久阻断在途原请求稍后提交后的恢复；任何超期PUT仍须先GET证明存在。相同ID并发只发一次，最后授权await后才ACK；Reporter拒绝空body、错误ID及未知state的伪成功响应。

ACK原子写入confirmedEventIDs与删除pending正文，独立于Runtime是否已来得及建立fallback指针。Runtime的recoverWatchState读取该索引交给FallbackCoordinator，后者查询并维护后端投影/封口；只发现一个活动候选且无当前事件时才恢复采集context，多个活动候选不选仲裁。原触发异步回调带sessionGateGeneration，旧配对结果不能应用当前展示或启动新采集。保留confirmed IDs尚无终态归档裁剪，历史查询成本需D处理；不宣称后台节奏或容量通过。


### C4d配对与会话写入

WatchAPIReporter按票据指纹合并同次交换；不同票据必须得到后端201后才替换会话，不能以本地尚未过期的旧token推断新票据被接受。原票据不落盘，可选companionLinkFingerprint随受保护会话保存并在refresh时保留，用于重启去重；缺字段的旧会话仍可读取，不能凭空认定其已处理某张票据。后端禁止同Watch跨账号/pair重绑的规则保持。

### D3 fallback事实来源与Fall context错误边界

fallback位置正文继续只包含事件、样本、连接和采样事实；来源身份不写入HTTP契约，而由 `WatchAPIReporter` 根据当前服务端会话的issuer/user/account/device/pair形成稳定非秘密指纹。`ProtectedFileWatchFallbackOutbox` 为每个 `positionUpdateId` 原子保存该指纹。新采集没有当前指纹时停止；已知指纹改变时不发送、不ACK，切回原来源后复用同一事实重试。

旧队列可能没有来源字段。此类记录只能在当前会话成功GET到同一事件并通过后端权限后原样重放；GET 404、403、暂时错误或事件内容冲突均保留正文。服务器仍负责最终授权，指纹不替代Bearer token，也不表示用户已收到位置。

`FallEventStatePersisting` 的读写接口显式报告错误。损坏的UserDefaults context不能被当作空字典覆盖；保存观察、ACK或抑制失败时，协调器保留唯一Fall context并返回持久化失败。120秒关联窗口和35分钟首次创建截止不变。

配对操作ID与配置在每个await之后复验，新任务开始使旧业务请求代次失效；新key/session只在当前成功结果中保存，旧失败不清新key。当前绑定的refresh与一个尚未成功的配对尝试分别处理；已接受新会话后，旧refresh不再有写权。hasValid、恢复与发送共享apiBaseURL规范化及issuer/path校验。真实身份供应商/一次性响应丢失后的新票据取得仍属外部能力，不是Mac stub通过就完成。


## D2 Watch观察来源维护

WatchAPIReporter从正式会话响应已有的userId/accountId及canonical issuer/device/pair计算带版本的SHA256来源指纹；令牌、过期时间和一次性配对票据不参与，因此合法刷新不会变更事实所有者。过期但来源已知的会话可以标识离线事实，发送仍须成功取得有效凭据并经后端授权。旧本地会话缺身份字段可读，但不据此猜测来源；远程刷新填充正式身份。

FallEmergencyCoordinator在Fall时捕获指纹，随最小Fall context持久化；只在Keychain outbox中原子保存观察正文和同一指纹，已存在正文不能改变/清空来源。submit先核对来源，Reporter在刷新/实际发送/返回等await边界再次核对，旧逐次只检查当前token的观察发送路径已替换。known来源不同则保留并等待原授权；unknown旧记录只GET已有事件后重放，404仍保留，绝不作为新账号的首次求助提交。ACK后的恢复索引保留来源指纹，但正文和本地指纹都不能替代服务器权限。

本批只接管触发观察的来源，不声称fallback每条历史已具备同样元数据；其现存事件仍由后端原Watch/患者/pair权限隔离。新字段回退必须保留，不能让旧版本重写后丢失保护。未运行真机重装；合成新配置+保留Keychain是组件证据。

### D4 iPhone 待命最新位置上传

`LatestPositionUploadCoordinator` 只接管待命/搜索圈的最新值 R 传输。它拥有 pending 样本、稳定 `positionUpdateId`、任务与退避、最近 ACK 样本/时间和服务端 `positioningTier`；搜索圈是服务端 tier，不是客户端新增模式。发送前、ACK 后和失败重试前通过 AppStore 的连接代次、模式代次及 `.responder` 当前模式复验，错误 ID 会进入原有 `invalidResponse` 重试路径。

AppStore 仍是 UI facade 和后端投影维护者，选择位置模式、推进代次、更新 ACK 展示，并继续维护事件参与者的一秒保护批次。事件 `FIX`/`NO_NEW_FIX` 不经过 latest-wins 上传器；协调器 reset 只取消待命最新值，不清除事件事实或其他未确认队列。旧 `drainPositionUploads` 路径已停用，API 请求字段和定位采样时间语义不变。

### D5 连接重试调度边界

`ConnectionRetryCoordinator` 只维护目标服务 URL、指数退避次数、单一等待任务和取消 generation。它通过异步 `establishConnection` 回调请求 AppStore 执行实际 bootstrap/Socket 建立；不读取或写入事件、任务、位置、权限或 `ConnectionState`。`begin` 替换目标并使旧等待失效，`markConnected` 清退避，`cancel` 用于登出和权限撤回。

AppStore 仍唯一维护 `connectionGeneration`、`LiveSession`、连接状态、REST-first 恢复和实时业务事件。连接成功不代表事件已恢复；Socket ready 后仍必须先由 AppStore 对账。旧 `desiredBaseURL`、`reconnectAttempt`、`reconnectTask` 写状态已停用，避免重试调度与业务会话状态并行写入。

### D5 连接重试调度边界

`ConnectionRetryCoordinator` 只维护目标 URL、等待中的指数退避任务、重试次数和取消 generation。`begin` 替换目标，`scheduleIfNeeded` 避免重复安排等待任务，`markConnected` 清除退避，`cancel` 使登出或权限撤回后的等待回调失效。实际 bootstrap、Socket 建立以及建立完成后的 REST 对账仍由 AppStore 执行。

这里的单任务保证只覆盖等待退避阶段，不扩展为 bootstrap 在途期间的全流程 single-flight。连接成功仍只是传输层事件，不能绕过事件/任务/位置恢复门槛。

### D6 REST 恢复调度边界

`RestoreCoordinator` 只维护 REST 恢复的等待任务、1/2/4/8/16/30 秒退避、同一连接代次的 follow-up 合并和取消 generation。它通过 `isEligible` 门确认当前仍有已连接的 `LiveSession`，通过 `reconcile` 回调请求 AppStore 执行实际事件快照恢复；不能读取或修改事件、任务、位置、权限或终态。Socket 暂时断开使用 `cancelWaiting()` 保留退避次数；新连接、主动断开和登出使用 `reset()` 清零并失效旧回调。

AppStore 仍唯一维护 `connectionGeneration`、`restoredConnectionGeneration`、服务端事件/任务投影以及恢复后位置批次、Presence 和待提交结束意图的顺序。`markRestored` 只清零调度退避，不替代服务端快照；`reset` 只取消旧恢复等待，不清理未确认事实。该单任务保证覆盖等待和恢复 in-flight 的 follow-up 合并，不宣称整个 AppStore runtime 的全流程 single-flight。

### D7 事件投影合并边界

`EventProjectionReducer` 是无状态的投影合并器，接收已有事件投影、服务端快照和已确认的 suppressed event ID 集合，统一执行过滤、同 ID 合并、终态单调性和 coordination revision 保护。它不读取账号、权限、任务、位置或终态业务规则。

AppStore 仍唯一写入 `visibleEvents`，并在 Reducer 结果之后执行 pending patient、assignment、response request、事件位置窗口和 Presence 的副作用。Socket 仍只是唤醒提示，REST 快照仍是权威；该迁移不改变跨端契约或业务状态所有权。

### D8 响应邀请与回执投影边界

`ResponseOfferProjectionCoordinator` 维护当前 `ResponseRequest`、`DeliveryStatus` 和 `DeliveryReceiptMachine`，对重复 messageId、非法转换和 clear 后旧状态提供单一写入口。它不决定 VIEWED 门、接受权限、人数、assignment 或事件终态。

AppStore 通过不可变 `responseOfferProjection` 发布 UI 镜像，继续执行角色/过期门禁、REST respond、timeline 和内存待发送回执队列。接受/拒绝的异步结果在写入前复验连接代次与 event/message/delivery 三项标识；推送或回执提交不代表用户已查看。回执队列持久化和登出后的恢复仍未在 D8 解决。

### D9 assignment 与任务投影边界

`AssignmentProjectionCoordinator` 是 iPhone 当前 assignment、`acceptedResponseEventID` 和按 assignment 的 AED receipt 幂等状态的唯一本地写入口。它按 assignment revision 拒绝陈旧投影，使用稳定 `receiptId` 保持重试幂等，并把冲突回执交给既有 `AedAcquiredReceiptMachine`；它不决定全局任务、人数、角色分工、AED 生命周期或后端终态。

AppStore 只发布 coordinator 的 `assignmentProjection` 镜像，继续执行患者/响应者/退出门禁、REST task 操作、timeline、事件位置窗口和 Presence 副作用。Socket assignment hint 与 REST 返回都进入同一投影入口；assignment 更新、AED 获取和 AED 不可用的异步回调在写回前复验认证状态、连接代次、event/assignment ID、revision 和原 status，超时投影会使旧状态回调失效。`clear` 只清当前本地投影，`reset` 才清账号/会话级 receipt 缓存，不删除已确认事实或待提交意图。

D9 通过 20 Phone + 78 Watch 组件及两个本地真实 HTTP/重启阶段；generic unit/Release 只证明编译与链接，完整 AppStore runtime、真机、Watch 后台和 AED 业务规则仍需独立验证。

### D10 Presence latest-state 上传边界

`PresenceUploadCoordinator` 是 iPhone Presence latest-state 的唯一本地传输写入口。它拥有 signature、待发送 `DevicePresenceUpdate`、稳定 `presenceUpdateId`、重试退避和取消 generation；相同 signature 会抑制重复发送，在途期间只保留最新 pending，重试复用原 ID，force 才生成新 ID。Presence 不是事件位置事实，本协调器不持久化事件队列，也不决定可参与资格。

AppStore 仍执行连接、认证、业务权限和 REST 恢复代次门禁，发布 `lastPresence` UI 镜像，并在 ACK 后按原条件刷新附近摘要。发送前和每个 await 返回后都检查认证、连接代次、`.connected`、有效 LiveSession、业务权限和已恢复代次；`reset` 后迟到成功/错误不再回写。`reset(resetLastSignature: false)` 保留已确认 signature，账号/会话清理用 `true` 清除它；两者都只清 latest-state pending，不删除后端事实。

D10 通过 22 Phone + 78 Watch 组件及两个本地真实 HTTP/重启阶段；新增 reset→迟到 ACK 交错回归通过。generic build 只证明编译与链接，附近摘要完整恢复、事件位置调度、AppStore runtime、真机/Watch 后台和 APNs 仍需独立验证。

### D11 附近志愿者摘要查询边界

`NearbyVolunteerSummaryCoordinator` 是附近聚合查询的唯一本地 task/generation 维护者。它负责取消旧查询、抑制旧回调和校验 `NearbyVolunteerSummary.isCurrent`；AppStore 仍负责中立/权限/无 assignment/无待处理邀请门禁、离线预览和 `nearbyVolunteerSummary` UI 镜像。服务端返回的只有固定 1/1.5/2 公里累计计数，具体志愿者身份、坐标、招募半径和任务分工不进入客户端摘要。

`refreshNearbyVolunteers()` 继续等待查询完成。调用者取消只使捕获的查询 task 失效，generation 检查避免清除之后启动的新查询；真正发 HTTP 前和返回后均重新检查当前 session、业务权限、角色、任务、邀请和新鲜度。D11 通过 23 Phone + 78 Watch 组件及两个本地真实 HTTP/重启阶段；事件位置调度、完整 AppStore/UI runtime 和真机仍需独立验证。

### D12 事件位置 UTC slot scheduler 边界

`EventPositionSchedulerCoordinator` 只维护事件位置周期 scheduler 的 task、active context、UTC 等待、catch-up 和 generation lease。它从 AppStore 接收已建立的 context、开始时间和最后封口 slot，等待一个整秒区间结束后逐秒回调 `captureEventPositionSlot(at:)`；它不创建坐标、不保存 slot、不改变 `observedAt`、不封口、不上传批次，也不删除队列。

AppStore 仍唯一维护 `eventPositionContext`、候选 fix、open draft、持久化失败状态、`FIX/NO_NEW_FIX`、APP_NOT_RUNNING 恢复分类、封口和 REST ACK/重试。context 或 generation 失效、终态暂停、登出和清理会停止 scheduler；TestHost 继续显式驱动 slot，不依赖墙上时钟。D12 通过 24 Phone + 78 Watch 组件及两个本地真实 HTTP/重启阶段；后台执行频率、完整恢复/上传交错和真机仍需独立验证。

### D13 事件位置恢复 grace scheduler 边界

`EventPositionRecoverySchedulerCoordinator` 只维护进程恢复后的 5 秒 grace 等待、active context、generation lease 和循环调度。它在 lease 有效时调用 AppStore 的 `completeRecoveredEventPositionSlots`，pending 清空、context 变化、取消或 stop 后自动结束；它不创建 slot、不设置 `APP_NOT_RUNNING`、不持久化、不封口、不上传。

AppStore 仍唯一维护恢复 cutoff、参与窗口、候选 fix、draft/队列、gap reason、封口和批 ACK/重试。D13 通过 25 Phone + 78 Watch 组件及两个本地真实 HTTP/重启阶段；恢复与批上传完整交错、后台频率、完整 runtime 和真机仍需独立验证。

### D14 事件位置批上传 single-flight 边界

`EventPositionBatchUploadCoordinator` 只维护已封口事件位置批次的 REST transport task、单飞约束、同一 immutable batch 的退避重试和连接/账号/设备代次 lease。它验证 ACK 与原批次匹配，并把成功、永久拒绝或临时失败交回 AppStore；它不选择队列事实、不删除记录、不改变参与窗口、不创建位置或决定业务终态。

AppStore 仍唯一选择已持久化 pending batch，执行业务门禁、退出时间窗 reconciliation、ACK 后持久化删除、403/409/413/422 隔离和错误投影。D14 通过 27 Phone + 78 Watch 组件及两个本地真实 HTTP/重启阶段；恢复/批上传完整交错、后台频率、完整 runtime 和真机仍需独立验证。

### D15 事件位置队列 I/O 边界

`EventPositionQueuePersistenceCoordinator` 唯一执行受保护队列的 load/save，并维护 loaded、unavailable、blocked 生命周期；AppStore 仍唯一维护 `EventPositionQueueState` 的业务内容、context、draft、封口和 ACK 删除。损坏文件和保存失败均 fail-closed，reset 不清除未确认事实。D15 通过 29 Phone + 78 Watch 组件及两个本地真实 HTTP/重启阶段；完整 runtime、跨进程恢复、后台频率和真机仍需独立验证。

### D16 delivery receipt 持久化边界

`DeliveryReceiptQueuePersistenceCoordinator` 唯一维护待发送 delivery receipt 的受保护队列、服务/账号/设备 context、精确 ACK 删除和 blocked 失败门；AppStore 不再拥有独立 receipt 数组，只负责当前会话、错误投影和 REST transport。登出只 reset 内存 owner，不清磁盘；重新登录只发送当前 context，DELIVERED→VIEWED 的顺序事实保持不变。D16 通过 32 Phone + 78 Watch 组件及两个本地真实 HTTP/服务重启阶段；完整 AppStore runtime、实际崩溃点、APNs、OS 后台、签名和真机仍需独立验证。

### P0-APPSTORE-RECEIPT-01 回执上传与跨进程恢复

`DeliveryReceiptUploadCoordinator` 接管 D16 之后仍留在 AppStore 的 receipt append/drain/retry/ACK/cancel 编排。它通过当前会话 context 过滤队列，单飞发送、复用原事实重试，发送成功而本地 ACK 失败时保留记录；`AppStore` 只组合认证 context、UI 错误和连接后的 `startDrain()`。新的 AppStore 实例会先从相同受保护队列恢复，再尝试上传。模拟器运行仍受 CoreSimulator launch IPC 环境阻塞，generic build 不能替代真实进程崩溃与真机证据。

### P0-WATCH-ADMISSION-01 fallback 准入策略

`WatchFallbackAdmissionPolicy` 是 Watch fallback 的业务准入边界。默认策略保持原有“iPhone 已激活且可达则等待恢复、否则要求 Watch WAN”的行为；任何未来以“后端已收到有效 P”为条件的产品规则必须通过替换策略接入，不能在 `WatchFallbackCoordinator` 内再写一套隐含判定。`blockedPendingBusinessRule` 会停止新采集但保留已入队历史事实；该接口不选择尚未确认的手机可达/P 健康规则。

### P0-APPSTORE-EVENT-FACTS-01 事件位置开放事实 owner

`EventPositionFactCoordinator` 唯一拥有事件位置开放窗口内的 slot、candidate fix、clocked/APP_NOT_RUNNING 标记、draft 恢复、movement 计算和封口后的清理。它不读取账号权限、不决定服务端参与窗口、不发送批次，也不删除 ACK 之前的事实。

AppStore 继续负责当前账号/事件/连接代次、服务端 `canPublishEventPosition` 和参与时间窗、受保护队列 I/O、批次上传/ACK/隔离及 UI 错误投影。`CLLocation.timestamp`、同秒取最新 fix、先保存 draft 再推进内存状态、批次封口后保留到 ACK 的契约保持不变。该迁移完成本地 HTTP/重启链和 generic build 证据，未替代物理 iPhone/Watch 或 OS 后台验证。

### 2026-09-11 Watch生命周期回调隔离

WatchRuntimeModel在生命周期恢复的await边界、会话快速检查及Fall权限请求结果应用前复验sessionGateGeneration。重新配对后的旧回调不得继续推进新会话。生命周期通知和heartbeat只表示获得执行机会，不保证OS后台周期；当前证据为generic构建，真机行为仍需独立验收。
# 2026-09-26 Watch 互联更新

最新主链路为 Watch→iPhone→服务器，独立直传备用；下文旧的 WCSession 仅绑定限制不再适用。`WatchRelayReporter` 在现有受保护队列上选择传输路径，`IPhoneCompanionConnectivityActivator` 接收带请求 ID 的受限 RPC，AppStore 经账号/权限/代次校验后交给独立的 iPhone 中转 REST 接口。手机只在服务器确认原事件后返回匹配 ACK，不持有 Watch 直传 bearer，也不生成跌倒事实。细节见 [中转契约](../contracts/watch-relay.md)。
