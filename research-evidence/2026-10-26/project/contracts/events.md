# AEDResponse 实时事件协议 v2

业务传输使用网络 REST + Socket.IO，不使用蓝牙，也不要求 iPhone 加入 Tailscale。REST 是状态真相；Socket.IO 只降低通知延迟。除 `system:ready` 外，事件消息都包含 `schemaVersion: "2.0"`、`eventId`、稳定消息 ID 和 ISO-8601 `occurredAt`。客户端必须按 ID 幂等处理，Socket 连接或重连后先通过 REST 拉取未完成 event、当前 delivery/assignment，再恢复角色与位置上报；内部审计不作为客户端恢复依赖。

认证后的 device session 决定房间与可见范围，客户端不得自报患者、响应者或管理员角色。

会话撤销以成功提交为准，服务器主动断开该会话的已有 Socket；同设备其他仍有效会话不随之撤销。每次发送按具体连接重新核对有效期、scope、账号与设备绑定，不以房间名或共享 tokenHash 的其他连接替代授权。握手异步初始化完成后也必须复验，再发送 `system:ready`。已交给传输层的旧消息无法收回；客户端仍须按原 connection generation 抑制旧回调并 REST 恢复。该规则不把 logout 解释为 end/exit，也不表示跨实例撤销或 APNs 已验证。

## 服务端 → iPhone

所有事件先使用公共 envelope `{schemaVersion,messageId,eventId,occurredAt}`，再附加下表字段；未列出的字段不得用于角色或状态决策：

| Socket event | envelope 之外的字段 | 接收者 |
| --- | --- | --- |
| `event:patient-activated` | `state`, `recruitmentState` | 患者 iPhone |
| `response:requested` | `deliveryId`, `deliveryStatus`, generic `eventType`, coarse `distanceRange`/`etaRange`, `currentRecruitmentRadiusMeters`, `expiresAt`, `positioningTier=SEARCH_RING` | 当前合格候选 |
| `response:offer-expired` | `deliveryId`, `expiresAt`, `reason` | 对应候选 |
| `event:patient-position-updated` | `coordinationRevision` | 患者、已接受者 |
| `event:coordination-updated` | 完整 `coordination` | 患者、已接受者 |
| `event:status-confirmation-requested` | `confirmationId`, `prompt=STILL_IN_PROGRESS`, `responseDeadlineAt` | 患者设备 |
| `event:participant-exited` | `coordinationRevision` | 患者、仍参与者 |
| `response:decision-recorded` | `decision`, `coordination` | 患者、已接受者 |
| `assignment:created` / `assignment:updated` | `assignment` | 任务本人 |
| `aed:acquired` | `assignmentId`, `aedId`, `receiptId`, `acquiredAt` | 患者、已接受者 |
| `aed:unavailable` | `assignmentId`, `aedId` | 患者、已接受者 |
| `assignment:timed-out` | `assignmentId` | 患者、已接受者 |
| `event:false-alarm-confirmed` / `event:resolved` | `state`, `recruitmentState` | 患者、已接受者 |
| `event:closed-unconfirmed-no-response` | `state=CLOSED_UNCONFIRMED_NO_RESPONSE`, `recruitmentState=STOPPED` | 患者、已接受者 |

### `event:patient-activated`

发送给与 Watch 上报关联的 iPhone 会话，以及同一 `userId` 的其他患者观察设备。
客户端立即按患者优先规则切换 UI。
若该稳定用户此时正作为其他事件的响应者，后端必须在同一事务内以
`PATIENT_PRIORITY` 结束旧响应者参与区间并创建新患者事件；新事件的
`createdAt` 必须与旧区间 exclusive `endedAt` 完全相同。当旧事件已因撤权不再可见时，iOS 以新患者事件
`createdAt` 作为位置参与边界，不得自行推断重叠或缺口。

```json
{
  "schemaVersion": "2.0",
  "messageId": "message-patient-001",
  "eventId": "REDACTED-ID-fd79d0ebfe5575b6",
  "occurredAt": "2026-08-31T01:02:04.000Z",
  "state": "ACTIVE",
  "recruitmentState": "RECRUITING"
}
```

### `response:requested`

只发送给附近、已签署志愿响应者协议、当前不是患者的认证 iPhone session。收到请求不计入有效响应人数。
该 offer 的发件箱记录在有效期内保持可重试；一次 Socket handoff 不会把它解释为用户已收到，过期或失去资格时才由授权复核标记为完成或抑制。相同 `messageId` 的重试必须由客户端幂等处理。

```json
{
  "schemaVersion": "2.0",
  "messageId": "message-request-001",
  "eventId": "REDACTED-ID-fd79d0ebfe5575b6",
  "deliveryId": "REDACTED-ID-452acf32ac12bd39",
  "deliveryStatus": "SENT",
  "occurredAt": "2026-08-31T01:02:04.100Z",
  "eventType": "FALL_ASSISTANCE",
  "positioningTier": "SEARCH_RING",
  "distanceRange": "DISTANCE_500_1000M",
  "etaRange": "ETA_5_10_MIN",
  "currentRecruitmentRadiusMeters": 1000,
  "expiresAt": "2026-08-31T01:02:34.100Z"
}
```

pending offer 与中立候选的 REST/Socket 投影不得携带精确 `PatientPosition`、地址卡、
患者身份、Fall resolution、App help/call 观察或完整 coordination。只有接受成功的
`RESPONDER` 才能通过 REST 取得精确 P 和可选 location card；患者端只看自己的必要
位置/触发信息与聚合状态，不看响应者个人资料。接受前的距离和 ETA 只能使用服务端
固定分桶，不能反推出精确坐标。

### `response:offer-expired`

服务端在 30 秒 offer 到期或候选失去资格时，只向对应候选发送公共 envelope 加
`deliveryId`、服务端 `expiresAt` 和 `reason`。该通知不携带患者位置、地址卡、触发细节或
coordination；客户端应通过 REST 对账，过期/拒绝的 delivery 不再获得同一事件的重复 offer。

候选只接收定向的 `response:requested` 和自己的 `response:offer-expired`。候选未接受前
不属于 coordination、patient-position 或 assignment 的 Socket 受众；这些事件只发送给患者
和仍参与事件的已接受响应者。

### `event:patient-position-updated`

发送给患者和已接受响应者。payload 除公共 envelope 外只携带 `coordinationRevision`；消息只表示患者当前 P 已变化以及 event revision 已前进，客户端收到后必须通过 REST 获取可见的最新位置和任务状态。

### `event:coordination-updated`

位置、候选、接受/拒绝、任务、到达、AED 或终态发生变化时，服务端向该事件的患者和已接受响应者发送聚合提示。不得向参与者广播其他响应者的设备 ID 或精确 R。

```json
{
  "schemaVersion": "2.0",
  "messageId": "message-coordination-004",
  "eventId": "REDACTED-ID-fd79d0ebfe5575b6",
  "occurredAt": "2026-08-31T01:02:06.000Z",
  "coordination": {
    "revision": 4,
    "currentRecruitmentRadiusMeters": 1500,
    "nearbyCandidateCount": 2,
    "pendingOfferCount": 2,
    "acceptedResponderCount": 3,
    "goToPatientCount": 2,
    "fetchAedCount": 1,
    "enRouteCount": 3,
    "arrivedAtAedCount": 0,
    "arrivedAtPatientCount": 0,
    "aedAcquiredCount": 0,
    "completedAssignmentCount": 0
  }
}
```

`currentRecruitmentRadiusMeters` 只沿 `1000 → 1500 → 2000` 米扩大，事件内不缩小。
`nearbyCandidateCount` 是当前圈可继续接收 offer 的唯一 stable user 数（已有 live offer
或从未有 delivery 的合格用户），不包含已拒绝/已过期且不会重发的身份；
`pendingOfferCount` 是其中仍有 live delivery 的子集。`acceptedResponderCount` 是仍参与事件
的已接受唯一用户数。初始有效 P 后，若潜力（accepted + 可继续候选）不足 3，事务内立即扩到
下一档；潜力达到 3 但 30 秒内 accepted 仍不足 3，则扩下一档并重置该档计时；到 2km 后
按实际 N 继续补招。offer 的 `expiresAt` 由服务端保存并作为真相，恰好 30.000 秒仍可接受，
超过后转 `EXPIRED`；拒绝和超时不计 N。只有新进入当前圈且该用户从未有 delivery 才创建
offer。角色数包含这些参与者除 `TIMED_OUT`/`CANCELLED` 外的 current assignment。
`enRouteCount` 统计 `EN_ROUTE` 与 `EN_ROUTE_TO_PATIENT`；`arrivedAtAedCount` 只统计当前
`ARRIVED_AT_AED`，获取后回落；`aedAcquiredCount` 按事件内已持久化的唯一有效 AED 回执累计，
后续状态前进不回落；`arrivedAtPatientCount` 统计 `ARRIVED_AT_PATIENT` 与 `COMPLETED`；
`completedAssignmentCount` 只统计 `COMPLETED`。每次会改变任一 REST projection 的动作都递增
`revision`，同一事务产生的多个 Socket 提示共享该 revision；pending 候选不在
coordination/patient-position/assignment 的 Socket 受众内，只会收到自己的 offer 和过期通知。

### `response:decision-recorded`

接受或拒绝落库后向事件患者和已接受响应者发送聚合变化提示。payload 是公共 envelope 加 `decision: "ACCEPT" | "REFUSE"` 和完整 `coordination`；不携带响应者设备 ID。接受者自己的 assignment 仍只通过定向的 `assignment:created` / `assignment:updated` 下发。只有持久化且仍参与事件的 `ACCEPT` 计入 N；接受前的候选不会收到该完整聚合。
业务事务提交前会为每个已授权 iPhone 受众写入稳定 messageId 的服务端待发送记录；Socket handoff 失败时记录保留并在恢复后按当前会话/设备授权重试。收到 transport handoff 不等于用户已收到或查看。候选请求、过期、患者激活、位置/coordination、状态确认、退出、AED 广播、assignment 与终态消息均遵循同一发件箱边界；`replayPendingResponses` 是按当前 REST 权限生成的快照恢复，不是历史送达凭证。

### `assignment:created` / `assignment:updated`

两种消息 payload 都是公共 envelope 加当前 `assignment`。它们只定向发送给任务本人；其他参与者通过不含设备身份的 `event:coordination-updated` 获知总体进度。角色只允许 `GO_TO_PATIENT` 或 `FETCH_AED`。`FETCH_AED` 必须携带顺序严格为 `R,A,P` 的 route。人数变化可能产生新的 assignment revision，客户端不得用接受顺位自行推断。
响应接受、响应者退出和患者位置路线刷新触发的 assignment 重算，以及普通 assignment 状态推进的 `assignment:created`/`assignment:updated`，会在同一业务事务内写入服务端待发送记录；发送时仍需验证当前 assignment revision、任务本人身份和已接受参与关系。专用 AED/替代任务入口的 assignment 通知仍按各自迁移批次处理。
显式任务进度请求中的 `occurredAt` 不能早于当前 assignment 的 `updatedAt`；服务端以
`min(occurredAt, serverReceivedAt)` 作为新 revision 的权威时间。

### `aed:acquired`

服务端接受首次幂等回执后广播给事件全部参与者。

```json
{
  "schemaVersion": "2.0",
  "messageId": "message-aed-acquired-001",
  "eventId": "REDACTED-ID-fd79d0ebfe5575b6",
  "assignmentId": "REDACTED-ID-d43df84b929bfecc",
  "aedId": "aed-demo-01",
  "receiptId": "REDACTED-ID-f48ef3737dc6ef74",
  "acquiredAt": "2026-08-31T01:06:00.000Z",
  "occurredAt": "2026-08-31T01:06:00.100Z"
}
```

重复的同一回执必须产生相同状态，不得让第二名响应者重复领取该 AED。
请求中的 `acquiredAt` 是客户端声明，不得早于当前 assignment 状态；持久化并返回的
canonical 回执使用 `min(acquiredAt, serverReceivedAt)`，快钟不能制造未来任务状态。

### `aed:unavailable`

发送给事件全部参与者，payload 是公共 envelope 加 `assignmentId`、`aedId`。旧 assignment 保持 `AED_UNAVAILABLE` 终态；任务本人若获得替代任务，服务端使用新 assignment ID 并单独发送 `assignment:created`。客户端保留旧 assignment/timeline，不原地改写历史。
`reportedAt` 同样是受当前 assignment 因果下界约束的客户端声明，旧任务、替代任务和广播
统一使用不晚于服务端接收时刻的 effective 时间。
若服务端在同一事务内创建替代 assignment，其 `assignment:created` 待发送记录与不可用事实共同提交；Socket handoff 失败时按替代 assignment 的当前授权和 revision 恢复。`aed:unavailable` 和 `aed:acquired` 的广播意图也在相应 AED 事实事务内入箱，发送时重新检查事件参与关系。

### `event:false-alarm-confirmed`

患者在外拨后明确确认误报。payload 是公共 envelope 加 `state=CANCELLED_CONFIRMED_FALSE_ALARM`、`recruitmentState=STOPPED`。患者和所有响应者立即清除活动任务/导航并回到中立待命；REST 终态 projection 的 `viewerRelationship=NEUTRAL`、`pendingResponseRequest=null`，`currentAssignment` 在无活动 assignment 时省略，内部 timeline 保留。该消息不表示、也不能导致 Apple 系统电话被取消。

### `event:resolved`

仅由患者明确操作、到场响应者明确操作或授权后台人工流程产生。payload 是公共 envelope 加 `state=RESOLVED`、`recruitmentState=COMPLETED`。患者和所有响应者立即清除活动任务/导航并回到中立待命；REST 终态 projection 的 `viewerRelationship=NEUTRAL`、`pendingResponseRequest=null`，`currentAssignment` 在无活动 assignment 时省略，内部 timeline 保留。

### `event:status-confirmation-requested`

事件开始 30 分钟，服务端为患者设备创建一个持久化的五分钟状态确认窗口；同一窗口
只发送一次。payload 只包含确认 ID、固定问题标识和服务端截止时间。患者通过
`POST /events/{eventId}/status-confirmation` 提交 `response=CONTINUE`；成功后重新开始
30 分钟周期，重复提交同一确认 ID 返回相同 ACK。

### `event:participant-exited`

响应者主动退出后向患者和仍参与者发送公共 envelope 与 coordination revision；退出设备
不在受众中，也不会收到患者位置、团队 coordination 或后续 assignment 通知。退出的稳定
`userId` 在该事件内永久排除，退出事实和被取消的 assignment 保留在内部 timeline。

### `event:closed-unconfirmed-no-response`

状态确认窗口在 T+35 分钟仍无回答时，服务端将事件置为
`CLOSED_UNCONFIRMED_NO_RESPONSE/STOPPED`，广播该终态并保留完整状态确认记录与 timeline。
该状态表示未确认关闭，不表示问题已解决；电话结束、App 关闭、权限变化、断网、无响应
者或普通经过时间本身不会触发该转换。

### `assignment:timed-out`

当前 assignment 超时；服务端重新招募/分配，不未经接受直接把中立用户算入 N。

## iPhone → 服务端 REST

### `PUT /me/presence`

iPhone 在协议/权限/可参与状态变化时提交 `presenceUpdateId`、`occurredAt`、`availableForResponse` 以及通知和定位 capability。可参与状态是待命意愿，不是手动角色选择。服务端记录 `lastSeen`；同一 ID 同内容幂等，同一 ID 不同内容返回 409；较旧更新成功返回当前 projection 但不得覆盖新值，相同时间不同内容返回 409。bootstrap 只初始化尚不存在的 presence，不用 session 轮换覆盖较新的更新。

### `PUT /me/responder-position`

中立/可响应 iPhone 定期提交严格 `ResponderPosition (R)`：

```json
{
  "positionUpdateId": "REDACTED-ID-674108a4b5e5d778",
  "observedAt": "2026-08-31T01:02:05.000Z",
  "responderPosition": {
    "kind": "R",
    "latitude": [COORDINATE_REMOVED],
    "longitude": [COORDINATE_REMOVED],
    "accuracyMeters": 10
  }
}
```

### `PUT /events/{eventId}/patient-position`

该接口仅作为旧客户端的 latest-only 过渡兼容路径。生产 iPhone 在事件中只使用下文严格秒槽 `position-batches`，不与本接口双写；批次中的 P `FIX` 会同时更新患者最新位置投影。Watch 的触发时位置仅可作为初始快照。兼容请求形式如下：

Watch 触发快照新增 `patientPositionObservedAt`，来源必须是原始 `CLLocation.timestamp`，不得使用Fall/外拨观察/重试时间替代。后端分别保存该fix时间、事件观察时间和接收时间，按已有配置判断地理资格。旧触发payload缺少fix时间仍按原内容保存和幂等处理，但其坐标不得初始化有效P；历史记录不补造时间、不修改指纹。新字段与strict旧服务端不兼容，未来上线必须先更新服务端，本轮未部署。

```json
{
  "positionUpdateId": "REDACTED-ID-1074c5360ac52e63",
  "observedAt": "2026-08-31T01:02:05.500Z",
  "patientPosition": {
    "kind": "P",
    "latitude": [COORDINATE_REMOVED],
    "longitude": [COORDINATE_REMOVED],
    "accuracyMeters": 12
  }
}
```

两个单条位置接口遵守同一规则：

- 同一 `positionUpdateId` 与相同规范化内容重放，返回幂等成功；同一 ID 复用为不同内容返回 409。
- 客户端采样时间早于服务端当前样本时返回成功但 `applied=false`，不得让位置倒退；相同采样时间但内容不同返回 409。
- 服务端分别保存 `observedAt`、`serverReceivedAt` 与 `lastSeenAt`。单条接口只保存最新位置和有界幂等回执；完整事件轨迹只能通过下述事件批次入口追加保存。
- 新鲜度按服务端当前时间减去 `observedAt` 计算；在配置允许的未来时钟偏差内按 age=0，超过偏差的未来样本返回 409。收到重试只更新 `lastSeenAt`，不得改变原始 `serverReceivedAt` 或让旧坐标恢复新鲜。
- P 更新会重新计算距离和候选并推进 coordination revision；R 更新会重新计算该设备对所有 active event 的资格。
- 患者不得向 R 接口写入，其他设备不得向该事件 P 接口写入；P/R/A 类型混用必须拒绝。

### `POST /events/{eventId}/end`

患者只通过这一个结束入口完成一次确认。body 为 `{resolutionId, reason, endedAt, note?}`，
`reason` 只能是 `FALSE_ALARM`、`PROBLEM_RESOLVED` 或 `PROFESSIONAL_TAKEOVER`；前者映射
`CANCELLED_CONFIRMED_FALSE_ALARM/STOPPED`，后两者映射 `RESOLVED/COMPLETED`。同一
`resolutionId` 与相同内容重放幂等，事件事实和终态广播仍保留。到场响应者的专业接管
确认继续使用带 `actor=ON_SCENE_RESPONDER` 的 `/events/{eventId}/resolve`，服务端要求
其 assignment 已到达患者。`endedAt`/`resolvedAt` 是客户端声明时间，不是服务端权威时间：
慢钟声明不会阻止患者的一次确认结束。实际写入 `event.resolvedAt`、参与区间结束点和广播
envelope 的时间为 `max(min(clientClaimedAt, serverReceivedAt), causalLowerBound)`；其中
`causalLowerBound` 是事件创建时间以及本次终止会关闭的开放参与区间、当前 assignment、
pending delivery、已保存位置证据和状态确认提示时间中的最大值。`425` 又保证证据下界不
晚于服务端接收时刻，因此结果既不回溯已有事实也不会位于未来。

### `POST /events/{eventId}/status-confirmation`

患者设备在服务端当前确认窗口内提交：

```json
{
  "confirmationId": "REDACTED-ID-7e6c781e66cb4d0f",
  "response": "CONTINUE",
  "respondedAt": "2026-08-31T01:36:00.000Z"
}
```

只有 `CONTINUE` 会被接受；它不会结束事件，只会重启新的 30 分钟周期。窗口过期或
事件已终态时拒绝；`respondedAt` 是客户端声明，不能早于该确认的 `sentAt`，持久化时间不
晚于服务端收到请求的时间。同一原始声明的重试使用持久化指纹保持幂等；所有窗口记录按
确认 ID 保留用于恢复与审计。

### `POST /events/{eventId}/exit`

已接受响应者提交 `{exitId, exitedAt, reason?, soleResponderConfirmed?: true}`。服务端在同一事务中将其活动 assignment
取消、清除该稳定用户的当前位置投影/当前任务、撤销事件通信受众并写入退出事实；已落库的按秒位置批次、参与区间和退出前补传证据不删除不覆盖。该
`userId` 永久禁止重新接受同一事件。`exitedAt` 是客户端声明；若其早于接受、当前
assignment 状态或该用户已保存位置证据，服务端不会因慢钟拒绝退出，而是把权威退出
时间夹紧为 `max(min(clientClaimedAt, serverReceivedAt), causalLowerBound)` 并立即撤权。
同一原始
声明的 `exitId` 重放幂等，其他身份或未接受候选不得调用。

唯一响应者必须先完成 1/3、2/3、3/3 三次明确确认，才能发送
`soleResponderConfirmed: true`；任一步取消均不发送退出。普通退出省略此字段。
服务端以事务内稳定身份去重后的有效响应人数为准，不信任客户端人数；如果只剩调用者且
未携带该确认声明，返回 `409`、problem type
`https://aedresponse.invalid/problems/sole-responder-confirmation-required`，不改变参与状态、证据或权限。
客户端遇到此竞态须重新展示三次确认，不能自动补上字段。该字段是客户端确认声明，
不能独立证明用户实际点击了屏幕。网络结果不确定时重试必须保持原 `exitId`、时间与完整正文。

退出成功后客户端以 ACK 的 `exitedAt` 关闭位置参与窗口并撤掉患者/团队信息；退出者已不能
通过事件读取接口取得窗口。退出前的原样证据仍可补传，不删除未 ACK 的证据。
N 降为 0 不自动结束事件，继续按原规则招募；仍有响应者时重算未开始任务，
保留已在途/已取得 AED 的锁定工作。AED 补位比较 R→A→P 两段实际步行路线的总距离，
无可用 AED 时前往患者，不阻塞接受和退出。

响应半径、位置新鲜度和允许精度来自服务端配置。距离、时效与精度恰好等于边界时合格，超过边界时排除。offer 在接受时必须再次验证协议、权限、可用状态、最新 R、当前动态半径、stable user 身份和活动任务冲突。

### `PUT /events/{eventId}/position-batches/{batchId}`

患者 iPhone 或已接受响应者 iPhone 使用同一个事件级 REST 写入口提交每秒位置事实。服务端
从认证 session 和事件参与关系推断该批次是 P 还是 R；客户端不能自报其他参与者或通过
pending offer 写入事件证据。请求最多包含五条 `records`，每条使用稳定的 `recordId`、
UTC 整秒 `slotAt` 和以下两种严格形式之一：

```json
{
  "schemaVersion": "2.0",
  "eventId": "REDACTED-ID-fd79d0ebfe5575b6",
  "batchId": "REDACTED-ID-21ceb9f896bd7585",
  "records": [
    {
      "recordId": "REDACTED-ID-6745c2e264b2700e",
      "slotAt": "2026-09-05T01:02:05.000Z",
      "status": "FIX",
      "fixObservedAt": "2026-09-05T01:02:05.500Z",
      "position": {
        "kind": "P",
        "latitude": [COORDINATE_REMOVED],
        "longitude": [COORDINATE_REMOVED],
        "accuracyMeters": 12
      }
    },
    {
      "recordId": "REDACTED-ID-7a03c8ac6aab6f72",
      "slotAt": "2026-09-05T01:02:06.000Z",
      "status": "NO_NEW_FIX",
      "gapReason": "NO_FIX"
    }
  ]
}
```

`slotAt` 必须是 UTC 且毫秒为零（`...:05Z` 或规范化的 `...:05.000Z`）；批内 `recordId`
和 `slotAt` 均唯一。`FIX` 必须携带与 session 角色相符的严格 P/R 及
`fixObservedAt`，且 `fixObservedAt ∈ [slotAt, slotAt + 1s)`；不得携带 `gapReason`。
`NO_NEW_FIX` 必须携带且只能携带 `gapReason=NO_FIX|APP_NOT_RUNNING`，不得携带坐标或
`fixObservedAt`。每个批次的秒槽必须严格连续。新批次只有在其中最后一个秒槽已完整结束
（`max(slotAt)+1s <= serverReceivedAt`）时才可落库；仍开放或来自快钟的槽返回可重试
`425 Too Early` 且不保存任何记录，客户端随后必须原样重试。服务端对 `slotAt` 与
`fixObservedAt` 仍执行最大未来偏差校验；当前设备自身的权威参与窗口为
`[eventPositionParticipationStartedAt, eventPositionParticipationEndedAt)`，首个合法槽是不早于开始时刻的第一个 UTC 整秒，结束边界为 exclusive。最新 P/R 投影按 `fixObservedAt` 更新。服务端在同一事务中先保存
append-only 批次和记录，再返回每条记录的持久化/陈旧投影结果。客户端在收到该 ACK 前必须
保留整个批次；同一 `batchId` 与相同内容重放返回相同 ACK，跨批占用同一
`eventId+userId+deviceInstanceId+slotAt` 或改写记录返回 `409`。六条记录返回 `422`，不是
部分接受。一个 slot 在所属批次首次发起提交前保持开放；此前同秒观测时间更晚的合格 fix 可替换草稿。首次提交时，批内 slot 和 record 内容就在客户端永久封口；未收到 ACK 只能原样重试，不得使用迟到 fix 做 correction 或替换。ACK 只决定何时可删除本地重试副本。若未 ACK 批次后来被 REST 权威参与窗口判定为跨界，只允许用新 `batchId` 重组内容完全不变的合法 records；越界 records 必须原样追加进 append-only 隔离证据。提前提交的 1–4 条连续部分批次也按同一规则立即封口。App 重启时客户端先等待最多 5 秒接收系统历史 fix；旧进程已 clock 但无 fix 的槽保持 `NO_FIX`，真正属于进程未运行时段且仍无 fix 的槽记录为 `APP_NOT_RUNNING`。无法从旧 `observedAt` 推导真实秒槽的历史批次会从活跃批次索引移入
持久化 `quarantinedLegacyEventPositionBatchesById` 隔离区，原始批次完整保留且不参与业务
slot/最新位置计算；不会删除事件证据。

不同批次可因离线重试而乱序到达，因此服务端不能仅凭请求到达顺序把暂未到达的中间秒槽判为丢失。它始终拒绝同一设备/事件/秒槽的第二条记录；只有在未来收到明确的 `stream-finalized`/`sync-complete` 信号或执行留存截止审计时，才能以权威参与窗口核对所有秒槽。缺失只能作为未收到证据的异常缺口，不得由服务端自行补造。
当前参考后端尚无上述客户端“该流已同步完成”信号，因此不会在正常写请求中把临时缺口固化为
最终审计结论；最终全窗缺口核对需要后续持久审计任务在收到明确完成信号或到达留存截止点
后执行。此限制不削弱已落库秒槽的唯一性，也不能成为拒绝乱序合法重试的理由。

位置证据的历史授权以持久化 `participantIntervalsById` 为准：区间从接受时开始，退出、
超时、取消、患者优先或事件结束时只设置一次 exclusive `endedAt`，不会从可变 delivery
状态反推或删除历史参与资格。事件 REST projection 中的
`eventPositionParticipationStartedAt`/`eventPositionParticipationEndedAt` 只描述当前认证设备
自己的位置证据窗口：患者主 iPhone 从 `event.createdAt` 到权威 `event.resolvedAt`，响应者
设备从 `acceptedAt` 到区间的 exclusive `endedAt`；从未取得写入权的设备为 `null/null`。
服务端不返回其他参与者的窗口或身份。显式退出者仍立即失去整个事件的读取与通信权限，
不能借此字段重新取得患者位置、团队状态或加入资格。

事件证据不会追加到普通 timeline 文案。FIX 只有在比当前事件/设备 projection 更新且仍
满足当前新鲜度、精度边界时才更新最新 P/R；旧 FIX 仍保留为证据但不能覆盖新样本。事件参与
位置按批次持久化，非事件待命/搜索圈位置继续只保留最新值，并在超过 10 分钟后物理删除。

### 动态招募与定位频率信号

每个 active event 持久化 `currentRecruitmentRadiusMeters` 和
`recruitmentStageStartedAt`。服务端在 P/R/presence/offer decision、事件 GET 以及
`service.tick()` 中推进 offer 过期和扩圈；本地服务生命周期会启动可停止、无重入的短周期
tick，生产部署应以持久队列/调度替换该进程内驱动，并继续使用持久时间戳补算。`positioningTier` 只表达客户端频率策略：待命为 `STANDBY`
（120 秒/100 米），pending 搜索圈为 `SEARCH_RING`（15 秒/30 米），患者或已接受
响应者为 `EVENT_PARTICIPANT`。后端批次入口保存客户端提交的真实 fix 或 `NO_NEW_FIX`，
但不在后台虚构或补采 1 Hz；实际采样和离线加密队列由客户端负责。

## Socket client boundary

Socket.IO 仅承载服务端通知。客户端不得发送 `delivery:receipt` 或任何业务写
事件；delivery receipt 按 `SENT → DELIVERED → VIEWED → ACCEPTED/REFUSED` 的规则
通过 `PUT /events/{eventId}/deliveries/{deliveryId}/receipt` 写入。位置真相也只
通过 REST 位置接口提交。

## Watch 上报不走 Socket.IO

Watch 使用 OpenAPI 的幂等 `PUT /watch/emergency-observations/{eventId}` 直报触发。body
必须带 `appHelpResponse`：`NEEDS_HELP` 立即成立；`NO_RESPONSE` 只有同时带有
`callFirstObservedAt`，且该时间位于 `fallDetectedAt` 后 120 秒内才成立；`DECLINED`
不是合法事件上报，客户端应清除上下文，服务端拒绝且不创建 event。`callFirstObservedAt`
只记录客户端观察到的外拨状态，不代表号码、接通状态或短信投递。事件
`triggerSource` 仅为 `WATCH_FALL_HELP_CONFIRMED` 或
`WATCH_FALL_NO_RESPONSE_OUTGOING_CALL_OBSERVED`。服务端还拒绝超过
`fallDetectedAt + 35 minutes` 的新事件观察（边界时刻可接受）；已成立 event 的同一
`eventId` 重放仍保持幂等。

Watch 使用独立的 `PUT /watch/events/{eventId}/fallback-position/{positionUpdateId}` 直接
提交 P。body 必须声明 `activationState`、`iphoneReachable` 和 `networkAvailable`；Watch
自身网络可用，且 iPhone 不同时处于 `ACTIVATED + reachable`——或已由后端确认连续 10 秒
无有效 iPhone P（即下方事件状态快照的 `fallbackAllowed=true`）——才能写入。服务端在同一
事务内重新检查 active event、同一绑定 user/pair 的 triggering Watch、时间/精度/新鲜度、
来源顺序和幂等。首个有效 Watch 样本可先存为候选；从 event `createdAt` 或最后有效
iPhone P 的 `serverReceivedAt` 起连续 10 秒没有有效 iPhone P 后，候选才成为
`WATCH_FALLBACK`；已有 10 秒静默时首个样本可立即生效。

有效且更新的 iPhone P 到达立即恢复 `IPHONE_PRIMARY` 并清除候选；旧或迟到的 Watch
样本不能覆盖 iPhone。后续 Watch 上传以 5 秒为正常节奏，移动累计 10 米可提前上传；
服务端记录 cadence evidence，但不以普通位置限流阻止合法补传/重试。无网络的 Watch
不得借请求创建或结束 event。来源切换只通过既有
`event:patient-position-updated` / `event:coordination-updated` 提示客户端 REST 对账。


### 结束消息的持久发送语义（2026-09-09 C2）

`event:resolved`、`event:false-alarm-confirmed`、`event:closed-unconfirmed-no-response`及同次结束产生的`response:offer-expired`/`event:coordination-updated`现在从事务发件箱发送。消息名称、messageId构造、字段和既有受众边界不变；服务器发送时复验设备绑定与事件/邀请关系。可能重复、可能延迟，不能视为新的全局写入或已查看回执。客户端收到提示后恢复后端授权快照；事件结束不能解释为AED已归还。

已提交结束不会因发送器异常伪装成业务事务失败。canonical end/resolve仍用原resolutionId做同内容重试、异内容409；legacy误报接口的终态409保持原义。消息传输成功不等于用户收到；当前没有有效Socket的设备保持待发，重连后按原messageId补发。非终态消息与APNs能力另行整改。


### 手机结束意图（C3）

患者按钮以稳定resolutionId/reason/endedAt调用既有POST `/events/{eventId}/end`；响应者以稳定resolutionId/actor/reason/resolvedAt调用既有POST `/events/{eventId}/resolve`。actor授权仍由后端执行，响应者reason保持PROFESSIONAL_TAKEOVER。客户端重试不得替换ID/时间；409本身不代表任何特定终态，恢复后应用服务器实际state。旧confirm-false-alarm接口仍保持原权限和终态409，但不再承担新版按钮的稳定重试路径。


### Watch恢复与终态历史上传（C4a）

Watch的独立状态读取为GET `/watch/events/{eventId}/state`，只返回eventId/state/createdAt/resolvedAt。须为原触发Watch、有效当前绑定并满足已知患者身份，普通iPhone事件GET仍不向Watch开放。暂时请求失败或403/409不等于终态；仅后端明确state进入终态才停止该事件的新采集。

历史fallback继续发送保存的原PUT正文（同positionUpdateId、observedAt、连接事实和坐标），不重新贴时间戳。首次终态后上传须在后端[createdAt,resolvedAt)内；200 applied=false/ignoredAsStale=true表示已记录证据但不应用当前P。越界409应隔离保留记录，不能清空整个队列。收到明确终态也不代表AED已经归还。

C4b客户端按上述GET保存有限有序封口窗口，终态后停止新采集；待发记录只在同ID ACK后移除，越界或内容拒绝单条隔离保留。状态查询与合法历史不被当前手机可达性阻断。授权失效暂停写入，暂时错误稳定退避；均不能重新生成采样时间或将错误码当作终态。


### Watch触发重放与本地交接（C4c）

35分钟是首次创建截止；已创建事件的同ID同正文重放仍按原API返回200，不新建事件、邀请或终态消息。超期客户端先GET确认存在及权限，随后原PUT确认内容，GET不能替代ACK；PUT409保留原观察而非假定终态。200/201须具有匹配event id和有效state，客户端才原子保存恢复ID并释放重试正文。旧版已经删除的正文无法恢复，不补造。新版暂停采集时只能恢复已存在事件；首次创建和状态/历史恢复分别受门禁与后端授权约束。


### Watch触发重试的本地来源约束（D2）

`WatchSessionResponse.userId/accountId`继续是必需字段。客户端将服务端给出的主体与issuer/device/pair形成稳定的本地来源指纹，保存于Fall context及观察outbox；不向观察HTTP正文增加字段，不把来源指纹当作后端凭据。合法token刷新不改变来源；已知主体的refresh响应不得换成另一user/account。

来源不明的旧观察不得在新会话下首次创建：保留原正文，先用现有四字段Watch GET证明事件已存在且当前会话有权访问，再用同一来源代次精确重放原正文以取得ACK。GET404不能清记录或授权新创建。该限制在35分钟内也成立；不改变服务端的首次创建截止或原设备跨账号绑定拒绝。


### Watch 备用上传准入变化（2026-09-11）

Watch 事件快照可选字段 `fallbackAllowed` 由后端计算。用户批准手机可达但后端连续10秒没有有效手机位置时启用备用上传；客户端缺失此字段时不据此放宽旧准入。后端每次新写入重新判定，快照许可不是持久授权。判定变化返回403 problem type `https://aedresponse.invalid/problems/fallback-admission-changed`；Watch暂停采集、重新查询并保留未确认事实，不将此错误归入永久账号权限失败。幂等重放与合法终态历史沿用既有规则。


### 2026-09-13 患者取消救助

新增 `event:assistance-withdrawn`，公共 envelope 加 `state=CANCELLED_ASSISTANCE_WITHDRAWN` 与 `recruitmentState=STOPPED`。患者在 App 内完成三次确认后提交 `ASSISTANCE_WITHDRAWN`，已有事件位置与参与区间终止于服务端确认的时间，保留原记录。此结果独立于误报和成功结束；接收端清理活动任务并通过 REST 对账。

账户注销采用逻辑 `CLOSED`，退出设备采用 `SIGNED_OUT`；旧凭据撤销后不能接收新消息或上传新位置。手机在参与活动救助时先拦截账户操作，用户完成取消/退出救助后才继续。
