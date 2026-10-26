# AEDResponse v2 架构与状态机

2026-10-08 路线选择：手机 MapKit 获取两段真实步行距离，上报后由后端复核资格、位置、AED 可用性和占用并确认分配；导航优先高德、Apple 回退。旧 ETA 排序和 300 秒绕行门槛取消，15 秒改派确认保留。候选数量、客户端距离的证据边界与配置见 [后端说明](../backend/README.md)。

2026-09-09 本地渐进整改：见 [`architecture-repair.md`](architecture-repair.md)。身份认证与注销撤销已由 `backend/src/identity-access.ts` 维护，`service` 只保留这两个操作的兼容入口；会话签发/refresh 等其他身份路径仍待迁移。`realtime-access.ts` 按连接保存握手身份，在撤销提交后及发送前复核已提交会话；设备房间成员身份本身不再授予发送权限。该边界不决定事件受众、不把注销转为退出/结束；存储仍是全状态单写，未完成容量整改。

最终业务流程、所有已批准频率与节点连接技术见 [`runtime-flow.md`](runtime-flow.md)。本文保留领域边界和状态机说明；旧的匿名会话、30 秒 permit/15 秒 Watch fallback 规则均已被 2026-09-05 冻结规则取代，开发中不得继续作为产品语义。

## 组件与信任边界

```text
Apple Watch system UI
  │ Fall Detection result + observable outgoing-call state
  ▼
watchOS companion ── authorized HTTPS fallback ────────────┐
  │ WCSession immediate RPC / durable background delivery │
  ▼                                                       │
                                                          ▼
iPhone app ── HTTPS REST + WSS over cellular/WAN ──▶ Public TLS ingress
  │ standby/search: latest-only R; active event: batched P/R │
  └── user intent + current phone position                  ▼
                                      Mainland Node.js application cluster
                                                          │
                         ┌── PostgreSQL/PostGIS state truth + audit
                         ├── Redis-compatible hot state
                         └── durable queue/object storage

Windows Backend/SQLite ── local development and reviewed device testing only
```

- Watch 原始观察通过 WCSession 即时 RPC 或系统后台投递交给当前配对 iPhone，手机用自身有效会话原样中转；后端仍是授权、隔离与去重边界。手机不能合成跌倒事实，也不向 Watch 传递手机 bearer。独立 Watch 直传继续使用单独的短期绑定 ticket 与 App Attest，不能用中转成功替代独立授权。
- Watch 的 Fall Detection、用户帮助回答、外拨观察和上报均在可替换 port 后。WatchConnectivity 的瞬时 reachability 不决定持久绑定寿命，后台队列恢复不依赖 UI 前台。独立直传授权和 WAN 有效时，旧备用 P 的触发/采用规则保持：即时手机路径不可达或服务端确认 `fallbackAllowed=true` 时可尝试，后端连续 10 秒无 iPhone P 后才采用。确定性测试使用模拟 port，生产 adapter 仅存在 watchOS target。
- iPhone 接收服务端的患者激活、响应请求、任务和 AED 状态，同时通过 CoreLocation 与 REST 上报手机当前位置；仍不含 Fall Detection 或触发用 CallKit 代码。
- 待命/搜索圈 iPhone 使用 latest-only 接口上报 R；active event 中的患者和已接受响应者分别通过事件批次上报 P/R。后端按位置时效、精度与 1/1.5/2 公里动态半径筛选，并只向选中的已登录用户设备定向发送请求。生产业务数据经公网 HTTPS/WSS 传输，支持蜂窝数据和任意外部 Wi-Fi，不使用蓝牙业务协议，也不要求同一 LAN 或 iPhone Tailscale。
- iPhone 待命/搜索圈最新值 R 的 pending、稳定 `positionUpdateId`、退避任务、最近 ACK 和 `positioningTier` 由 `LatestPositionUploadCoordinator` 单独维护；它只接收 AppStore 已确认的 `.responder` 模式。AppStore 保留连接/模式代次、UI 投影和事件参与者的一秒事实批次，错误 ACK 进入同一稳定 ID 重试路径，事件 `FIX`/`NO_NEW_FIX` 不经过 latest-wins 上传器。
- iPhone 的连接重试由 `ConnectionRetryCoordinator` 单独维护目标 URL、退避次数、单一等待任务和取消 generation；AppStore 仍维护 `connectionGeneration`、LiveSession、ConnectionState 和 REST-first 恢复。连接成功只表示传输建立，不表示业务事件已恢复。
- iPhone 的 REST 事件恢复调度由 `RestoreCoordinator` 单独维护等待、1/2/4/8/16/30 秒退避、同代次 follow-up 合并和取消 generation；AppStore 仍是 `reconcileVisibleEvents`、`restoredConnectionGeneration`、事件/任务投影及恢复后位置/Presence/结束意图顺序的唯一维护者。
- iPhone 的事件投影合并由纯 `EventProjectionReducer` 维护 suppressed ID 过滤、终态单调性和 coordination revision 门；AppStore 仍唯一写入 `visibleEvents`，并负责 pending patient、assignment、response request、位置窗口和 Presence 副作用。
- iPhone 的响应邀请与回执投影由 `ResponseOfferProjectionCoordinator` 单独维护当前 `ResponseRequest`、`DeliveryStatus` 和回执状态机；AppStore 仍负责 VIEWED/过期/角色门禁、REST 接受/拒绝、UI 镜像和待发送回执传输。接受/拒绝回调按连接代次与邀请 ID 复验后才能写回。
- iPhone 的 assignment/任务投影由 `AssignmentProjectionCoordinator` 单独维护当前 assignment、接受事件关联和 AED receipt 幂等状态；AppStore 保留角色/退出门禁、REST task 操作、timeline、事件位置窗口和 Presence 副作用。revision、认证/连接代次、event/assignment ID 与原 status 在异步回写前共同复验；后端仍是任务、人数和 AED 生命周期权威。
- iPhone 的 Presence latest-state 上传由 `PresenceUploadCoordinator` 单独维护 signature、pending update、稳定 `presenceUpdateId`、退避和取消 generation；AppStore 保留连接/认证/恢复门禁、`lastPresence` 镜像和 ACK 后附近摘要刷新。连接状态、LiveSession、业务权限和恢复代次在发送及回调后复验，Presence 不替代事件位置事实，也不新增本地持久队列。
- iPhone 的附近志愿者摘要查询由 `NearbyVolunteerSummaryCoordinator` 单独维护查询 task、请求 generation、旧结果抑制和摘要新鲜度检查；AppStore 保留中立/权限/任务/邀请门禁、离线预览和 `nearbyVolunteerSummary` 镜像。查询返回聚合半径计数，不暴露具体志愿者身份或坐标，也不改变后端招募权威。
- iPhone 事件位置的周期 UTC slot scheduler 由 `EventPositionSchedulerCoordinator` 单独维护等待、catch-up 和 context generation lease；AppStore 仍唯一维护 slot 事实、持久化 draft、`FIX/NO_NEW_FIX`、封口、恢复和 REST 批上传。scheduler 不生成坐标、不改采样时间、不删除队列，也不推断 OS 后台频率。
- iPhone 事件位置恢复的 5 秒 grace scheduler 由 `EventPositionRecoverySchedulerCoordinator` 单独维护等待、恢复循环和 context generation lease；AppStore 仍唯一维护恢复窗口、`APP_NOT_RUNNING` 事实、持久化、封口和批上传。它不改变恢复分类或后台执行假设。

## 公网传输与信任边界

- 生产客户端只配置公网 `https://` 域名；Socket.IO 在同一可信入口升级为 WSS。开发用 loopback/私网 HTTP 与历史 LAN 测试不属于生产验收。
- 公网入口与应用服务是两个信任区。入口负责受信任 TLS、WebSocket upgrade、16 KiB JSON 边界、异常流量保护、访问日志和基础攻击面收敛；应用服务负责账号会话授权、业务幂等、PostgreSQL/PostGIS 真相、Redis 热状态、持久队列和定向通知。Windows 只保留本地参考环境。
- Windows Node.js 端口不得直接面向整个互联网。若仅为经审核的蜂窝真机测试向 Windows 回源，链路也必须受限并可审计；它不得被描述或验收为生产架构。
- iPhone 从 Wi-Fi 切换到蜂窝数据或短暂离线后，Socket 只作为提示通道重连；客户端必须先经公网 HTTPS REST 拉取事件与任务快照真相，再恢复 R/P 上传，复用稳定业务 ID 防止重复副作用。
- Tailscale 可以继续用于管理员 SSH 运维 Windows，但不能成为 iPhone 生产数据通道或最终用户前置条件。

## 后端状态与招募

- 手机号验证码或 Sign in with Apple 在 iPhone 上完成账号认证；session token 只以 hash 持久化，并按 `userId`、设备与 iPhone/Watch scope 授权。pair ID 只是设备配对证据，不能取代账号身份。
- Watch observation 的稳定 `eventId` 是创建/重放幂等键。REST 保存事件、delivery、assignment、AED 回执和 append-only timeline 真相；timeline 仅供内部对账/审计，不是患者或响应者 UI；Socket.IO 只向设备房间发送低延迟提示。
- active patient 的既有 R 位置会被清除，后续 R 上报被拒绝；患者不会进入任何其他事件的附近 responder 集合。
- SQLite durable store 使用事务保存 canonical state 和可查询的每设备最新 presence 投影。待命/搜索圈位置更新只替换最新样本并遵守 10 分钟 TTL；事件参与者通过 `PUT /events/{eventId}/position-batches/{batchId}` 追加真实 FIX/`NO_NEW_FIX` 证据，幂等回执随批次保存而不进入普通 timeline。附近半径、位置时效与精度上限是部署配置，不是客户端可决定的产品语义。
- P/R 必须携带精度。位置新鲜度由服务端时钟相对已验证的客户端 `observedAt` 计算，允许的轻微未来偏差按 age=0，超过配置时钟偏差则拒绝；`lastSeen` 不参与坐标变新。presence 同样按 update ID 与客户端时间 latest-wins，session bootstrap 只初始化缺失值。
- Watch 初始触发P另带实际 `patientPositionObservedAt`，由 OS fix 原样传递；Fall/call 时间仍用于触发和内部审计，接收时间单独记录。旧payload/旧初始投影缺少实际fix时间时保留原证据，但不授予有效P含义；不回写或推算其历史时间。此修复沿用既有配置，不另选生产快照年龄。
- Event 分开保存 Watch 触发快照、最后有效 iPhone P、Watch 直传备份 P 与当前有效来源。`IPHONE_PRIMARY` 正常优先；后端以 iPhone P 的服务端接收时间计算 10 秒静默窗口。Watch 直传无需后端先签发 permit，但每次写入仍验证账号绑定、触发 Watch、active event、时间和位置精度，并在 `ACTIVATED + reachable` 时复验静默准入；静默未满时只保存备份事实而不切源。任一有效 iPhone P 立即切回主来源；较旧请求不倒退 fix，同时间或更旧的 Watch 样本不得覆盖 iPhone。
- 当前 bootstrap 的客户端声明只够受控开发环境；公网部署还需要 pair proof、App Attest/设备证明、可信 TLS 公网入口、APNs、滥用防护与数据 retention policy。

## 事件状态

```text
本地 Fall 上下文（120 秒）
       ├─App 回答“需要帮助”────────────▶ ACTIVE / RECRUITING
       ├─App 回答“不需要帮助”──────────▶ 丢弃（后端无事件）
       └─未回答 + 120 秒内观察到外拨───▶ ACTIVE / RECRUITING
                                             ├─一次确认的误触/不再需要──▶ CANCELLED_CONFIRMED_FALSE_ALARM
                                             ├─明确解决/专业接管────────▶ RESOLVED
                                             └─T+35 无状态回答──────────▶ CLOSED_UNCONFIRMED_NO_RESPONSE
```

`RECOVERED_MOTION`、`HEART_RATE_RECOVERED`、`CALL_ENDED`、`WATCH_UNREACHABLE` 只追加时间线（若有），不执行状态转换。

## 运行身份

`RuntimeRoleResolver` 从 REST 可见状态计算 UI：

1. 服务端判定当前稳定 `userId` 存在 active patient event：`PATIENT`。同账号次 iPhone 仍是患者观察态，但是否上传 P 只由 `canPublishEventPosition` 决定。
2. 否则存在已接受且未结束的 assignment：`RESPONDER`。
3. 其他情况：`NEUTRAL`；未决 `response:requested` 作为中立状态上的请求界面展示。

患者优先级不可被 Socket 到达顺序覆盖。收到重复或陈旧实时消息后必须 REST 对账。

角色切换同时切换位置写类型：`NEUTRAL/RESPONDER → R`，`PATIENT → P(eventId)`。待命队列保持 latest-only；客户端必须在服务端为当前设备签发的参与窗口内，对每个合法 UTC 整秒槽产生一条真实 `FIX` 或 `NO_NEW_FIX`；服务端当前保证已收秒槽跨批唯一且 append-only，但在尚无 `stream-finalized`/`sync-complete` 信号时不声称已证明全参与窗口完整。批内为最多五个连续秒槽，正常每 5 秒提交，移动 10 米可提前提交。两者都使用 connection generation + mode 隔离；旧 R 不得在患者激活后落库，旧 P 也不得在终态恢复后覆盖待命 R。

`AEDResponseTestHost` 可在 Debug 中使用本地 fixture 构造上述 UI 状态。该路径必须先断开 live session，不向 REST/Socket.IO 写入，并由 target-specific compilation condition 从生产 target 和 Release 中移除。为避免已发出的连接/写请求与预览交叉，同一进程一旦尝试过 live 连接，必须完全重启 TestHost 才能进入本地场景。

## 响应分配

```text
aedCount     = floor(N / 3 + 0.5)
patientCount = N - aedCount
```

仅仍参与事件的 `ACCEPTED` 响应计入 N；`TIMED_OUT`/`CANCELLED` 退出，`AED_UNAVAILABLE` 重派但不退出，已完成者仍是参与者。角色只允许 `GO_TO_PATIENT`、`FETCH_AED`；服务端先锁定已开始行动/已获取 AED 的任务，再让新接受者按当前公式缺口补位。若锁定任务已超过 N 降低后的目标，保留锁定任务并只调整未开始项。仅在仍为 `ASSIGNED` 且确有必要时可在同一 assignment 上更换角色/路线并产生新 revision；`AED_UNAVAILABLE` 后保留旧 assignment 终态，使用新 assignment ID 创建替代任务并发送 `assignment:created`。客户端不根据接受顺位自行猜测。

响应者调用 `/events/{eventId}/exit` 后立即清除当前位置投影和任务，撤销该事件的读、写与通信权限，并以 exclusive `endedAt` 关闭参与区间；同一稳定 `userId` 不得重入。已落库批次、参与区间和区间内合法的迟到补传证据仍 append-only 保留；退出后新采样必须拒绝，不能用证据补传恢复当前事件权限。

## AED 生命周期

```text
ASSIGNED → EN_ROUTE → ARRIVED_AT_AED
                         ├─ AED_UNAVAILABLE → server reassign
                         └─ AED_ACQUIRED (idempotent) → EN_ROUTE_TO_PATIENT → COMPLETED
```

`AED_ACQUIRED` 由 `receiptId` 以及 `(eventId, assignmentId, aedId)` 去重。服务端确认后广播给全部参与者；所有客户端以 REST event/assignment 快照为最终状态。

## Watch 观察模型

- `CMFallDetectionManager` 回调提供 `date` 与 `resolution`，同一事件可能跨启动重复，因此 Watch 为 fall date 保存稳定 event ID。
- `CXCallObserver` 仅能说明某个 `CXCall` 是 outgoing、connected/ended 等粗粒度状态；没有号码、权威开始时间或累计时长。
- coordinator 缓存最多 120 秒的 Fall 上下文并等待 App 自有帮助回答；“需要帮助”立即上报，“不需要帮助”取消，未回答时才等待新的 outgoing call。`.unresponsive` 单独到达不会上报。
- 上报失败进入受保护 outbox，按原 event ID、正文和来源绑定重试；Fall+35分钟不能新建事件，但未确认正文继续保留，可先GET确认已有事件及权限后精确重放。只有正文ACK才释放待发副本并保存恢复索引；24小时仅用于最小去重marker裁剪。
- 触发、WCSession 即时/后台投递和备用位置是独立契约：触发观察通过手机原样中转或独立授权直传，最终 REST ACK 才释放事件 outbox；reachability 只表示即时消息能力；fallback PUT 携带稳定位置更新 ID。WCSession 不替代 iPhone 自身的持续 P/R 采样，不使用自建 CoreBluetooth 协议。
- fallback 受保护队列另存每条未确认事实的本地来源指纹（issuer/user/account/device/pair的稳定摘要），不改HTTP正文。来源切换只停止旧事实发送并保留队列；缺来源的旧事实必须先GET证明已有事件及权限后再原样重放。Watch Fall context的UserDefaults读写错误必须显式返回，不得以空状态覆盖原字节。
- 首次检测到 iPhone 不可达、或服务端确认连续 10 秒无有效 iPhone P 时，立即尝试一条 Watch 备份 P，此后为 5 秒或累计移动 10 米。进程内节奏不构成降腕、息屏或系统挂起后的严格后台保证，必须在物理 Watch 上单独验证。

## 会话与恢复

- iPhone 必须先完成登录与全部协议/权限门禁，随后用已认证账号会话、设备 ID、协议版本和设备种类 bootstrap。Watch 主链路通过已认证手机取得持久中转绑定；手机自动续期短期上传租约。独立直传另用一次性 ticket 与 App Attest。网络恢复失败不等于撤权，明确退出/撤销仍须停止相应业务授权。
- bearer/refresh 凭据保存在 Keychain，过期按受保护的 refresh 流程轮换；登出会停止定位、断开 REST/Socket、撤销本机与 Watch 会话并清除本地敏感缓存。
- Socket 连接或重连后，iPhone 通过 `GET /events` 和必要的单事件快照恢复角色、请求、任务与 AED 状态，不依赖内部审计查询。
- 位置写入与 Socket 通知可重试；单条接口以 `positionUpdateId` 幂等，事件批次以 `batchId`/`recordId` 幂等，以客户端采样时间防止旧位置倒退，并单独记录 server received/lastSeen。同秒更晚的合格 fix 只能替换尚未提交的本地草稿；批次首次提交即封口，之后只能原样重试，ACK 后才删除本地副本。服务端不虚构后台 1 Hz fix；无真实 fix 的秒槽只能保存有原因的 `NO_NEW_FIX`。
- `event:coordination-updated` 只提供低延迟的 nearby/accepted 计数与 revision 提示；终态、offer、assignment 和 AED 通知到达后均必须通过 REST 重新确认。

## 外部验证门槛

1. Watch Simulator 可以验证 Fall Detection 模拟回调、coordinator 和上报 adapter 的可编译性。
2. `com.apple.developer.health.fall-detection` 必须由 Apple 单独批准并进入实际 provisioning profile。
3. 真机签名、安装、授权提示和真实 Emergency SOS 是否被 `CXCallObserver` 观察到必须各自记录；任一模拟器或 unsigned build 结果都不能替代。
4. 公网传输必须用关闭 Wi-Fi 的物理 iPhone，经蜂窝数据完成 HTTPS/WSS 连接、P/R 写入、状态回推和网络切换恢复；同一 LAN 成功不能替代。

## 已冻结的运行策略

offer 30 秒、改道 15 秒、通信 15/30 秒、1/1.5/2 公里动态扩圈、事件 1 Hz 采集/5 秒批传、Watch 立即备份上传并由后端 10 秒仲裁、REST 单写、16 KiB JSON、AED 急救优先降级、P20 高并发规模以及中国大陆生产/Global Azure 合成测试均已冻结。详见 `requirements.md` 和 `runtime-flow.md`。

### 2026-09-09 终态维护边界（C1）

人工end/resolve、兼容误报及既有到期关闭均调用`backend/src/event-lifecycle.ts`的事务内终态维护函数。它接管事件终态、参与历史区间封口、邀请过期、任务取消及设备事件投影清理；`service.ts`保留原授权、幂等和因果时间检查，并将整个操作共同提交。旧cancelCoordination和重复终态赋值已移除；不会更改AED实际持有状态。内部审计由同事务`event-audit.ts`追加，客户端只读授权恢复投影。C2进一步把同次终态、邀请过期和协调更新写入notificationOutboxById；仍不能据此宣称手机/Watch跨端链路已闭合。


### 结束通知发件箱（C2）

业务事务内为每个已批准受众捕获device/user/account/pair绑定及限定字段payload；服务只生成意图，`notification-outbox.ts`唯一维护发送尝试与完成记录。结束入口及tick不再直接发送对应终态消息。worker复用启动/周期tick，每轮最多100条，按相同messageId/payload批量传输，失败按1秒起步、最多60秒退避；响应丢失重试原resolutionId不会再插入意图。发送前在当前已提交快照检查绑定和事件/邀请关系，Socket层再检查具体会话。默认noop及真实发送器中没有有效Socket的设备都保留待发；发送器返回实际交接设备集合，只有该子集计DISPATCHED。

DISPATCHED只代表已授权payload交给实时传输；SUPPRESSED表示当前绑定/关系已经不再授权，原正文和受众仍保留。发送成功但完成记录写回失败会重发相同messageId；消费者必须去重并以REST快照恢复，不保证exactly-once或用户收到。终态/过期提示是不可重新激活业务的事实提示，不按新产品TTL删除。APNs、非终态通知可靠性、积压容量仍未完成。

存储使用现有SQLite state_items新collection，无DDL变更；缺失旧collection初始化为空，损坏数据拒绝加载。原消息内容/受众不可变，完成记录不可重新变待发。旧程序不认识该collection，回退必须保留前向兼容读取，不能删发送记录或用旧数据库覆盖新增业务事实。全状态clone/校验成本仍存在，不能将这一过渡实现视为存储性能修复。


### Watch状态与历史事实边界（C4a后端）

watch-event-access接管Watch当前绑定和原触发事件权限校验，服务层旧同名私有校验移除。新的GET /watch/events/{eventId}/state只读已提交的四个字段：eventId/state/createdAt/resolvedAt；不调用tick，不扩大到iPhone详情/审计。已知用户必须匹配事件患者，避免同Watch/pair重绑另一账号后重放旧事件。兼容仅保留原无账号导入场景：Watch/session/患者设备均无user/account，且患者identity正好为原规范化生成的legacy-device占位；不把占位当作正式用户，也不将旧记录自动归属给新账号。

fallback原payload/样本时间与首次接收时间保存在既有positionUpdateReceiptsById.watchFallbackFact中，存储校验它与原fingerprint、设备/事件、kind相符且不可修改/删除。终态首次到达样本仅在[createdAt,resolvedAt)内记录历史并ACK，不能更新当前P/任务/人数/终态；旧回执可凭相同指纹重放并补充此次收到的相同原body，不伪造未收到的数据。旧只有摘要的记录仍有证据缺口。C4b已接Watch独立查询、封口与历史分流，Mac组件及编译证据见台账；首次触发ACK丢失恢复仍待C4c，完整跨端运行未验收。

Watch事实在创建receipt时即登记，不能等缓存裁剪后才添加；pruneReceipts只裁剪临时缓存，永久事实显式排除。两事件140条事实与iPhone64条缓存并存及SQLite重启已验证。历史入口还拒绝不可解析/逆序的权威时间窗；NaN不能成为放行条件。这是保真整改，历史增长和全量校验成本仍未解决。


### D1按实体读取已提交状态

state-read定义后端内部StateReadView：捕获一个已提交状态版本，每次get只复制所需实体，不交出内部根状态或可回写引用。Memory、JSON、SQLite三种内建store均实际实现新读路径；auth token解析、Socket每连接权限复验及Watch四字段恢复GET已经改用它，旧对应全状态read停用。Watch授权策略只需devices集合，查询仅装载该Watch及关联患者设备；没有变化的主体、绑定、错误和投影字段。

旧自定义StateStore可经原read兼容，其全状态复制成本保持；不能把fallback适配器称为性能修复。数据库仍全状态装载，写事务仍全量clone/normalize/validate/persistChanges且单队列提交；没有DDL/数据迁移或新的写入权威。实体读优化不能证明目标容量/高并发就绪，后续写事务和历史访问需继续逐用例迁移。

### D13事件位置恢复 grace scheduler 边界

`EventPositionRecoverySchedulerCoordinator` 只维护进程恢复后的 5 秒 grace 等待、事件位置 context/generation lease、pending 循环和停止。它在 lease 有效时回调 AppStore 的恢复推进入口；pending 清空、context 变化、取消或 stop 后结束，不创建位置、不判定 `APP_NOT_RUNNING`、不持久化、不封口、不上传。

AppStore 仍是恢复 cutoff、参与窗口、候选 fix、draft/队列、gap reason、封口和批 ACK/重试的唯一维护者，TestHost 继续显式驱动 controlled recovery。D13 的 Mac 组件链为 25 Phone、78 Watch 及 2 个真实 HTTP/服务重启阶段；generic build 和 81 个 Swift 文件 parse 通过。恢复与批上传完整交错、OS 后台频率、完整 AppStore/UI runtime、真机/Watch 和容量仍需独立验证。

### D14事件位置批上传 single-flight 边界

`EventPositionBatchUploadCoordinator` 只维护已封口事件位置批次的 REST transport task、单飞约束、同一 immutable batch 的退避重试和连接/账号/设备代次 lease。它验证 ACK 与原批次匹配，并将成功、永久拒绝或临时失败交回 AppStore；它不选择队列事实、不删除记录、不改变参与窗口、不创建位置或决定业务终态。

AppStore 仍唯一选择已持久化 pending batch，执行业务门禁、退出时间窗 reconciliation、ACK 后持久化删除、403/409/413/422 隔离和错误投影。D14 的 Mac 组件链为 27 Phone、78 Watch 及两个本地真实 HTTP/服务重启阶段；generic build 和 source parse 通过。真实后台执行、容量、完整 AppStore/UI runtime 和真机/Watch 仍需独立验证。

### E-STORAGE-01 无变化事务写边界

三种内建 StateStore 在完成状态验证和 append-only 校验后，发现状态未变化时跳过状态发布与持久化；SQLite 不再为 no-op transaction 单独推进 revision。真实变更仍按原事务顺序写入，未改变 schema、队列、历史事实或业务语义。该修复只减少无变化写放大；事务前的全状态 clone/validate、启动加载、历史增长和目标负载仍需独立测量。

### E-STORAGE-02 历史增长与受控串行事务基准

`npm run architecture:storage-load` 在隔离临时 SQLite 中同时生成 timeline、notification outbox 和 event-position batch 的合成增长，测量 full/entity read、no-op/append transaction、8 个并发提交的串行化、文件大小、冷启动和重启后计数。50,000 条历史档位的一次 Mac 基准约为 9.82MB 文件、168ms 重启、37.6ms entity read；这是成本证据，不是生产容量或并发验收。

### E-POSITION-INTERLEAVE-01 恢复与批上传交错边界

在原批次 REST 请求挂起期间，恢复 grace 到期追加第二个 pending batch；原批次 ACK 只删除原批次，恢复批次继续留在受保护队列中。该回归使用真实 APIClient、受保护队列和两个实际 coordinator，验证了本地交错边界；不等同于完整 AppStore runtime、OS 后台或真机验收。

### D15 事件位置队列 I/O 边界

`EventPositionQueuePersistenceCoordinator` 唯一执行受保护队列的 load/save，并维护 loaded、unavailable、blocked 生命周期；AppStore 仍唯一维护 `EventPositionQueueState` 的业务内容、context、draft、封口和 ACK 删除。损坏文件和保存失败均 fail-closed，reset 不清除未确认事实。

### D16 delivery receipt 持久化边界

`DeliveryReceiptQueuePersistenceCoordinator` 唯一维护待发送 delivery receipt 的受保护文件、服务/账号/设备 context、append、精确 ACK 删除和失败门；AppStore 只提供当前认证 context、错误投影和既有 REST transport。登出只清内存 owner，不清磁盘；恢复只发送当前 context 的记录，同一 delivery 的 DELIVERED→VIEWED 顺序保持不变。D16 通过 32 Phone + 78 Watch 组件及两个本地真实 HTTP/服务重启阶段；正式签名、完整 AppStore runtime、实际崩溃点、APNs/用户查看、OS 后台和真机仍需独立验证。

### 2026-09-11 创建与通知恢复边界

Watch事件创建事务由watch-event-creation.ts持有，service保留权限/时间适配与既有招募/患者优先策略接线；不存在第二套事件writer。激活通知与事件共同提交，outbox发送前复验受众及状态确认的当前身份。StateReadView.select只复制选取collection记录，不能替代数据库索引或消除事务全状态成本。具体证据及剩余边界见architecture-repair.md的INTEGRATED-BOUNDARIES-RECOVERY。
# 2026-09-26 Watch 互联更新

本文件中旧“WCSession 不传业务触发/位置、Watch 必须独立直报”的描述已由用户新决定替代：主链路为 Watch→iPhone→服务器，独立直传备用。具体身份、事务内撤权检查、原样转发与最终 ACK 契约见 [watch-relay.md](../contracts/watch-relay.md)。手机和手表的“已连接”必须来自实际消息回执，不由独立 App Attest 或系统可达性单独决定。Watch 直传的严格 App Attest 策略未放宽。

持续业务关联不得被 App 退后台、锁屏或短期上传租期到期清除。实现新增系统后台投递、受保护持久 inbox/reply、冷启动接收与 OS 后台重试；短期租期由当前已授权手机自动恢复，明确退出/撤权/账号变更继续隔离。即时回执仅说明当前 live 通道，后台路径就绪单独表示，不把系统物理配对当作实时通信或平台调度保证。
