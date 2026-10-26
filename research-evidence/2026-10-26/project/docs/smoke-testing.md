# 冒烟测试设计与执行手册

状态：2026-09-11 新增。本文是实现与运行 `scripts/smoke.sh` 的权威说明。
冒烟测试只回答一个问题：**当前这棵源码树的关键链路是否还通**。它不是验收，
不能替代 `backend/test/*.test.ts`、`ios/AEDResponseTests`、真机验收或
`docs/requirements.md` 里的 V2-Axx 逐项验收。

## 1. 分层与边界

| 层 | 入口 | 运行内容 | 证据强度 |
| --- | --- | --- | --- |
| 契约 | `npm run smoke:contract` | 解析 `contracts/openapi.yaml`（结构、operationId 唯一性、内部 `$ref` 可解析）→ 启动临时后端 → 用真实响应体校验文档化 JSON Schema → 比对 `src/server.ts` 已实现路由与文档路径 → 校验 `contracts/fixtures/demo-scenario.json` | 契约与实现是否仍然一致 |
| 后端 | `npm run smoke:backend` | 在 `127.0.0.1:0`（随机端口）+ 内存 store 上跑完整关键链路：登录门禁 → 四项协议/双权限 → Watch 绑定 → Fall 触发 → P/R 写入与来源仲裁 → 招募与隐私投影 → 接受/拒绝 → 事件位置批次 → 结束与时间线 | 关键链路集成结论 |
| 客户端 | `scripts/ios-smoke.sh` | 本机 Simulator 上的单位测试切片 + iOS/watchOS 无签名编译（见第 5 节） | 源码可编译 + 纯逻辑测试通过 |

允许出现在冒烟层的东西：必需门禁、关键状态迁移、幂等与授权边界、Socket 通知隐私、
契约一致性、客户端可编译性。

刻意**不**进冒烟层的东西（留在完整测试里，避免冒烟变慢、变得不可信）：

- 30 秒/30 分钟/35 分钟这类真实等待与扩圈时序边界；
- 端到端位置批次时间窗、迟到证据、旧批次隔离的全部组合；
- SQLite 停机重开、留存/TTL 物理删除、hash chain；
- 并发、限流熔断、错误路径穷举；
- 真机、真实短信/Apple 登录、物理 Watch Fall/CallKit、蜂窝与公网入口。

## 2. 后端冒烟用例矩阵

| 步骤 | 断言要点 | 失败意味着 |
| --- | --- | --- |
| S01 | `/healthz` 200、`status=ok`、`schemaVersion=2.0`、JSON 类型 | 服务没起来或信封变了 |
| S02 | 匿名访问未知 API 路由返回 401（不泄露路由是否存在）+ problem+json；已认证时同一路由返回 404 | 认证顺序被改坏或错误契约变了 |
| S03 | 无 token / 伪造 token 401；错验证码 401；非法手机号 400 | 认证门禁失效 |
| S04 | 缺协议 400；缺一项协议 400；四项齐全 + 双权限 201；被拒绝的系统权限被持久化，该设备只被解除响应资格（201，且 presence 反映 `notificationAuthorized=false`） | 门禁被绕过，或把客户端权限拒绝误当服务端错误 |
| S05 | 伪造 companion ticket 401；iPhone 签发 ticket → Watch 兑换 201；Watch 不能反向签发 | Watch 绑定链路断 |
| S06 | Fall 观察 201 → `ACTIVE/RECRUITING`；重放 200；改 `fallResolution` 409 | 事件成立或幂等被改坏 |
| S07 | Watch 写 P 403；越界 400；超出未来时钟偏移 409；首次 `applied=true`；重放 `idempotent=true`；陈旧样本 `applied=false` 且不回退投影 | 位置写入与来源优先级失效 |
| S08 | 12 km 外设备事件列表为空、直读 404；近处中立设备可读 presence/nearby | 招募圈层失效或越权可见 |
| S09 | 3 名圈内设备都收到请求；候选 `viewerRelationship=NEUTRAL`、`canPublishEventPosition=false`、投影不含患者坐标/地址/coordination/Fall 细节、offer 带 `expiresAt` | 候选隐私边界泄漏 |
| S10 | 触发 iPhone 为 `PATIENT`、可写事件位置、Socket 保持连接 | 患者投影或 Socket 链路失效 |
| S11 | DELIVERED → VIEWED 顺序推进 200；早于事件的 `decidedAt` 400；ACCEPT 200 → `RESPONDER`、offer 清空、可写位置、可见患者位置；非患者 confirm-false-alarm 403；重复 ACCEPT 200 | 响应与角色投影失效 |
| S12 | REFUSE 200 且该设备随后读事件 404 | 拒绝路径或撤权失效 |
| S13 | 已闭合秒槽批次 200 且首次 `idempotent=false`、重放 `true`；6 条 422；未闭合槽 425 | 严格秒槽位置批次契约被改坏 |
| S14 | Watch 读 iPhone 事件投影 403；读自己触发事件 state 200；读他人事件 404 | Watch 越权 |
| S15 | 窗口关闭后再次 ACCEPT 仍被拒绝（409，offer 不被复活） | 过期 offer 被错误复活 |
| S16 | 第二名响应者接受后两人恰好分为 1×`FETCH_AED` + 1×`GO_TO_PATIENT`；AED 任务带 `R→A→P` 路径且 aedId 命中种子 AED；`EN_ROUTE`/`ARRIVED_AT_AED` 合法；`AED_ACQUIRED` 首次 201、重放 200；`aed:acquired` Socket 推送携带 receiptId；投影回读 receipt | AED 调度、回执幂等或通知链路断 |
| S17 | 患者 resolve 200 → `RESOLVED`、参与窗口开合时间存在；重放幂等；不同 resolutionId 409；参与者看到终态且 `canPublishEventPosition=false`；时间线含 `EVENT_RESOLVED` 且不含内部审计 kind | 结束流程或时间线边界失效 |
| S18 | 超过 16 KiB 的请求体 413 | 报文边界被改坏 |

冒烟里的时间推进由可控时钟完成（`setServerOffset`），不产生真实等待；只有 Socket
握手与一次 250 ms 的整流等待是真实时间。整层实测约 0.5 s。

## 3. 契约冒烟用例矩阵

| 步骤 | 断言要点 |
| --- | --- |
| C01 | `openapi: 3.1.0`；`info.title/version` 非空；第一个 server 是 HTTPS 生产入口；仍保留 127.0.0.1 开发入口 |
| C02 | 每个操作都有唯一 `operationId`、有 responses；操作数 ≥ 30；全部内部 `$ref` 可解析 |
| C03 | 真实响应体按文档 schema 校验：`/healthz`、未认证 problem、Watch 观察、事件投影、事件列表、Watch state |
| C04 | `src/server.ts` 里每个已实现路由模板在契约里都有对应 path + method |
| C05 | `contracts/fixtures/demo-scenario.json` 的 AED 通过 `aedSchema` 且 id 唯一 |

C03/C04 是防止“实现偷偷加了路由”和“实现返回了契约没写的字段/类型”的关键闸门。
契约解析器只支持本仓库实际使用的 YAML 子集（块映射、块序列、流式 `{ $ref: ... }`、
折叠标量）；遇到子集外的写法直接失败，不静默跳过。

## 4. 运行方式

```bash
# 全部三层
scripts/smoke.sh

# 只跑某一层
scripts/smoke.sh contract
scripts/smoke.sh backend
scripts/smoke.sh ios

# 等价的后端命令
cd backend && npm run smoke:contract
cd backend && npm run smoke:backend
```

- 结果日志写入 `.smoke/<layer>.log`（可用 `SMOKE_LOG_DIR` 覆盖）。
- 任一层失败，脚本以非 0 退出，并在末尾汇总各层耗时与日志路径。
- 后端/契约层只在回环地址 `127.0.0.1` 的随机端口上监听，使用内存 store，
  不读写生产 `.data/`，不访问 Azure、公网或真机。

## 5. 客户端冒烟（本机，无 Xcode Cloud）

本仓库当前只有一个 **Personal Team（`GR6YBCDW7R`）** 的 Apple Development 证书。
Apple 明确要求配置 Xcode Cloud 工作流需要 **Apple Developer Program 会员资格**
（[Get started with Xcode Cloud](https://developer.apple.com/xcode-cloud/get-started/)），
免费 Personal Team 不属于该计划，因此 **Xcode Cloud 不可用**；客户端冒烟改为本机执行。

`scripts/ios-smoke.sh` 分三档：

1. **编译档 tier A（默认必跑）**：`AEDResponseUnitTests` scheme（iOS TestHost + `AEDResponseTests`
   + `AEDResponseWatchLogic` 的 iOS slice）与 `AEDResponseWatch` scheme（watchOS app + 测试包）
   的 `build-for-testing`，`CODE_SIGNING_ALLOWED=NO`，通过标志为
   `** TEST BUILD SUCCEEDED **`；只证明源码可编译，不产出可安装 App。
2. **Simulator 单测档 tier B（可选，`IOS_SMOKE_SIMULATOR=1`）**：在 iOS Simulator 上运行
    纯逻辑测试切片（状态机、安全策略、结束/退出协调器、位置批次与窗口协调器、
    位置/上传策略契约、路由估算、Watch 监控与 fallback 协调器、C4b/C4c 竞态与恢复），
    跳过需要活的 Azure 后端、真实设备或 App Attest 的用例；实测 122 项、0 失败。
3. **Simulator UI 档 tier C（可选，`IOS_SMOKE_UI=1`）**：TestHost 的首启协议门禁、
    待命列表/地图切换、附近 offer 本地接受三条 UI 流程。

```bash
scripts/smoke.sh ios
IOS_SMOKE_SIMULATOR=1 scripts/smoke.sh ios
IOS_SMOKE_SIMULATOR=1 IOS_SMOKE_UI=1 scripts/smoke.sh ios
```

环境变量：`IOS_SMOKE_DERIVED_ROOT`（默认 `/tmp/aedresponse-smoke`）、
`IOS_SMOKE_SIMULATOR_NAME`（默认 `KeepOne-CI`）、`IOS_SMOKE_TIMEOUT`（默认 2400 s）、
`IOS_SMOKE_BUILD_ATTEMPTS`（默认 1，仅在 Xcode 报构建数据库被占用时自动清库重试）、
`IOS_SMOKE_CACHE_ROOT`（把 SwiftPM/Clang 缓存指向可写目录，用于受限沙箱环境）。
脚本用 `-clonedSourcePackagesDirPath ios/.build/SourcePackages` 复用仓库内已存在的
checkout，构建过程不访问网络。

这三档都**不构成**真机、物理 Watch、真实 Core Location、真实登录或蜂窝 E2E 证据；
那些仍按 `HANDOFF.md` 的分层验收单独执行。

## 6. 基线结果（2026-09-11）

| 层 | 结果 | 耗时 |
| --- | --- | --- |
| 契约（C01—C05） | 5/5 通过：36 operations、36 operationIds、201 refs、65 错误 schema、8 个真实响应体按契约校验 | 约 0.3 s |
| 后端（S01—S18） | 18/18 通过：事件走到 `RESOLVED`，拿到 `aed-demo-01` 并回执幂等 | 约 0.44 s |
| 客户端编译档 tier A | `ios-build-iphone` 与 `ios-build-watch` 均 `** TEST BUILD SUCCEEDED **`；冷 DerivedData 约 90 s，热缓存约 15 s | 15 s—1.5 min |
| 客户端单测档 tier B | `Executed 122 tests, with 0 failures` + `** TEST SUCCEEDED **`（`KeepOne-CI`，iOS 26.5） | 约 3.5 min（含构建） |

`scripts/smoke.sh all` 在热 DerivedData 下三层汇总约 **16 s**；首次或清理后会更久，
因为 `/tmp/aedresponse-smoke` 下的 DerivedData 为空。tier B/C 未开启时不会启动模拟器。

## 7. 变更纪律

- 新增/修改 REST 路由时，先改 `contracts/openapi.yaml`，再改 `src/server.ts`，
  否则 C04 会失败——这是刻意的。
- 新增响应字段时，C03 会按契约校验真实响应；契约没写的字段会以
  `additionalProperties: false` 或缺失 required 的形式失败，先补契约。
- 冒烟用例只允许断言“关键链路必须成立的事实”。需求差异应保留为失败用例，
  不得为了迁就当前实现而放宽断言。
