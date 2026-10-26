# AEDResponse 渐进式架构整改台账

启动：2026-09-09 05:40:18 Asia/Shanghai（调度比指定时间晚 18 秒）。授权来源：本任务用户的七节整改要求；只在本地分批执行，不部署、不操作真实数据库/设备业务、不推送。

## A：基线与证据

- 实际仓库：`[PROJECT_ROOT]`；任务默认 Documents 目录只有未提交的 `strip_docx_metadata.py`，未改动该目录。
- 原分支 `codex/ios-mvp`；HEAD `8362af26a1cfcadd7dc1753f3f4ba9310456ae2e`，只有 initial import 提交。原有 72 个 tracked 文件变更，另有大量 untracked 功能、测试和文档；不能用 HEAD 代表当前产品。
- 独立分支 `codex/architecture-repair-20260909`。创建分支前已保存工作树及 index 二进制 patch、status、HEAD、日志和 211 个 tracked/untracked 文件的归档及 SHA-256 清单；逐个回读归档验证通过。
- 可恢复基线：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260909-0540/`（权限 0700）。`workspace.tar.gz` 是源码/文档基线；忽略的 runtime 数据、密钥、构建缓存未纳入，不修改这些文件。此归档不是生产数据库备份。
- 已实际读取：仓库 README、HANDOFF 最新交接、requirements、architecture、iOS 架构及 project.yml、接口契约与相关源码；独立只读审查者回查评审稿 R01–R18。仓库及相关上级目录无 AGENTS.md，遵守用户在任务中提供的 AGENTS 指令。
- 已找到并读取 `docs/reviews/AEDResponse业务逻辑与架构设计评审稿-2026-09-09.md` 和对应 JSON；JSON 172 个源码 SHA-256 全匹配，0 changed/0 missing。
- **材料已补齐**：初次 Desktop/Documents/Downloads 检索未找到二次意见；用户随后提供 `/Users/REDACTED/Downloads/AEDResponse_二次审查意见_2026-09-09.md`。已全文读取并原样保存到 `docs/reviews/`，SHA-256 `9bb37d720cfc6ea9832c03ab75326be8e513171b526ddd70941edaf8de69f890`。文末旧“仅补文档”提示词是引用材料，不覆盖本轮用户的实施授权。早先仅检索本地文件不代表此前其他任务未收到；已回查“解释架构设计”任务找到对应讨论。
- 环境：macOS Darwin 25.5.0 arm64、zsh、Node 24.18.0、Xcode 26.6 (17F113)。后端锁定 better-sqlite3 11.10.0、socket.io 4.8.3、zod 4.5.4、tsx 4.23.13、TypeScript 7.0.2；不安装/升级依赖。
- 活动工程 `ios/AEDResponse.xcodeproj`，canonical `ios/project.yml`；生产 targets AEDResponse + AEDResponseWatch，WatchLogic 供多平台纯逻辑验证；TestHost/UnitTests/ControlledTests 为分别隔离的测试 target。编号 2/3/4/5 工程和排除的 `SocketIOEventStream 2.swift` 不作为活动实现，不删除。
- 修改前 `npm test`：124/124 通过；`npm run check`：通过。Release iOS（包含 Watch）generic unsigned build 通过。完整日志在基线目录，未运行真机/生产流程。`npm ls --depth=0` 的有效依赖与锁定版本一致，但存在历史 `* 2` extraneous 副本，未删除/重装。

证据等级：源码证明与本地可复现测试分开；构建不等于运行，stub/本地 Socket 不等于 APNs/真机后台，容量实验不等于目标负载验收。

## 最小目标与所有权

| 当前职责 | 目标归属 | 可写状态/维护者 | 接口 | 事务边界 |
| --- | --- | --- | --- | --- |
| service 身份判断/撤销，server 握手 | 身份访问模块 + 实时连接授权适配器 | 会话/绑定由身份用例维护；连接注册由适配器维护 | authenticate、logout、连接发送时复验 | 撤销及绑定共同提交；成功提交后断连接；发送再次检查已提交授权 |
| service 各结束入口 | 事件结束用例 | 事件终态/结束原因/幂等结果 | end、resolve、兼容误报适配 | 事件、窗口、任务、邀请、幂等和发件箱共同提交 |
| service 接受/退出/任务 | 响应协作用例 | 参与关系/人数/任务 | accept、exit、task receipt | 同一用例事务；事件生命周期协调调用，客户端无全局写权 |
| service 位置与队列 | 位置事实与投影模块 | 原事实不可变；最新 P/R 是派生投影 | append batch、latest R、Watch snapshot/fallback | 批次/幂等/派生投影共同提交；不篡改采样时间 |
| service AED 查询/分配 | AED 资源模块（条件性） | 资产占用/交接/归还待业务批准 | reserve/acquire/handoff 待定 | 跨事件原子约束待决，禁止结束自动归还 |
| service timeline 与 event projection | 查询恢复模块/内部审计分离 | 只读客户端投影；内部审计由业务事务追加 | authorized snapshot、兼容恢复投影 | 无独立写权；权限来自服务端关系 |
| service publisher/tick | 事务发件箱 + 定时执行 | 待发送记录/尝试结果；已提交事实不可回滚 | drain、retry、启动恢复 tick | 意图随业务提交，发送提交外，发送时再授权 |
| AppStore 会话/恢复/操作/位置 | 会话协调、事件投影维护者、具体操作、位置日志上传 | 各本地状态唯一维护者；AppStore 组合 UI | reconcile、submit intention、seal/flush | 保留 account/event/connection generation、旧回调抑制与封口顺序 |
| Watch 触发/fallback/runtime | 保留两个 coordinator；增加后端恢复协调 | active projection 与待 ACK 事实分开 | recover status、stop acquisition、retry history | 终态停止新采集，合法历史 ACK 前不删除；409 不等于终态 |
| 全状态 StateStore | 先测量；后续实体读取/明确事务 | 集中式后端单写 | entity queries、unit of work | 保留现有原子提交；适配器不算性能整改完成 |

依赖：A → B（可独立修复）→ C（第一条完整结束链）→ D（逐路径迁移）→ E（业务/外部条件满足后）。不同时重写三端及存储。

## 风险追踪

以下源码位置为修改前基线，修复后另记实际文件。类型：S 结构重构，F 明确缺陷，D 待业务决定，V 外部/负载待验证。这是A阶段修改前的判定记录，不代表当前完成状态；当前逐项状态见后面的批次结果与当前状态索引。

| 风险 | 源码证据 | 需求依据/类型 | 目标边界/批次 | 验收场景 | 状态/待决 |
| --- | --- | --- | --- | --- | --- |
| R01 | service.ts:2729 直接返回 timeline | 最小权限、匿名协作 F/D | 查询恢复 B | 候选/跨用户无内部观察与稳定身份；内部记录保留 | 仍存在；详细审计字段权限待决，仅输出已获授权快照中的字段 |
| R02 | WatchAPIReporter:283 丢 body；fallback:271 clear 丢队列且无调用 | 全端终态 F | Watch 恢复 C | 手机不可达时独立恢复；终态停采集保留历史 | 仍存在，不能直接接上破坏性 clear |
| R03 | AppStore:65–208 多状态/任务 | 唯一所有权 S | iPhone C/D | 切号、旧回调、丢响应 | 部分修复：D4–D16 已迁位置、连接、恢复、事件、邀请、assignment、Presence、附近摘要、slot scheduler、恢复 grace、事件批上传、位置/回执队列 I/O；delivery receipt 上传/重试已迁入 `DeliveryReceiptUploadCoordinator`，事件位置事实、封口和其它操作仍在 AppStore |
| R04 | store.ts:1258–1277 全量 clone/validate | 单写/容量 S/V | 存储测量 D | 历史增长、并发、重启一致性 | 部分修复：E-STORAGE-01 跳过无变化持久化写入，SQLite 使用已提交 flatten cache 避免重复全量 flatten；E-STORAGE-02/03 已建立历史/队列/重启/串行事务成本指标；事务前 clone/validate、全状态加载和目标容量仍存在 |
| R05 | service.ts:4746 提交后 emit；816 SENT 重试 | 可恢复通知 F/V | 发件箱 C/D | 提交后发送前崩溃、重启、去重和授权 | 结构已修复：业务 Socket 通知、候选请求/过期、患者激活、位置/coordination、状态确认、退出、AED 广播及 assignment emission 均先入箱；iPhone receipt 上传/重试拥有独立协调器；REST 恢复快照仍按当前授权重播，APNs/用户收到或查看仍证据不足 |
| R06 | domain:85 ETA；service:6022 分配 | 路线和交接 D/V | AED E | 实路失败、无替代/持 AED 退出 | 结构部分修复：`route-provider.ts` 成为路线选择唯一入口并对输入/提供方不可用 fail-closed；真实路线能力、跨事件争用和交接规则仍证据不足 |
| R07 | service:3980/6052 事件内资源索引 | 现实资产生命周期 D | AED E | 两事件争用/归还 | 仍存在；占用与归还规则待决 |
| R08 | service:2383 tick 无失联补位闭环 | 通信状态 D | 协作 E | 离线恢复、权限和人数一致 | 仍存在；有效数据/恢复条件待决 |
| R09 | AppStore:850 logout；service:1505 | 撤销不是退出/结束 D | 身份与用例 E | 活动登出/离线撤销 | 仍存在；不得自动结束救助 |
| R10 | service:4541/4594 多结束写路径；AppStore:1966 新 ID | 明确主体/终态原因 S/F | 结束用例 C | 重复/异内容、响应丢失、接受并发 | 核心后端结束/误报已收敛到 `event-resolution.ts`；状态确认响应与 scheduler 已收敛到 `status-confirmation.ts`；客户端完整 runtime 与兼容入口仍待验证 |
| R11 | service:1970 不同 eventId 直接新增 | 重复跌倒 D | 生命周期 E | 同患者不同 ID | 仍存在；合并/拒绝/并行待决 |
| R12 | EventPositionPersistence:54；WatchPersistence:452 | ACK 前保留/窗口事实 F/D/V | 位置 C/D | 长离线、损坏、存储失败、终态补传 | 仍存在；最终完整性/容量未证明 |
| R13 | OpenAPI/Zod/shared/Swift 分别维护 | 契约一致 S | 每批同步 | 实际 target/编码解码 | 仍存在；暂不加生成工具链 |
| R14 | apple-auth:37 challenge Map；main:5 | 正式身份 V | 外部能力 E | 真实供应商/重启挑战 | Apple Developer Program会员资格已获批，外部能力工作包解除冻结；真实供应商、App Attest、APNs、重启挑战与设备能力仍待验证 |
| R15 | server:475 GET tick；AppStore:4414 timeline | REST 恢复 S/F | 查询/调度 C/D | 无查询到期、重启、断线 | 部分修复：状态确认 scheduler 已作为独立事务用例调用，服务启动/每秒 tick 仍保留；完整重启/后台运行时证据仍缺 |
| R16 | WatchSystemMonitors:47；service:2015 | 真实 fix 时间 F/D | 定位 B | 旧 fix、新触发、缺时间兼容 | 部分修复：真实时间链已保留，并拒绝非有限/未来 fix；新鲜度阈值和 OS 回调证据仍待决 |
| R17 | server:237 房间裸 emit；service:1505 仅撤销记录 | 后端可撤销会话 F | 身份/Socket B1 | 撤销旧连接、同设备新会话、其他用户不受影响 | 已修复：连接发送复验、撤销断连及 stale principal 的恢复重播入口均 fail-closed |
| R18 | AppStore:1409 VIEWED；service:3697 无门槛 | 邀请门槛 D | 响应 E | receipt 延迟时接受 | 仍存在；不可擅自加/删 VIEWED 限制 |
| XCLOUD-01 | 当前仓库无 `ci_scripts`、workflow 文件、`develop` 引用或 `xcode-cloud` CLI | Xcode Cloud 外部能力 V | 云端配置工作包 XCLOUD-01 | 仓库连接、首个 workflow、云端 build/test 回读 | 证据不足；需 App Store Connect/Xcode 配置与用户明确触发，不能用本地 build 代替 |

冲突/决策清单：T+35 无回答关闭（README 与需求口径不同，本轮显式待决，保留旧行为）；不同跌倒仲裁；目标 3 是否上限；VIEWED 是否硬门槛；失联定义及复归；AED 无替代行动；持 AED 退出与归还；活动 logout 与 end/exit；手机可达但后端无 P 的 fallback 条件；初始 Watch fix 年龄。每项选项/影响在依赖批次启动前细化，不把评审建议升级为批准规则。Watch 当前立即备份/后端 10 秒仲裁已从现时文档核对，旧 30 秒记忆不适用。

## B1：撤销与既有 Socket 授权

- 风险 R17；类型 F + 有边界的身份职责迁移。
- 范围：统一身份验证与撤销模块接管现有认证/注销行为；Socket 连接按 session 复验、撤销提交后主动断开、发送前复验。
- 非范围：不把 logout 改为事件 exit/end，不扩大/缩小现有账号及 Watch 撤销范围；不改事件受众规则、认证供应商、生产配置或数据格式。
- 前置决策：无。会话撤销后不能继续收数据已明确；不自行新增业务超时。
- 兼容：REST 凭据/返回/错误原语义；旧 Socket 被后端断开是预期缺陷修复。
- 验收：先增加真实 loopback Socket 的失败回归；原连接撤销后无法收到新消息，新会话和其他账号仍能使用；现有 auth/companion/API/store 全回归。
- 回退：仅以本批 patch 反向应用前先检查当前 diff；从私有归档取单文件比对，不覆盖之后用户改动。无数据库格式变化，不执行数据回退或恢复旧库。
- 实现：`identity-access.ts` 接管原 token 认证及 logout 撤销事务；service 中原实现移除，保留旧方法作为兼容调用入口。`realtime-access.ts` 接管连接注册、每连接绑定身份验证和发布授权；server 中设备房间裸广播停用，发送经已授权连接。logout 提交后通知断连，refresh/绑定 HTTP 完成后复验，握手的 await 前后也复验。事件权限、登录签发/refresh 写入尚有部分保留在 service，未声称身份模块全部迁完。
- 验证：`B1-red-corrected.log` 两项 loopback 测试均复现原连接 disconnect timeout；`B1-review-red.log` 三项复现同 token 新旧绑定误放行、提交后 observer 抛错、授权读取失败。修复后的 `npm test` **135/135**、`npm run check`、`npm run build` 全通过（`B1-final-test.log`、`B1-final-check.log`、`B1-build.log`）。无原有测试删除或断言放宽。
- 独立复审：发现 tokenHash 聚合混淆连接绑定代次、提交后 listener 错误影响结果；已改为按 connection ID 独立授权、逐 listener 隔离、读取失败断开所有被注册连接并阻止发送。增加失败事务不误撤销、直接已提交撤销/到期/scope/绑定变更发送0条的测试。独立审查者最终核对核心文件哈希与快照一致，另跑9项针对回归通过，确认可结束B1进入B2；剩余限制见下条。
- 限制：每次发布额外一次全状态 clone 与连接扫描，登记 R04 新增成本，未声称存储性能改善；真实握手中途撤销交错仅静态核查、未专门执行集成复现；跨实例撤销不在现有单体单写运行能力内。已交给 Socket.IO 的消息无法追溯收回，撤销后不再授予新发送。
- 变更证据使用相对于本次可恢复基线的 `B1.diff`/文件哈希，不能使用相对于旧 HEAD 的巨量混合 diff。核心文件原有未提交内容尚未独立提交，因此本批暂不做混合 Git commit；没有推送。

## 二次意见复核补充

RV-03/05/06/08/09/10/11 分别对应 R02、R01/R17、R06/R07、R11、R05/R14、R04/R12、R10/R18，原结论均仍有源码基础；正式供应商、真机覆盖与容量验收仍证据不足。B1 仅整改 RV-05 的会话连接部分。

| 新补审项 | 源码复核 | 类型与状态 | 选项/影响/建议/受阻批次 |
| --- | --- | --- | --- |
| RV-01 | service 的 applyStatusConfirmationTick 恢复越 T+35 后可直接关闭；无询问 ACK 条件，sentAt 可写计划时刻 | D，仍存在（静态），不是实测送达失败 | 维持原截止/按已送达计时/转人工确认会影响不同停止时刻和恢复能力；建议先明确“未送达/未回答/响应者仍行动”的处理，阻塞关闭规则变更，不阻塞 C 共享终态事务 |
| RV-02 | FallEmergencyCoordinator 的 receiveFall/receiveHelpResponse/receiveCall/pruneExpiredContexts；窗口含120秒边界，无回答且无新外拨不创建 | D/V，当前覆盖已确认、正式能力证据不足 | 维持当前覆盖/批准其他触发信号涉及产品覆盖范围；建议明确宣传与能力不可用提示，禁止自动新增SOS。阻塞触发范围扩展，不阻塞真实fix时间 |
| RV-04 | WatchFallbackCoordinator.reconcile 手机可达即停；后端 reportWatchFallbackPosition 也拒绝 ACTIVATED+reachable；10秒判据不能绕过此前置 | D，仍存在（双端静态） | 维持近端可达门槛/增加后端P健康状态准入影响备用触发和能耗；建议先定义合格P健康事实，阻塞fallback启用规则变更，不阻塞C状态恢复 |
| RV-07 | RootView 统一 PermissionGate；通知/Always+精确下降使 AppStore disconnect 清liveSession、connect门禁拒绝，患者按钮不可达；后端结束授权不查该能力 | D，仍存在（调用链），真机未运行 | 全面门禁/保留患者查询与明确结束能力影响必要操作权限；建议区分停采集、停止接受、患者必要操作，阻塞门禁产品变更，不静默删现有测试 |

所有二次意见是评审输入，不自动成为新批准规则。未决字段授权、Watch采样年龄、触发与关闭策略维持待决；先修可证明的数据保真、既有授权执行和恢复机制。

## B2：恢复快照与内部审计分离（实施前约束）

- 风险 R01/R15/RV-05；F/S。范围：客户端恢复直接读已批准的当前事件投影，不再依赖全部内部timeline；兼容 timeline 路由改为从同一获授权事件快照生成一条通用当前状态提示。
- 新查询函数只能接收 `EmergencyEventView`，不能访问内部事件/审计存储；因所有输出都来自原已授权快照，不新增患者/候选/响应者可见字段或猜测完整审计白名单。
- 非范围：不删除内部审计、不新增后台审计权限、不改事件查看授权、不改GET tick/定时规则、不改任务/人数/结束语义。完整审计字段权限继续待决。
- 兼容变化明确登记：`/timeline` 仍按原主体权限返回相同 JSON 数组形状，但其内容是最多一条当前状态恢复提示，不再是全量 append-only 审计。旧客户端仍可解码现有枚举；新的iPhone只用事件快照恢复状态，服务端审计完整性由存储测试验证。
- 验收：候选/患者/响应者/终态的真实HTTP返回不含触发观察、他人标识及审计正文；跨用户404、错误主体403保持；注入的内部敏感审计原样保留；重复恢复不产生新记录。iPhone恢复不调用timeline且先恢复事件再传位置，旧代次抑制保持。
- 回退：相对于 `B1-workspace.tar.gz` 的逐批patch；无存储迁移，不回滚历史数据。回到旧服务端会重新开放旧漏洞，不能部署这样的回退；本会话仍只本地。
- 前置决策：无新增可见字段；业务细则仍暂停。状态：准备测试。

### B2 当前权限矩阵

| 主体 | 当前事件查询 | 兼容恢复提示 | 内部审计/其他人的明细 | 实时消息 |
| --- | --- | --- | --- | --- |
| 无有效会话 | 401 | 401 | 不可读 | 不得连接/发送 |
| account 会话 | 403，须设备scope | 403 | 不可读 | 拒绝 |
| Watch 会话 | 原iPhone事件GET仍403；独立恢复接口留C | 403 | 不可读 | 不开放iPhone Socket |
| 活动患者 | 原患者快照（本人P与聚合） | 只用已可见id/state/time | 不经产品timeline暴露 | 原事件受众规则+有效连接 |
| 未接受候选 | 原邀请粗粒度投影 | 同一已授权状态提示，无观察/身份 | 不可读 | 原通用邀请/过期提示 |
| 已接受响应者 | 原患者P和本人的任务/获准聚合 | 同上，无其他参与者历史 | 不可读 | 原受众规则，不广播他人完整任务 |
| 明确退出者/跨用户 | 404 | 404 | 不可读 | 原退出后受众撤权（历史补传另走受限接口） |
| 仍具终态查看资格者 | 原终态中立投影，无活动权限 | 仅对应终态提示；未确认关闭不解释为RESOLVED | 不可读 | 终态提示不能代替REST恢复 |
| operator | 原有列表通用投影，单事件iPhone路由权限不扩展 | 403 | 尚无已批准break-glass接口 | 不开放设备Socket |

### B2 验证进展

- `B2-red.log` 真实loopback HTTP复现候选可读取内部触发与拼接的用户ID（均为测试数据）。修复后后端136/136通过；新增闭合未确认状态提示和二次SQLite重启完整entry对象比较的针对测试2/2通过。
- 独立后端复审5项针对测试通过，确认原主体权限与业务状态写入未变。按复审建议，将二次重启校验加强为完整id/time/kind/message对象一致。
- iPhone两处恢复不再请求timeline；连接代次、退出tombstone、applyServerSnapshot和上传启动顺序保持。新增审计接口不可用时仍恢复测试；原先timeline先于上传测试迁为事件快照先于上传，并断言0次timeline请求。
- Simulator记录更正：第一次修改前基线停在宿主启动，未执行；第二次 `B2-ios-red.log:144–155` 实际运行了新增测试，出现REST对账超时、neutral而非patient、仍调用timeline三个失败断言，之后才中断。早先只看日志尾部而误记未执行，独立复审已纠正。第一次green尝试遇到设备服务 `Mach -308`，当时前一shutdown尚未回收完成，是执行编排问题，不能记业务失败。确认所有setup/shutdown命令完成后重跑。
- 该Simulator为本批新建 `REDACTED-ID-46ea8fdd54fd8f93`，已停止本批测试并关闭；保留其数据供诊断，不删除任何原有Simulator。B2 iPhone运行证据暂受环境阻塞。
- generic `build-for-testing` 已通过；Mac以同一Models验证四种兼容提示解码，1/1通过。最终 `B2-ios-green-retry.log` / xcresult **实际3/3通过**：恢复不依赖审计、事件快照先于位置上传、四种旧枚举解码，且 `TEST SUCCEEDED`。后端build通过。`B2.diff`/`B2-workspace.tar.gz`已固定；B2代码独立复审通过，以上运行补齐本地验收，仍不是物理设备/蜂窝验收。

## B3：Watch 真实定位时间（实施前约束）

- 风险 R16/RV-04；F。范围：OS CLLocation.timestamp → Watch快照 → 稳定触发payload → 后端保存/位置投影全链路保留同一个采样时间，另保留Fall/call观察时间和serverReceivedAt。
- 非范围：不改变触发、120秒上下文、35分钟首次上报截止、10秒来源仲裁、近端可达门槛及任何配置阈值；不新增30秒生产快照年龄。
- 兼容：新增可选 `patientPositionObservedAt`；旧payload/旧队列仍可接收并原样幂等重放，缺真实fix时间的坐标仅保留原观察证据，不成为有效P。旧数据库记录不改写；旧初始投影若缺时间来源，不再被当作有效当前P。新Watch使用该字段，旧服务端strict schema会拒绝，未来部署必须先服务端再客户端，本轮不部署。
- 验收：旧fix＋新触发不得刷新observedAt；年龄使用原配置过滤招募；未知时间不地理招募但事件照常成立并保留payload；超未来时钟拒绝；同ID异时间冲突；原body重试稳定；新字段Swift编码/解码/持久队列保持精度。
- 合成fixture的定位时间将明确声明为测试输入，不用于任何真机采样证明；不得对已有真实/未ACK记录补造时间。
- 回退：相对于B2的源码patch；没有数据格式破坏迁移，但含新字段的本地状态不能交给不认识新字段的旧strict解析器。保留已追加观察，旧代码若需兼容须前向增加字段解析，禁止恢复旧DB抹掉记录。
- 前置决策：无新阈值；现有配置只保持既有含义，不宣称其生产值已批准或已验证。状态：准备失败回归。

### B3 实现与验证进展

- 已贯通 WatchLocationProvider真实timestamp、WatchPositionSnapshot、coordinator、Codable/Zod/shared/OpenAPI以及后端初始P投影。Fall/call只写事件观察时间，P只用实际fix时间；已停用原以Fall/call替代fix和从原始未知时间观察直接回退坐标的路径。
- 无时间旧观察可原样保存/重放；旧服务器已经生成的无时间来源投影也不成为当前P，后续真实iPhone P仍正常恢复主来源与招募。未修改历史行、幂等指纹、队列或数据库版本。
- `B3-red.log`：旧schema拒绝新增时间字段（不是已执行的时间错值断言），旧无时间坐标仍暴露为P的测试实际失败。修复后 `B3-final-test.log` 后端139/139、check/build通过。新增未来时间测试最初误写400，回查既有validateClientTime后改为严格断言409；没有为通过而改动原时钟错误语义。合成无坐标夹具同时移除关联时间字段，不放宽schema。
- `B3-watch-final-test.log`：直接编译真实WatchLogic源文件在Mac执行28项XCTest，全通过；覆盖新timestamp编码/解码、原body重试、旧body仍缺时间、真实WatchAPIReporter的注入HTTP传输体。不是Watch后台/传感器验收。
- `B3-release-build.log`：production Release generic iOS+Watch unsigned构建通过；实际Watch OS callback仅有源码与编译证据，真机定位回调仍待验证。
- 状态：实现完成，独立只读复审通过。复审另发现store.normalizeState仍替未知时间制造P，新增失败回归后修复；最终139项后端通过。真机回归按用户新指示统一延后，不作为该源码批次已完成的证据。

## iPhone 16 测试补充授权与隔离

用户询问真机测试并明确“已连接16”。已只读确认USB wired、iOS18.7.8、Developer Mode enabled；17Pro未连接，不操作。

原16联网版本标识 `dev.codex.aedresponse.testhost`、版本2.0，安装容器记录保存在 `iphone16-apps-before.json`。临时复制工程只更换测试宿主/测试bundle标识为 `dev.codex.aedresponse.archrepair.testhost` / `.archrepair.tests`，显示“架构回归测试”；源工程不改，依赖pins与原工程完全一致（Socket.IO16.1.1、Starscream4.0.8）。使用原签名team，不开启真实网络诊断、不触发真实求助。

初次签名失败为生成产物含com.apple.FinderInfo（已检查具体bundle），未安装；已保留失败日志并改用系统临时DerivedData目录重建，不清理用户源码属性。实际设备安装和测试结果后补，不把构建成功等同已运行。

### 真机验证暂停（用户指示）

独立测试包已签名并安装；三次测试（含只替换临时宿主入口的一项fixture诊断）均在XCTest建立连接前退出，code 74 / DTX peer refused，0项业务断言执行。最小入口同样失败，不能归因于AppStore初始化。日志与xcresult保留在私有基线目录；主工程入口未改，原联网bundle未覆盖，未运行真实求助。按用户“先进行架构修改，修复完成后再进行真机测试”的指示停止设备操作；不继续诊断或重试，不将环境失败算成业务失败。

## C1：共同终态变更的单一维护者（实施前约束）

- 风险R10/R03/R12；类型S。范围：把已授权结束动作和既有两种到期关闭路径的终态、参与区间、任务、邀请及设备事件投影清理交给同一个事务内状态维护者；业务入口仍持有原权限、因果时间、幂等检查及事务。
- 实际边界：event-lifecycle只维护一个事件的终态收束；调用方传入原规则计算的受影响设备集合及终态原因。内部audit是同事务追加；不调用网络、不拥有登录/派单/查询、不另开事务。旧cancelCoordination与重复终态赋值停用。
- 非范围：不改变结束主体、自动关闭条件/时刻、错误语义、legacy误报409、AED归还或退出规则；不声称发件箱或跨端结束链已经完成。后续C2接管终态通知，之后迁手机操作与Watch恢复。
- 验收：现有三种人工reason/旧误报/两种自动到期及历史补传测试；补充接受与结束两种事务先后交错，保证无终态后新参与/活跃任务，既有接受事实保留；全后端测试、check/build。
- 前置决策：无，本批保持原触发及授权策略。先完成服务端状态边界再接通知，避免同时重写三端。
- 回退：以B3归档为前像保留C1独立patch和文件校验；仅逐文件比对应用，不覆盖用户后续改动。无数据结构或数据迁移，无数据回退命令。

### C1结果

event-lifecycle接管四个终态入口的共同状态变更，旧重复赋值/cancelCoordination/endPendingStatusConfirmation已移除；event-audit接管原同事务追加函数，不对外查询。新增接受/结束两种交错回归在修改前即4项通过（结构行为表征，不声称缺陷红测试）。修改后后端140/140、check/build通过。独立审查实际运行11项domain/API/历史补传通过，确认清理范围和错误/权限/时间未变，无新增阻塞；C1.diff/归档/218文件SHA256已固定。

## C2：结束事务发件箱（实施前约束）

- 风险R05/R10；F/S。范围：终态通知及同次结束的邀请过期/协调更新意图与业务变更、幂等结果共同提交；单进程worker按已存messageId重试，启动与定时tick恢复；旧对应直接emit停用。接受、派单、位置等非终态通知留后续迁移，不建立两个终态发送权威。
- 发送前复验已捕获设备的user/account/pair绑定和现有事件/邀请关系；B1仍负责具体Socket的有效会话。调用传输成功只标记交给传输，不证明送达/查看，客户端恢复仍读REST。默认noop不应被视为可用发送器。
- 去重：每个消息/受众独立稳定键；发送成功后写回失败可能再次传输，保持同messageId让现有客户端去重，不宣称端到端exactly-once。失败指数退避仅为执行机制，不更改事件/邀请时间规则。终态提示不因墙钟过期自动删除；明确撤权则记录SUPPRESSED并保留意图；邀请结束提示是已过期事实，不能再变成新邀请。
- 存储：在既有state_items增加已知collection，不更换数据库或表结构；未知/损坏outbox拒绝加载，不静默置空；已写消息正文与受众不可修改/删除，仅尝试元数据可变。本地新临时DB验证持久性，不打开用户业务DB。
- 验收：发送器异常不回滚已提交结束；发送前崩溃/重新建服务后补发；同ID重试不重复计人/任务/插入消息；同ID异内容409；账号重绑/撤权隔离；发送后状态写回失败稳定重试；新增collection损坏/不可变/SQLite重启。
- 回退：相对于C1保存patch与归档。新outbox行被旧版SQLite collection白名单拒绝读取，数据不能简单git revert。保留原库和新记录，回滚代码须携带前向兼容读取模块；不删行、不恢复旧库抹掉新事实。本批无生产迁移。
- 非范围/待决：不改变业务规则/受众权限，不接APNs，不承诺用户已收到；全状态扫描/副本成本仍R04，不能以发件箱适配宣称容量整改完成。真机后置。

### C2实现和验证

- `notification-outbox.ts`接管入箱身份、正文校验、尝试元数据与单flight调度；终态三种消息以及结束的邀请过期/协调更新由同次事务写入。原对应直接emit/终态RecruitmentUpdate发布停用；非终态路径保留原实现，未声称所有通知已迁移。
- `C2-red.log`已复现结束提交后发送器抛错导致API失败；新实现将发送失败保留为待重试，主业务返回已提交结果。`C2-final-test.log`后端145/145、check通过；包含SQLite关闭/重开后相同队列恢复、重绑/明确退出抑制、原noop不消费队列、业务提交失败0消息/状态不变、发送后写回失败相同payload重发、同ID异内容仍409以及损坏/不可变记录检查。
- 第一轮针对测试发现原单次批量广播被改成逐设备调用；保留原测试并调整worker将相同payload按原受众合并发送，同时分别维护每个受众状态。未放宽原断言。
- 限制：100条每轮仅为执行批量上限，不是业务人数规则；容量/全状态拷贝成本未测，R04开放。发件箱只能记录传输交接，不能证明用户收到或APNs后台。旧数据中新添collection需要前向兼容回退，不能直接启动不认识它的旧程序。状态：等待本批独立复审。

- 独立复审发现真实server publisher在0个Socket时仍正常返回，旧C2实现会误标DISPATCHED。`C2-review-red.log`以真实createBackend+loopback复现；修复后RealtimePublisher返回实际交接的设备集合，SessionConnections回调必须确认Socket仍connected且实际emit，其他受众保持PENDING，不设置completedAt。保留原业务断言并更新注入发送器明确返回测试交接受众。
- `C2-review-green.log`真实离线→授权Socket重连→收到原messageId通过；补充部分连接受众分别完成/保留的测试。最新`C2-reviewed-test.log`147/147、check/build通过；等待修正后的最终复审。仍不等于用户收到/查看或APNs成功。

- C2最终独立复审通过：7个相关修正文件与固定清单一致，另跑9项授权/部分受众/真实重连/写回失败测试通过。147/147与check/build通过；C2可结束进入手机迁移，原严重回归已解决。

## C3：手机结束用例与稳定意图（实施前约束）

- 风险R03/R10/R12；F/S。范围：实际患者按钮调用链中的结束请求、稳定ID/时间、持久待提交意图、重试和请求后快照恢复交给EventEndCoordinator；AppStore保留唯一事件/任务展示投影和既有封口/补传顺序，并按账号/服务/设备/事件/连接代次过滤回调。
- 新客户端人工误报使用已存在的幂等end/resolve内部处理，明确reason；后端legacy接口和原权限/409语义保留。不会把另一个终态当成本次动作成功，恢复只应用后端返回的实际终态。
- 本地意图发送前原子保存，失败/登出/换号不删除；错误409/403等查询恢复后仍无终态则保留并暂停自动提交，显式重试复用原内容；临时错误等待正常重连/恢复再试，不在失联时创造新ID。已观察终态仅标记对应意图，不清空其他事件/位置队列。
- 非范围：不改患者/响应者可结束条件、权限门禁/登出规则、招募/人数/AED行为；AppStore其他职责留D。真机继续后置，必要本地XCTest/编译仍执行。
- 验收：响应丢失后同ID同内容；账号/事件/连接代次切换旧回调不污染；重建coordinator从同一存储恢复；403/409区别终态；存储损坏/写失败不发送不覆盖；终态按原封口后补传。
- 回退：相对C2固定源码和项目文件patch；新的意图日志在独立受保护文件，不混入原位置队列。代码回退须保留日志等待前向兼容恢复，不删除未确认意图；没有服务端数据迁移。

### C3当前实现与证据

- EventEndCoordinator/专属持久日志接管实际按钮操作、稳定请求、重试恢复及错误分类；AppStore原两段直接网络Task已移除，保留唯一展示投影/位置封口处理。连接代次+操作lease+服务/user/auth-method/device/event context抑制旧结果，新事件切换会失效旧操作回调但保留日志。
- `C3-native-red.log`实际复现新日志第一版在亚毫秒Date持久化后与首发时间不一致（7项中1失败）；用现有contract codec先规范化再存/发后`C3-native-green.log`7/7通过。包括真实临时受保护文件重建、相同ID、其他账号隔离、损坏原字节保留、权限/内容冲突保留并暂停、丢响应后实际CLOSED终态不改写为请求的误报、旧代次和并发按钮、存储失败。
- Mac测试包直接链接真实Models/StateMachines/新协调器/持久类；为独立编译，从真实APIClient逐字提取APIClientError和ProblemDetails定义到私有测试包，未修改错误/业务实现，文件范围/哈希保存于EndLogicTests/error-enum-source.json。该证据是协调器/存储组件，不等于完整URLSession或AppStore运行。
- 新AppStore两项实际按钮回归和APIClient路由/字段回归已加入活动unit target。`C3-red.log`编译后约5分钟仍无Test Case开始，已中断本批xcodebuild，不能记作断言红测试。早先generic build-for-testing已通过；最终更新后的编译与独立复审进行中。真机按用户指示后置，没有再次操作16。

- C3最终独立只读复审核对9个相关文件及错误定义原文，另跑Mac组件7/7通过；`C3-verified-compile.log`测试编译、`C3-release-build.log`生产iOS+Watch Release通过。源码迁移可进入独立Watch工作，AppStore/真实API新回归尚未运行，C链仍未验收闭合。

## C4a：Watch授权状态查询与历史事实接收（实施前约束）

- 风险R02/R12/R16/R17；F/S。先实现后端，之后C4b接入Watch runtime。新增Watch专用GET仅返回eventId/state/createdAt/resolvedAt，限原触发Watch、当前有效绑定和已知患者user身份；不含坐标、人数、任务、内部audit。iPhone普通事件GET的Watch403不变，既有定时器继续独立执行，不把新GET作为tick驱动。
- 将Watch事件绑定校验移到专属查询/访问边界，补已知患者user与当前Watch重绑用户的隔离；不会借同物理设备/同pair读取或补传上一账号事件。旧无明确user字段的记录不推定新身份，仍要求既有触发Watch和pair证据；需靠原观察重放完成旧trigger绑定。
- 合法历史：原触发Watch按同一scope及原payload网络/可达性约束，上传实际采样时间处在后端事件[createdAt,resolvedAt)的事实。只追加原样事实与幂等回执，applied=false；不改终态、位置、任务、人数或AED。越界首次上传409并保留客户端记录；已确认同内容回执仍可重放。新字段保留在既有positionUpdateReceiptsById条目，不把仅有摘要的旧数据伪装成完整历史。
- 非范围：不改变手机可达但后端无P时启用新采集的未决规则，不调整新鲜度/时钟阈值，不选AED规则，不让Watch决定全局终态。C4b仍须把停新采集/补合法历史/隔离越界分开；不能直接调用clearActiveEvent删队列。
- 验收：其他Watch/重绑账号/错误主体不能查询；字段精确白名单；终态后合法历史200且事件/任务不变、同ID异内容409、边界时间409、同ID重放、事实不可改/删并SQLite恢复。新增字段兼容旧无字段记录，回退保留已收事实，不恢复旧库抹数据。真机继续后置。

### C4a实现与验证进展

- 专属watch-event-access接管现有绑定函数和新只读恢复投影，旧service私有实现移除。原Watch观察重放与fallback补充已知患者身份校验；已知用户重绑无法凭同device/pair访问上一用户事件。
- `C4a-red.log`实际复现合法终态前样本被旧active-only入口409拒绝。`C4a-binding-red.log`将当前针对测试置于C3已验证归档源码的私有镜像运行，第一项旧观察重放断言确实Missing expected rejection；这证明受控状态重绑场景的源代码缺陷，不声称已跑真实账号切换硬件。
- 第一轮发现老导入测试使用normalizeState生成的legacy-device占位、并没有真实user；没有放宽原测试，改为识别严格的原无账号导入边界（Watch/session/患者设备均无user/account、占位精确匹配）。正式用户不匹配仍拒绝，不擅自归属旧记录；真实旧记录身份迁移仍需要可靠依据。
- `C4a-final-test.log`150/150、check通过；新增真实HTTP字段白名单/Watch与其他主体/撤销后401、SQLite合法历史ACK/不改变终态/边界409/同ID异内容409/不可改删/关闭重开保留事实。schema/shared/OpenAPI同步；完整payload首次加入回执，原positionUpdateReceiptsById损坏collection改为拒绝读取而非静默置空。
- 仍未改Watch runtime，C4b继续；没有宣称终态Watch链已闭合。发件箱/历史增长仍增加现有全状态校验成本，容量保持未验证。状态：等待独立复审。

- 独立复审发现两项真实回归：旧每设备64条receipt截断会删除不可变Watch事实，使第65条事务失败；坏的后端窗口时间Date.parse为NaN使越界判断失效。`C4a-review-red.log`两项实际失败。现将fact在入回执时即标记耐久、在旧缓存截断中明确排除（保留iPhone64条缓存），并要求权威窗口起止有限且有序。
- `C4a-review-green.log`跨两事件140条Watch事实、iPhone仍64条缓存、SQLite重启完整保留/首条重放，以及坏起止/逆序窗口拒绝，2/2通过。最新`C4a-reviewed-test.log`152/152、check/build通过，等待修正后的最终复审。排除截断只是过渡保真措施，绝不算容量/性能整改完成。

- C4a最终独立只读复审通过：5项针对/legacy/用户隔离/跨事件历史重放通过，5个修正文件与更新清单匹配；152/152、check/build通过。后端批次可结束，继续Watch调用链。

## C4b：Watch已知事件恢复、封口与历史分流（实施前约束）

- 风险R02/R12/R17；F/S。生产WatchAPIReporter调用新GET，FallbackCoordinator接管其已知事件的授权恢复投影、停止新采集、合法历史补传及单条越界/内容冲突隔离；仍是原位置队列的唯一业务维护者。状态查询及历史补传不受当前iPhone可达性阻断；新采集仍保持原ACTIVATED+reachable门槛，不解决RV-04未决规则。
- 明确终态先停止新采集、持久化封口事实，再清除当前采集context；不能调用旧clearActiveEvent的discard。未ACK原payload保持ID/采样时间/连接事实；只按后端有限有序时间窗补历史。窗口未知时保留；越界单条移到不可变隔离记录，其他合法记录继续。
- 401/403保留待发并等待授权恢复；409/400/422不能当作终态或改写正文，单条保留隔离/待处理并停止盲目写重试；临时网络/5xx保留原内容。GET返回的state是唯一终态依据，错误码不替代它。
- 保留事件/连接代次旧回调抑制；请求在会话改变后的结果不得应用。刷新与重新配对并发、暂时错误不清凭据属于同链路核查，若不具备完整证据则另列C4c。原触发首次35分钟截止/超期未确认观察恢复也需单列C4c，不扩展新求助业务窗口。
- 验收：phone仍可达时GET终态；后台频率只作机会执行不作OS保证；终态后新采样0、合法原body补传并ACK、越界隔离其他队列不丢、写失败/重启/旧回调、分类失败及真实WatchAPI注入HTTP方法/白名单。Mac纯逻辑与编译优先，真机后置。
- 回退：相对C4a逐批patch/归档，保留新的受保护队列封口/隔离字段；旧decoder不能被用来重写新队列而丢字段，需前向兼容读取。未执行生产或不可逆迁移。

### C4b实现与验证

- FallbackCoordinator接管独立恢复、封口与原队列分流；旧clearActiveEvent.discard移除。protected文件原子保留封口和隔离事实，未知窗口/损坏/保存失败不清队列。新采集确认ACTIVE，手机可达仍查终态及补历史；原采集门槛保持。当前事件优先，历史积压不饿死新显著位置机会。
- Reporter新增GET无body与四状态解码，返回结果匹配仍有效token/config；暂时会话刷新失败不再清Keychain。Runtime保留会话恢复机会，失败退避，旧展示回调也受采集代次抑制。临时错误、授权问题、内容拒绝与明确终态分别处理，不按错误删队列或无限盲写。
- `C4b-red.log`以C4a归档真实源和可兼容回归构建运行，2项实际失败、5个断言：503清会话阻断后续恢复；clearActiveEvent移除未确认位置。归档镜像清单在C4b-before/source-manifest.json，没有替换业务实现。
- `C4b-watch-final.log`直接链接当前真实WatchLogic源，37/37 XCTest通过：已知终态/合法历史、越界单条隔离和重开、403/409/503、旧代次ACK阻止、历史积压与新样本共存、原门槛/节奏、真实Reporter注入HTTP GET/字段以及503恢复。不是系统监控或物理设备证据。
- `C4b-final-release.log`production generic iOS+Watch Release通过（含最新Runtime展示代次）；`C4b-unit-compile.log`完整unit build-for-testing通过。Runtime系统适配器未运行，初始触发ACK丢失与35分钟过期仍C4c，完整C链未验收。状态：准备独立只读复审，真机后置。

- C4b独立复审实际复现3项新增并发问题、7个失败断言（C4b-independent-race-red.log）：最终授权await后旧代次ACK；辅助恢复进行中误停有效采样；旧GET返回后以已失效可达/网络输入重新开始采样。现连接输入变化也失效采集epoch，最终await之后再验代次，重复恢复不停止有效采样，历史恢复不写采集输入。复审反例迁入活动WatchFallbackCoordinatorTests文件，未改断言；最初修正40/40通过，追加旧错误回调防护后重跑/编译中。未在问题修好前进入依赖批次。

- C4b最终独立复审核对12个文件清单一致，三反例3/3、真实组件40/40通过（C4b-independent-final-green.log），unit编译及production Release均成功；三项新增阻塞解除，可进入C4c。Runtime/后台/完整跨端链仍未验收。

## C4c：首次触发未确认记录与恢复（实施前约束）

R02/R12/R17，明确缺陷修复。用户本轮禁止未确认记录静默丢弃优先于旧文档35分钟仅留marker；35分钟首次创建截止与120秒关联窗口保持。

WatchObservationOutbox pending始终保留未确认原观察，去重marker过期只清marker。废止discard/discardExpired删除路径；同ID不同正文拒绝覆盖，保存前通过原contract codec规范化，损坏拒绝写回。持久保存服务端内容拒绝状态并暂停自动写，授权拒绝等待新授权代次，临时失败稳定退避。

FallEmergencyCoordinator统一首次发送和retry入口，用单事件inflight和授权代次隔离。deadline已过或禁止新创建的恢复机会先GET；只有后端存在且授权的事件可重放原PUT。GET不算原内容ACK，同ID异内容仍409且保留。200/201必须具备匹配id和有效state才ACK；随后沿C4b从后端恢复真实终态。多个Fall不新增仲裁规则。

验收：真实Keychain超期原字节保留、重启/损坏/同ID异内容；超期GET404/403零PUT；丢ACK后GET现存事件+相同PUT成功；200错误ID不ACK；403、409、503、并发重试及旧授权回调；原120秒/35分钟首次创建保持。生产Release及unit编译、Mac真实组件、后端超期幂等表征；真机后置。

兼容：新增本地拒绝元数据需前向读取回退；已被旧版本丢弃的payload无法恢复，不补造。没有数据库更换/生产迁移。回退保存所有新日志，不允许旧版本重写并删除新字段。

修改前真实Keychain反例 C4c-retention-red.log 在C4b归档源上1项1失败，确认过期删除了原观察正文；不宣称硬件传感器证据。

### C4c当前实现与验证

- Keychain未确认观察不再过35分钟删除，同ID不同内容/显式suppress不得覆盖pending。旧discard/discardExpired触发路径移除；只裁剪24小时marker。内容拒绝另存元数据并保留原正文；已被旧版删除的正文无法恢复。该留存修正有用户本轮明确授权，旧requirements第76行删除要求已同步，不改变首次创建截止或T+35无人回答规则。
- FallEmergencyCoordinator submit统一首次/重试，原网络双路径停用；规范化时间、单事件inflight、授权代次、稳定退避与错误分类。超期/关闭采集gate先GET已存在事件再精确PUT；GET不是原body ACK。Reporter验证200/201的event id/state。ACK原子保留confirmedEventIDs然后释放正文，重启的FallbackCoordinator可凭索引独立查状态，多个活动事件不新增仲裁。Runtime展示带会话代次。
- 新增Keychain重开/截止保留/不可覆盖/ACK交接，超期已终态原body重放、GET后409仍保留、403与503分别处理、并发与旧授权回调、禁止新采集时未知事件0 PUT、错误ACK拒绝、ACK后未启动Runtime的恢复以及多个活动候选不选择。首轮47/47通过，最后增加原子交接后49/49通过（C4c-native-final.log）。
- 后端新增超期精确重放表征测试1/1通过：结束后两小时原观察200，事件/任务/timeline/outbox不变，异内容409，超期未知事件400。后端实现未改，属于保持行为证据，非缺陷红测试。最新C4c-backend-test.log后端153/153、check及C4c-final-compile.log全unit编译通过；production Release进行中。
- 已知剩余：confirmed事件索引没有终态压缩，历史恢复查询/全状态复制容量开放；samepair新ticket提前返回与重配并发未在C4c处理；WatchCoordinatorContractTests旧10分钟断言与现需求120秒不符，未纳入本次Mac/unit运行结果，后续须独立修正并运行Watch测试target。真机与Runtime/完整跨端链仍未验收。

- 独立C4c复审发现GET404被永久分类拒绝，会冻结随后才提交的在途原观察；C4c-independent-recovery-red.log真实Keychain/协调器1项4断言失败。现GET404仅稳定退避查询，原PUT仍必须先确认存在；PUT内容拒绝单独保留并暂停。原反例已完整迁入活动WatchMonitoringTests，另增加真实后端事务队列“GET先404、窗口内已受理PUT稍后提交”的表征测试，不改服务端截止条件。最新组件50项、后端154项及编译复跑中。

- C4c最终独立复审通过：原反例及截止/冲突/禁止创建4/4，后端两项表征2/2；完整Mac50/50、后端154/154、check、unit编译和production Release均通过。14文件与清单一致，原阻塞已解除。错误分类的准确改进是GET404不再持久拒绝，不泛称所有GET错误。该本地批次结束，C完整Runtime/跨端验收仍开放。

## C4d：Watch配对凭据与旧异步结果隔离（实施前约束）

- R02/R12/R17，F。范围：新companion ticket必须由后端接受；只有同票据的重送可复用已有处理。同票据并发合并，新旧票据交错以当前本地请求代次控制回调，不允许较早结果覆盖新会话/清新key。刷新也不能覆盖期间接受的新配对结果。唯一凭据writer仍为WatchAPIReporter与专属Keychain适配器。
- 后端同Watch已绑定不同user/account/pair时仍403，本批不允许跨账号重绑定、不改注销/活动事件政策或正式身份提供商。修复的是旧客户端忽略新凭据并误称成功、并发旧结果回写；不声称已跑真实账号迁移。新票据服务器拒绝现在会如实失败，这是明确的旧假成功修正。
- 原票据/attestation正文仅在内存请求存在，不落盘；本地保存非明文fingerprint供重启去重，不能单凭fingerprint跳过其他issuer/device/pair检查。业务上传不能在正在接受新绑定时使用旧凭据；临时失败保留事实，不清触发/位置队列。
- 验收：两张不同ticket各走一次后端；同一ticket并发/重启不二次attest；旧redeem/refresh/失败清理不能覆盖后来的会话和key；配置变化不应用旧结果；原白名单/401/403/暂时刷新及队列恢复全回归。Mac组件和generic编译，真机继续后置。
- 回退：相对C4c固定patch/归档；新增可选fingerprint兼容旧会话读取，回退必须保留新元数据。没有后端/数据库/生产迁移，不对旧数据补造身份。

### C4d实现与验证

- C4d-red.log使用C4c原源镜像真实复现2项3断言失败：不同ticket仍只发1次、新响应被旧响应覆盖。现不同票据必须后端接受；同票据Task合并/重启fingerprint去重仍保持一次attest。newlink代次使旧业务请求失效，未完成新配对时不发送旧凭据。
- 配对每次await后检查操作ID及完整配置；只在后端201且仍为当前操作时保存key/session，旧失败不清新key。refresh持有自己的operationID，完成清理不抹掉后来任务；按session/config判断能否写回。一个新配对尝试尚未成功时，原绑定的合法refresh可完成；新配对已经成功后，旧refresh不得覆盖它。
- 新增同票据并发与重启、旧refresh/新redeem成功或503失败交错、配置变化不覆盖新key/session。C4d-native-final.log第一轮55项1失败，发生在refresh发HTTP前：已允许的根地址配置与canonical会话字符串直接比较导致误清凭据。现hasValid/restore沿用发送路径同一apiBaseURL校验，仍拒绝不同issuer/path/pair/device；没有放宽断言。修正后55项重跑中。
- 限制：后端已消费一次性票据但会话响应永久丢失，仍需重新取得iPhone票据，未在本批伪造可重放身份凭据或修改后端身份事务。真正App Attest能力/用户跨账号重新绑定仍未验证且本批不放开。

- C4d独立复审反例确认已完成Task在refresh401清会话后仍返回成功（C4d-independent-cache-red.log，真实Reporter/Keychain，1项1失败）。现缓存仅合并当前在途任务，完成即移除，所有成功返回重新核对当前session/fingerprint/绑定/有效期。原反例完整迁入活动测试。
- 自复查补首配对空配置场景，发现新完成校验误比尚未设置的旧pair；C4d-initial-link-red.log1项实际失败，改为使用该次已获201的envelope pair与当前配置/session一致校验，不改变服务端跨pair拒绝。当前C4d-reviewed-final-native.log57/57、C4d-reviewed-compile.log全unit编译通过，待修正后最终独立复审与production Release。

- C4d最终独立只读复审通过：13项配对/首绑定/撤销/并发/刷新测试通过，6文件与清单一致；真实组件57/57、unit编译/production Release均通过。当前本地批次结束，真实AppAttest/已消费票据响应丢失与Runtime/完整跨端仍未验收。

## C5：第一条结束链的本地集成（实施前边界）

- R02/R03/R05/R10/R12，V及发现缺陷时F。先增加直接链接实际APIClient的Mac验证；C5-api-native.log实际13/13（6项完整API传输/路由用例＋7项结束协调器）已通过，不再需要提取APIError定义才能运行结束协调器。iPhone完整AppStore/OS入口仍不由此证明。
- 私有C5夹具仅监听127.0.0.1随机端口，运行真实createBackend/SQLite/权限/终态/发件箱；仅创建新的本地临时数据库及受控测试账号。真实Phone/Watch Swift源码在同一Mac测试模块运行，经URLSession调用REST；外部AppAttest只注入明确的测试验证器，定位/可达性是显式测试输入，不是硬件能力验证。
- 验收链：Watch合成观察创建→iPhone端稳定结束请求→服务端提交后故意丢响应及首次恢复响应→重建真实Phone client/结束coordinator并从原日志原样重试→Watch在手机可达时确认终态、封口、补传合法原历史→禁止新采样。结束后关闭夹具并重开SQLite核对终态/事实/发件箱仍在。只改测试夹具/证据，生产业务规则不改。
- 凭据局限于私有ready.json，测试拒绝非loopback地址；不调用生产或真实身份提供商、不触发真实求助/通知、不部署。回退只涉及测试文件/文档，新临时DB保留为证据，不处理任何真实数据。
- 启动run1在退出前检查发现夹具stop已关闭store，旧退出后read不能工作；在任何业务测试前停止run1并修正为重开读取，run2使用新的临时数据库。这是测试夹具关闭顺序错误，不是应用运行失败。

### C5执行结果

- 实际链接全部Phone APIClient、结束coordinator和Watch核心源，13个组件测试通过；不是提取APIError的简化替代。C5/run3两阶段经真实URLSession/loopback/SQLite通过：结束及第一次恢复响应在真实提交后被故意丢弃，重建客户端对象后两次end正文完全一致；Watch在phone reachable时确认终态，原样补传[createdAt,resolvedAt)内一个历史事实并ACK，新的采集启动计数0。
- 确实停止原Node后端进程并新建进程、加载同一SQLite；新的iPhone客户端经REST取回相同终态，无再次end写入。两次进程前后事件/Watch原事实一致，2条outbox仍PENDING（无Socket受众在线），没有把传输/送达伪装成成功。夹具已全部关闭。
- 可复现入口：`python3 ios/scripts/run_architecture_repair_checks.py --output <仓库外的新证据目录>`，依赖已安装的Swift/Node/tsx，不安装依赖。导出的实际仓库脚本C5-exported-run再次运行通过：13组件+2集成阶段，源文件前后SHA一致。脚本仅使用新建私有目录/本地受控账号，输出含临时凭据，拒绝把输出放在仓库；不访问真实服务。
- 新测试文件`ios/ArchitectureRepairChecks/CrossEndChainTests.swift`属于该独立Mac验证入口，不加入iPhone/Watch生产target。macOS同模块链接两端核心源，iOS/watchOS各真实target另已构建通过；OS监控/界面AppStore完整运行仍未由该链证明。C3的新增API路由测试已有本地运行证据；AppStore两项按钮测试仍只有编译和源码复审。
- 尚不能称完整C、真机或上线验收：该链没有真实AppAttest、后台调度、WCSession、APNs/送达、人类操作和真实GPS；模拟的是外部输入/故障，业务响应均来自实际后端。第一条核心REST/持久化链已具备本地集成证据，等待独立只读复审。

- C5独立复审在C5-independent-run实际重跑13+2通过，验证0700/0600权限、两夹具进程退出/端口关闭、源哈希一致。按其非阻塞建议，native-result增加完整原Watch payload，runner与SQLite保存fact逐字段比较；退出超时会强制回收本脚本持有的进程。更新后的C5-full-fact-run再跑13+2通过，非仅ID比较。当前没有活动本地夹具。

- C5补强最终独立复审核实13+1+1通过、全Watch正文JSON相等、源码哈希一致、端口关闭；无新增阻塞，可继续局部D1。不是AppStore/真机全验收。

## D1：按实体读取认证与Watch恢复（实施前约束）

- R04/R17/R02，S/F/V。既有实际Memory/JSON/SQLite store新增捕获单个已提交版本的实体读取接口，返回隔离副本，不暴露可改的内部根状态。IdentityAccess的authenticateToken和每连接复验、Watch四字段GET改用该读路径；旧对应全状态read退出生产调用链。事务、存储表/collection/审计/发件箱/业务权限保持。
- 需求依据：状态唯一维护者、后端提交权威与按实体访问；不改变权限/错误语义/终态规则，不选择AED或容量阈值。不更换数据库、不迁移真实数据。对旧自定义StateStore的兼容fallback仍用旧read，不能把该适配器算作性能修复；实际内建store须走新路径。
- 先前私有storage-read-cost探针已测：合成5万条audit约9.64MB，SQLite读取一个标量仍clone全状态，10次中位41.14ms、空事务123.27ms、重开138.61ms。该探针只有存储适配器的合成历史，未构成真实救助场景/目标负载/并发验收，主机其他负载未受控。
- 验收：实体副本修改不影响权威；跨正常事务提交仍读同一已捕获版本；关闭后拒绝新查询；权限与撤销旧Socket/跨用户Watch恢复仍全回归；新增路径不读取无关全历史。对比同进程同数据下旧read与新entity read，报告复制成本与残余写成本，不设置未经批准的业务容量门槛。
- 回退：相对C5归档逐文件应用patch并核对用户后续改动；只有源码API变更，无数据schema变化、无数据回退动作。JSON/SQLite依旧全状态加载、写事务依旧全量clone/validate，D1不能宣称整个存储问题完成。

### D1实现与结果

- state-read实际接管已提交版本的实体读取语义；Memory/JSON/SQLite内建store只复制被get的实体。IdentityAccess的认证/现有连接复验和Watch状态GET已停用旧全状态读取；Watch权限函数的输入收窄为devices集合，事务调用方与原权限逻辑不变。写入仍只有原store.transact。
- D1-path-red.log两项确实表明原入口调用了被测试禁用的全状态read；这是迁移边界证据，不冒充两项原业务失败。迁移后这些入口在禁用旧read时仍通过，撤销/跨主体/不存在事件的错误语义保持。故障注入store扩展为同时拒绝新旧读接口，原“读失败必须断连/不发送”断言保持，未绕过安全检查。
- 副本深层修改不影响权威、已捕获版本跨正常事务不变、Memory/JSON/SQLite三实现、SQLite关闭拒绝新读、旧自定义store一次read兼容/错误传播均通过。D1-final-backend.log **161/161**、check/build通过；两个新增测试夹具最初用了不合法Timeline kind，改为已有EVENT_ACTIVATED；成本夹具补全必需presenceObservedAt，断言未放宽。成本脚本另以strict TypeScript检查通过。
- D1-native-chain再次执行13组件＋2实际HTTP阶段通过，完整原Watch正文与SQLite事实一致、另一个Node进程恢复后端、2条outbox仍PENDING，源哈希稳定且fixture全部退出。没有Swift业务源改动，不重复无关真机/构建。

同一进程、同一设备实体、交替执行30组读（预热1组），独立执行完其他构建/测试后记录D1-state-cost-quiet.log；单位ms，中位数。主机其他软件负载仍未受控，不是SLA或目标负载证明。

| 合成审计条数 | 状态JSON字节 | 旧全状态read | 新实体read | 保持原实现的空事务 |
| --- | ---: | ---: | ---: | ---: |
| 0 | 1048 | 0.0087 | 0.0028 | 0.2306 |
| 1000 | 181937 | 0.7210 | 0.0044 | 2.6333 |
| 10000 | 1819937 | 7.0797 | 0.0114 | 31.6239 |
| 50000 | 9139937 | 46.8874 | 0.0309 | 120.6167 |

初次与测试/Swift构建并行的成本日志也保留，不能用其极值作生产能力结论。新路径是在内存中的已提交快照按实体访问，SQLite启动仍加载全部数据；尚未改成SQL按需加载或局部写事务。当前只解决三个读取入口的全历史复制开销，写入/启动/历史增长/队列积压容量继续R04，D1等待独立复审。

## 当前状态索引（以具体子风险为单位）

| 风险/子项 | 当前判定 | 尚未完成的范围 |
| --- | --- | --- |
| R01 内部timeline直接对外 | 已修复：B2恢复投影替代原audit返回 | 详细审计字段权限仍待业务依据 |
| R17 已有Socket撤销与每次发送授权 | 已修复：B1及C2真实连接回归；D1读路径复测通过 | 正式身份/跨实例/完整账号切换验收不足 |
| R16 真实Watch采样时间被触发时间替代 | 已修复：B3到服务端存储，C5全字段HTTP对比；本批再加适配器有效 fix 门 | 真机OS回调未测，新鲜度阈值仍待决 |
| R02/R12 Watch无独立恢复、clear或35分钟删未ACK队列 | 已修复：C4b/C4c的本地恢复/保留/隔离与ACK交接；D3补齐fallback未确认事实来源与Fall context持久化失败隔离；本批接入前台生命周期恢复 | fallback来源全量历史迁移、confirmed索引增长、OS后台频率和物理 Watch仍未验证 |
| R10 重复终态writer/新ID盲重试 | 已修复所迁路径：C1四入口及C3稳定结束意图，核心后端 `event-resolution.ts` 继续统一 resolve/false-alarm；状态确认 response/scheduler 已迁 `status-confirmation.ts` | AppStore按钮完整runtime尚缺，兼容入口和真实后台仍待验证 |
| R05 业务变更后的通知记录丢失 | 已完成 Socket 业务通知的事务入箱与发送时授权复核；iPhone delivery receipt 的 append/drain/retry 另由 `DeliveryReceiptUploadCoordinator` 接管；REST 恢复请求仍是当前快照重播，不是历史送达证明 | APNs、跨进程外部发送、用户收到/查看和长期容量仍未验证 |
| R04 全状态读取/写入历史成本 | D1实体读取、E-STORAGE-01 no-op、E-STORAGE-03 committed-row cache 与成本指标已实现 | 其他读取、事务前 clone/validate、全状态加载与目标容量仍存在 |
| R03 AppStore业务编排集中 | 仍存在；已迁结束用例、最新位置上传、连接重试、REST恢复调度、事件投影、响应邀请/回执投影、receipt upload/retry，以及开放事件位置事实 owner | assignment/任务投影、Presence、事件窗口/封口适配、其他操作仍需逐路径迁移 |
| R15 GET恢复与断线恢复调度 | D6已迁REST恢复等待/退避/follow-up调度；状态确认 scheduler 已迁至 `status-confirmation.ts`；AppStore仍维护服务端快照 | 定时业务执行、完整AppStore runtime、重启/后台/容量仍需独立验证 |
| R13 手工跨端契约 | 仍存在，本批字段/编解码同步 | 未引入生成工具链，需持续契约验证 |
| R06/R07/R08/R09/R11/R18及RV-01/04/07 | 仍存在或待业务决定 | 选项、影响、建议与受阻范围见原决策表，未自选规则 |
| R14及真机/路线/容量能力 | 会员资格阻塞已解除，能力证据仍不足 | 正式身份、AppAttest、APNs、实际路线、OS后台及目标负载需独立工作包 |

D2已核对并修复未确认触发来源，D3继续补齐fallback待发事实的本地来源约束（见后文）；不能扩大成真机重装或后端误归属的证据。fallback历史中旧记录可能仍没有来源元数据，只有在GET证明事件存在且当前会话有权访问后才能原样重放，后续复核时不得自动猜测旧事实所属用户。

- D1最终独立只读复审通过：9项针对测试通过，161/161及C5实际链证据核实，12文件匹配清单。确认返回实体副本不会写回权威、现有commit normalize也会复制draft、跨正常提交snapshot不混读；权限/错误/事务保持。D1本地批次结束，代码回退无数据迁移；全状态启动/其他读/写仍未解决。

### 本轮交付与继续边界

已完成A基线、B1–B3、C1–C4d的本地源码批次、C5核心REST/持久化链、D1局部实体读取、D2未确认触发来源隔离、D3 fallback来源/本地状态失败隔离、D4最新位置上传、D5连接重试调度、D6 REST恢复调度、D7事件投影合并、D8响应邀请/回执投影、D9 assignment/任务投影及D10 Presence上传投影；本轮又完成核心后端结束/误报/AED 用例边界与可靠通知发件箱迁移。每个实现批次均经同一执行者只读复审或保留本批待复审状态，发现的新增阻塞已修正并重测。整体架构整改尚未完成，不能称具备完整AppStore运行、OS后台、正式身份/APNs/实际路线、目标容量、Xcode Cloud或上线能力。

本轮没有Git提交/推送：大量核心文件包含受保护的原有未提交实现，直接按文件提交会混入原有工作；每批已用相邻已校验归档生成独立patch并保存SHA256，不能用创建分支替代备份。准确继续起点见HANDOFF；D3后继续迁AppStore其余会话/投影/位置及backend接受/退出/非终态通知用例；业务未决部分继续暂停，不自动归还AED、不改变无人回答关闭等规则。真机按用户最新指示继续后置，本轮所有本地测试后端均已退出。

## D2：Watch未确认触发的来源绑定（实施前约束）

- R02/R12/R17，先复现再F；本批仅迁触发观察的来源维护。旧Keychain观察可能跨新的UserDefaults deviceID存留，当前submit在35分钟内不先确认后端事件，使用新会话直接PUT。构造合成重启/配置重建和真实Keychain/Reporter反例，不将其表述为真机重装已复现。
- 来源由已获后端会话的issuer/user/account/device/pair确定，使用稳定非令牌指纹随Fall context及受保护观察保存。刷新令牌不改变事实来源；新身份不能接管旧观察。来源不明的旧记录必须保留，只允许先GET证明已存在且有权恢复再原样PUT；404不能授权新创建，不能为旧事实猜测账号。
- 该指纹仅是本地发送约束，不替代后端授权，不进入业务payload，不改变同device跨账号重绑403、首次创建35分钟、帮助120秒或结束条件。正式Watch会话契约已有必需userId/accountId；旧本地会话可解码，须从后端刷新获得身份后才能确定新记录来源。
- 未修改：fallback已存在事件的后端权限、AED/登出业务、新身份提供商、设备安装/卸载或真机测试。fallback每条记录更完整的来源隔离继续单列，不能以触发修复宣称全队列整改完成。
- 验收：新设备恢复旧未确认观察0创建且原文保留；同来源重启/令牌刷新精确重试；不同来源、Fall与答复之间换身份及旧await不越界；旧来源未知但后端已有事件可GET+精确ACK；身份字段缺失/变化与队列来源损坏拒绝。现有57组件、真实HTTP结束链和generic iOS/Watch编译回归，真机后置。
- 回退：使用已校验D1归档及D2相邻patch。无服务器/数据库schema变更；本地新增来源字段必须保留，不允许旧decoder重写丢弃后再盲重试。旧未确认且来源未知的首次创建会停止，这是安全隔离的明确兼容性变化，原记录不删除。


### D2当前实现与证据

- D2-origin-red.log在D1源码上实际1项2断言失败：保留旧Keychain正文、建立新配置和会话后，真实Coordinator/Reporter向记录传输器发出PUT并按模拟201清除了原文。当前反例加强为正式完整会话身份，期待仅GET404、0 PUT及完整原文保留；不是实际后端创建或真机重装证据。
- 来源由WatchAPIReporter从后端响应已要求的user/account加issuer/device/pair计算版本化长度前缀SHA256，不含令牌；Fall context只保存非明文指纹，Keychain正文/指纹原子且不可重新归属。submit及Reporter实际请求前后均核对来源，旧无来源内窗盲PUT退出；旧unknown仅GET证明已有且授权后重放，同device跨账号后端403未改。
- 64/64真实Watch组件通过（D2-native.log）：7项新增覆盖来源未知新device、已知来源重启/切换回原来源、Fall到答复换身份、坏元数据原字节保留、合法token刷新/重启稳定、refresh身份缺失或变化拒绝及Reporter发送前阻止错来源。原57项断言保留；模拟会话响应补全契约本来必需的userId/accountId，未放宽安全断言。跨端HTTP链/production与unit编译及独立复审待完成。


- D2独立复审43项既有来源/配对/恢复通过，但发现两项新增保留缺口。真实Keychain的显式sourceBindingsByEventID=null红测1项3失败，原字节被维护重写；真实UserDefaults+Keychain的坏source context红测1项1失败，答复路径在保护保存失败前先清了context（尚未形成上传正文，不冒称正文队列被删）。现只有字段缺失兼容旧格式，null拒绝；answer/outgoing/match消耗前验证新增指纹，保持原context和120秒既有过期规则。不在Codable直接抛错，避免旧UserDefaults适配器吞解码错误后以空集合覆盖；该通用适配器的错误协议仍需后续整改。
- 原独立反例已迁入活动WatchMonitoringTests，私有重复测试文件移到证据根目录保留；原断言保持，另覆盖outgoing与缓存call的消耗分支。此前D2 13+2实际HTTP链、unit/Release已通过；上述修正后的全量组件/编译/链路及复审重跑中。


- D2最终独立只读复审6/6（原反例/来源切换/恢复/过期）通过，11文件匹配；D2-reviewed-native.log 66/66，D2-final-compile.log与D2-final-release.log通过，D2-final-chain.log 13+2实际HTTP/进程重启再通过。D2本地源码批次结束；只修复未确认触发来源，fallback来源全覆盖/真机重装/完整Runtime仍开放。

## D3：Watch fallback来源与本地状态持久化错误（实施前约束）

- R02/R12/R17，F/S。范围：为每条未确认fallback位置事实增加本地非秘密来源指纹；将当前会话主体、issuer、device、pair的稳定绑定用于发送前后隔离；UserDefaults Fall context从静默空状态改为可报告持久化失败。HTTP fallback正文不增加身份字段，后端仍是授权和事件状态权威。
- 兼容：旧fallback队列缺来源字段仍可读，但只能在当前会话GET证明同一事件已存在且有权访问后原样重放；不存在/无权/状态读取失败均保留正文，不创建新事件。新采集必须有当前来源指纹；来源变更停止发送并保留旧事实。来源指纹不可替代Bearer授权，不进入业务payload。
- 非范围：不改变Watch立即备份、后端10秒仲裁、120秒帮助窗口、35分钟首次创建截止、终态封口、AED或登出规则；不修改服务端schema、业务身份规则或数据迁移。会员资格工作包已解冻，但本批仍不执行设备安装、OS后台或真机测试。fallback已确认服务器事实的长期索引增长仍开放。
- 验收：来源切换不发送/不ACK旧记录，切回原来源用同ID同正文重试；旧无来源记录只有GET存在证明后补传；fallback source map为显式null或非法值拒绝读写并保留原文件字节；UserDefaults损坏或写失败返回persistenceFailed，不覆盖原字节、不清除唯一Fall context；终态历史隔离、旧回调和源代次回归。
- 回退：相邻D2归档及D3 patch逐文件回退；无数据迁移。回退不能把新队列重写成无来源空状态，也不能删除受保护的旧事实。测试期间的临时文件在私有证据目录，生产Keychain/文件不触碰。

### D3实现与验证

- `WatchFallbackQueueState`新增本地`sourceBindingsByPositionUpdateID`，`ProtectedFileWatchFallbackOutbox`原子保存/读取/清理来源；`WatchFallbackCoordinator`在新采集、GET证明的旧记录重放、发送后await分别检查来源。已知来源改变返回authorizationRequired并停止采集，pending/历史正文保留；未知旧记录不允许盲PUT。
- `FallEventStatePersisting`所有读写方法改为throws；`UserDefaultsFallEventStateStore`解码、编码和上下文清理失败均返回`WatchAPIError.persistenceFailed`，损坏数据不再变成空字典。观察正文成功写入受保护outbox后立即交接并清理短期Fall context；网络尚未成功时正文仍保留，只有ACK才删除正文。过期抑制失败时未完成交接的context继续保留。
- D3-final2-native.log实际Mac包 **93项执行、2项跳过、0失败**（其中新增来源/旧记录/显式null/UserDefaults损坏、在途二次回答、来源/代次竞态、sample入队前停止和outbox交接回归）；D3-backend.log后端 **161/161**；D3-final2-release.log iOS Release、D3-watch-compile.log Watch target generic build-for-testing、D3-final2-unit.log iOS unit build-for-testing、D3-final2-chain.log **13 Phone+78 Watch+2真实HTTP阶段**通过。第一次unit命令因与并行Release共用DerivedData出现build.db锁，未记为源码失败；改用独立D3-final2-unit-derived后TEST BUILD SUCCEEDED。所有本地fixture退出，未操作设备。
- D3最终独立只读复审 **5/5** 通过：确认最后授权await后generation/revision同步检查、outbox耐久交接后在途二次回答不再suppress、来源/GET proof/最终ACK检查保持有效。新增sample来源查询停止回归与旧post-upload阶段回归均通过；不把最后guard的静态修复冒称硬件复现。
- 本批不声称fallback所有历史已有身份、后端误归属已在真机复现或OS后台可执行；旧UserDefaults其他状态存储和confirmed索引压缩仍需后续工作。

## V1：修正旧契约测试并导出Watch组件验证（实施前）

- R13/V2-A04，测试修正与V；不修改任何业务源/端点/状态。现requirements第72–73行、契约、现有边界测试明确120秒，旧WatchCoordinatorContractTests仍断言600秒。仓库外Mac独立baseline实际2项1失败（V1-contract-baseline-red.log），与本次架构新增回归分开；将断言改成已批准120秒，不放宽边界。
- 将已有真实Watch组件测试接入仓库run_architecture_repair_checks.py，直接链接实际源码和活动测试，单独module保持@testable边界。停止依赖只有私有目录才知道的Watch测试集合，不复制业务实现、不新增依赖、不操控设备。
- 验收：原2项契约测试通过，导出脚本实际运行Phone/Watch组件及2阶段HTTP链，源哈希一致、临时后端退出。该脚本不能证明AppStore完整runtime、watchOS测试target系统运行或真机。
- 回退为D2归档后的测试/脚本/文档patch；没有数据或业务源码迁移。本批可独立于下一条业务迁移执行，修复已确认的验证缺口。


### V1结果

- V1-contract-green.log原WatchCoordinatorContractTests 2/2通过；只将600秒断言改为已批准120秒，没有业务源码变化。与既有120秒含边界/超过边界的测试共同保留。
- 仓库导出入口V1-exported-checks实际运行13 Phone + 67 Watch组件 + 2真实HTTP阶段通过；Watch单独module直接链接活动源和测试，包括上述旧target的两项测试。此前私有66项包含1项额外恢复hint兼容测试，导出67项=原活动65项+本批契约2项，不将二者冒称同一测试集合。
- runner读取XCTest实际数量，选择未执行任何测试时失败，避免过滤器空跑假成功；所有参与Watch源/测试纳入固定源SHA。两个后端进程前后事实/发件箱一致，夹具退出。首轮仅有Python无效转义SyntaxWarning，已改raw regex；strict Python语法检查通过，最终源码等待独立复跑/复审。不影响产品或旧测试断言。


- V1最终独立完整复跑（V1-independent-checks）13 Phone+67 Watch+2 HTTP全部通过；实际计数、完整事实、重启终态/outbox、源SHA均核验，两个后端进程/端口关闭，无设备或真实服务行为。V1-watch-compile.log活动AEDResponseWatchTests的generic watchOS Simulator build-for-testing也通过，仅编译，未启动模拟器或真机。V1本地批次结束。

## 当前阶段交付状态（D9后）

### Apple Developer Program 状态更新（2026-09-09）

- 用户确认会员资格已获批。解除此前仅因 Apple Developer Program 未获批而冻结的工作包：正式开发者签名与安装、App Attest 实际调用、APNs 配置/发送验证、物理 iPhone/Watch capability 与授权链路。
- 解除冻结不等于这些能力已经通过；每项仍需真实配置、受控账号、硬件和分层证据。当前先完成架构源码批次，真机按既定顺序后置；不因会员获批改变业务待决规则或把模拟成功写成真实能力。
- 仍独立阻塞或待确认：后端公网/真实路线配置、APNs受众和送达定义、Watch后台执行频率、真实设备数量、容量目标，以及无人回答关闭、人数上限、AED交接等业务规则。

- 可继续下一源码批次，无本批未解决的新严重回归。A/B1–B3/C1–C4d/C5核心链/D1/D2/V1已各批记录并独立只读复审；不是整个架构整改或上线通过。分支与原HEAD不变，没有混入旧dirty工作提交或远程操作。
- 当前统一可复跑入口运行真实Phone/Watch组件与本地REST/持久化链；D4 原生组件为 **15 Phone + 78 Watch + 2 个真实HTTP阶段**，D5 在此基础上增加连接重试调度回归，最终为 **16 Phone + 78 Watch + 2 个真实HTTP阶段**；D5 unit generic build-for-testing 与 Release generic build 均通过。D3-final2-native 的93项证据仍保留，后端最新完整161/161仍来自D1；AppStore完整runtime和真机仍未证明。
- D4 已把待命/搜索圈最新值 R 上传的 pending、稳定 `positionUpdateId`、重试、ACK tier 和任务取消交给 `LatestPositionUploadCoordinator`；AppStore 仅保留模式选择、连接/模式代次、UI ACK 投影和事件批次事实。旧 `drainPositionUploads` 路径已停用，事件参与者一秒批次未迁移。新增原生回归验证瞬时503后同ID重试，边界测试确认旧上传实现不再位于 AppStore。
- 模拟器单测尝试完成构建但测试宿主在任何 XCTest 开始前报 `AEDResponseTestHost encountered an error / Testing was canceled`，174秒后中断；记录为测试环境阻塞，不能当作业务失败或成功。Wi‑Fi 可调用手机已记录为后续设备验收条件，但按用户顺序仍不启动真机。
- D6 已通过独立组件回归和源码/工程边界复核：REST 恢复调度已迁入 `RestoreCoordinator`，AppStore 仍是事件快照、连接代次和恢复后投影顺序的唯一维护者。D6 原生组件为 **17 Phone + 78 Watch + 2 个真实HTTP阶段**；unit generic build-for-testing 与 iOS+Watch Release generic build 均通过。D6 不证明 AppStore 完整 runtime、模拟器 XCTest、OS 后台或真机。
- D7 已通过独立组件回归和工程边界验证：事件投影合并规则已迁入 `EventProjectionReducer`，AppStore 仍唯一写入 `visibleEvents` 和恢复后业务副作用。D7 原生组件为 **18 Phone + 78 Watch + 2 个真实HTTP阶段**；unit generic build-for-testing 与 iOS+Watch Release generic build 均通过。D7 不证明 AppStore 完整 runtime、模拟器 XCTest、OS 后台或真机。
- D8 已完成响应邀请与投递回执投影迁移：`ResponseOfferProjectionCoordinator` 唯一维护当前邀请和回执状态机，AppStore 保留 UI 镜像、VIEWED/过期/角色门禁、后端决定和待发送回执传输队列。D8 原生组件为 **19 Phone + 78 Watch + 2 个真实HTTP阶段**；unit generic build-for-testing 与 iOS+Watch Release generic build 均通过。D8 不证明完整 AppStore runtime、模拟器 XCTest、真实通知送达、OS 后台或真机。
- D9 已完成 Assignment/任务投影迁移：`AssignmentProjectionCoordinator` 唯一维护 assignment、`acceptedResponseEventID`、AED receipt 幂等状态；AppStore 保留角色/退出门禁、REST task 操作、timeline、位置窗口和 Presence 副作用。D9 原生组件为 **20 Phone + 78 Watch + 2 个真实HTTP阶段**；unit generic build-for-testing 与 iOS+Watch Release generic build 均通过。D9 不证明完整 AppStore runtime、模拟器 XCTest、AED 生命周期规则、OS 后台或真机。
- D10 已完成 Presence latest-state 上传迁移：`PresenceUploadCoordinator` 唯一维护 signature、pending update、稳定 `presenceUpdateId`、重试和取消 generation；AppStore 保留连接/认证/恢复门禁、`lastPresence` UI 镜像和 ACK 后附近摘要副作用。D10 原生组件为 **22 Phone + 78 Watch + 2 个真实HTTP阶段**；unit、ControlledTests 与 iOS+Watch Release generic build 均通过。D10 不迁移附近摘要查询、事件位置队列或 Presence 本地持久化，也不证明完整 AppStore runtime、真机或后台。
- D11 已完成附近摘要查询迁移：`NearbyVolunteerSummaryCoordinator` 唯一维护查询 task、请求 generation、旧结果抑制和新鲜度检查；AppStore 保留中立/权限/任务/邀请门禁、离线预览和 UI 镜像。D11 原生组件为 **23 Phone + 78 Watch + 2 个真实HTTP阶段**；unit、ControlledTests 与 iOS+Watch Release generic build 均通过。D11 不迁移事件位置、具体志愿者身份或后端聚合权威，也不证明完整 AppStore runtime、真机或后台。
- D13 已完成事件位置恢复 grace scheduler 迁移：`EventPositionRecoverySchedulerCoordinator` 唯一维护 5 秒等待、context lease、恢复循环和停止；AppStore 继续唯一维护恢复窗口、`APP_NOT_RUNNING` 事实、持久化、封口和批上传。D13 原生组件为 **25 Phone + 78 Watch + 2 个真实HTTP阶段**；unit、ControlledTests 与 iOS+Watch Release generic build 均通过。D13 不改变恢复分类、队列格式或服务端权威，也不证明完整 AppStore runtime、真机或后台。
- D14 已完成事件位置批上传 transport single-flight 迁移：`EventPositionBatchUploadCoordinator` 唯一维护 immutable batch 发送、退避、代次 lease 和 reset；AppStore 继续唯一选择已持久化 batch、ACK 后删除和永久拒绝隔离。D14 原生组件为 **27 Phone + 78 Watch + 2 个真实HTTP阶段**；unit、ControlledTests 与 iOS+Watch Release generic build 均通过。D14 不改变 batch/record 幂等、队列格式或服务端权威，也不证明恢复/批上传完整交错、完整 AppStore runtime、真机或后台。
- 下一准确起点：D16 已完成 delivery receipt 队列持久化 owner；继续处理持久化失败后的人工/会话恢复入口，再按业务影响优先级迁移 backend 接受/退出/任务用例、路线 provider 和 Watch/OS后台恢复。E-STORAGE-02 仍只是合成成本证据，正式身份/APNs、真机和真实路线仍按各自前置条件推进。

## D4：iPhone 待命位置上传职责迁移（实施前约束）

- 对应风险：R03（AppStore 同时维护会话、事件投影和位置上传）以及 R12 的客户端“最新位置投影”边界；不改变事件位置事实队列的维护者。
- 当前职责证据：`AppStore.swift` 的 `enqueuePositionUpload`、`drainPositionUploads`、`suspendPositionPublishing` 共同维护待命/搜索圈 R 的 pending 样本、稳定 `positionUpdateId`、重试、连接/模式代次和 ACK tier；`LatestPositionUploadPolicy` 只负责阈值判断。事件参与者 P/R 仍由 AppStore 的一秒批次队列维护。
- 目标归属：新增具体的 `LatestPositionUploadCoordinator` 负责“待命/搜索圈最新值上传”这一条可重试传输用例；AppStore 继续唯一维护 UI 投影、事件模式选择、连接/账号权威代次和事件批次事实，只通过 ACK/错误回调更新展示状态。
- 可写状态：协调器拥有 pending 最新样本、上传任务、稳定 ID、上次已确认样本/开始时间、重试代次；AppStore 不再直接写这些上传状态。协调器不能决定事件参与资格、患者/响应者角色或全局人数/任务。
- 接口与事务边界：输入必须是已由 AppStore 确认的 `.responder` 模式和当前连接代次；搜索圈仍由服务端 ACK 的 `positioningTier` 表达，不是客户端新增模式。只调用现有 `EmergencyAPIClient.updateResponderPosition`，保留 `observedAt` 和服务端 `serverReceivedAt`。发送前后通过 AppStore 提供的代次/模式门检查，ACK 仅更新本地展示投影，不能替代 REST 恢复。
- 非修改范围：不迁移事件批次封口/受权时间窗，不改位置阈值、终态规则、权限门禁、API JSON、Watch fallback、后端存储或真机行为；不改变临时错误重试与权威冲突触发恢复的既有语义。
- 前置决策：无新增业务决策。已确认的“事件批次与最新值队列分离”是结构边界；搜索圈阈值继续使用当前批准配置，不在本批调整。
- 兼容影响：接口和请求体保持不变；内部移动 pending/重试状态，不改变 AppStore 对外发布属性或 `positionUpdateId` 幂等语义。旧路径在迁移后停用，不能与新协调器并行写入。
- 验收用例：首次样本立即上传；时间/位移阈值抑制；瞬时失败保留最新样本并以同一 ID 重试；新样本覆盖未发送旧样本；连接/模式代次变化后旧 ACK 不得写回；事件模式不进入最新值队列；服务端 ACK 的 `positioningTier` 仍触发原有恢复/附近摘要行为。
- 回退：仅回退 D4 代码和测试 patch；恢复前先停止新协调器并确认当前工作树差异，再逐文件取相邻 D3 归档比对。无数据库或本地队列格式迁移；不得用回退删除已提交的事件位置事实。
- 业务待决仍按台账原选项处理：无人回答关闭、重复跌倒、人数/邀请查看、失联补位、AED无替代/持有退出/现实归还、活动登出、手机可达但后端无有效位置的备用策略。Apple Developer Program会员资格已获批，正式身份、AppAttest、APNs、签名设备安装等工作包不再因会员冻结；真实路线、双端硬件/后台与目标负载仍等待相应配置/环境，未用mock成功替代完成。
- 回退使用相邻批次patch/已校验归档，先比对当前用户后续修改；原HEAD不能作为本轮前业务基线。代码回退不等于数据回退：outbox和客户端新增来源/封口/拒绝/恢复索引字段须前向兼容保留；没有生产数据迁移或备份，不能删新集合、清队列或恢复旧DB。

### D4 实现与验证

- `ios/AEDResponse/Application/LatestPositionUploadCoordinator.swift` 只接收 AppStore 已确认的 `.responder` 最新值模式；搜索圈仍是服务端 ACK 的 `positioningTier`，不是客户端模式。它拥有 pending 样本、稳定 ID、上传任务、重试计数、最近 ACK 样本/时间和定位 tier。`CurrentState` 门在发送前、ACK 后和失败重试前复验连接/模式代次及当前模式，`reset()` 只清最新值投影，不触碰事件位置保护队列；`Domain/LatestPositionUploadPolicy.swift` 保持纯阈值策略，不反向依赖 API/服务层。
- AppStore 的 `enqueuePositionUpload` 变成单一接入点，`handleLatestPositionUploadAck` 只写 `lastPositionUpdateResult`、附近摘要唤醒和恢复提示；原 `drainPositionUploads`、latest-value pending 和 task 状态已移除。`receiveLocationBatch` 的事件模式仍进入原一秒事实批次，未与最新值上传合并。
- 验证：`D4-native-components.log` 实际 **15/15**（含503重试与错误 ACK 同ID重试）；`D4-watch-components.log` **78/78**；`D4-native-chain.log` 与 `D4-native-after-server-restart.log` 的2阶段真实HTTP/重启恢复通过；`D4-final2-unit-build.log` 为 `TEST BUILD SUCCEEDED`；`D4-final2-release-build.log` 为 `BUILD SUCCEEDED`。后端 fixture 无残留，源清单在运行前后相等。
- 第一次原生链尝试仅因导出脚本缺少 `AppFeatureFlags.swift` 而编译失败，已把该实际依赖加入 runner 后重跑通过；不把脚本编排错误记为产品失败。模拟器启动阻塞保存在 `D4-simulator-host-blocked.log`，无测试断言开始。
- D4 独立只读复审已通过：复核确认旧 `drainPositionUploads` 和 pending 字段已停用，事件批次未混迁；错误 ACK 会保留原样本并同 ID 重试，403/409冲突语义与原路径一致。新增 `APIClientSessionRotationTests` 实际 **8/8** 通过；该复审不代表 AppStore完整runtime、OS后台或真机证据，仍不能进入设备验收。

## D5：iPhone 连接重试调度职责迁移（实施前约束）

- 对应风险：R03（AppStore 同时拥有会话、恢复和重试调度）以及 R15（重连/REST 恢复必须保持独立顺序）；不迁移连接代次、LiveSession 或事件投影。
- 当前职责证据：`AppStore.swift` 的 `desiredBaseURL`、`reconnectAttempt`、`reconnectTask` 和 `scheduleReconnect` 共同维护目标服务、指数退避、单任务门和取消；`establishConnection` 仍负责 bootstrap、Socket 建立、权限复核与连接代次。
- 目标归属：新增 `ConnectionRetryCoordinator` 只维护目标 URL、退避次数、单一重试任务和取消 generation；AppStore 通过一个明确的异步建立回调提供实际连接用例。协调器不读取事件、任务、位置或权限真值，也不直接改变 `ConnectionState`。
- 可写状态：协调器唯一写入目标 URL、重试次数、任务句柄和调度 generation；AppStore 唯一写入 `connectionGeneration`、`liveSession`、`connectionState`、REST 恢复代次和业务投影。
- 接口与事务边界：`begin(baseURL:)` 只建立新的重试上下文，`scheduleIfNeeded()` 最多安排一条等待中的退避任务，`markConnected()` 清除当前退避，`cancel()` 使在途回调失效。它不宣称 bootstrap 在途期间的全流程 single-flight；每次实际建立仍由 AppStore 的 `establishConnection` 执行，不改变 bootstrap/Socket/REST-first 恢复顺序。
- 非修改范围：不改认证主体、权限、Socket 授权、事件状态、位置队列、通知、退避上限、错误文本或业务规则；不把连接成功解释为事件恢复完成。
- 兼容影响：手动 `connect`、自动连接、Socket 断开重试和 `disconnect` 继续使用原 API；旧字段和调度实现停用后不能并行写入。连接代次不迁移，确保旧连接和旧回调继续失效。
- 验收用例：重复断开只保留一条重试；重试失败按原 1/2/4/8/16/30 秒退避；连接成功取消等待任务并清零次数；登出/权限撤回使等待任务不再建立连接；新的 baseURL/连接代次不能被旧任务覆盖。
- 回退：只回退 D5 源码、测试、工程接线和文档 patch；从 D4 归档逐文件比对后恢复。没有数据库或客户端事实格式迁移，代码回退不删除事件位置或未确认队列。

### D5 实现与验证

- `ios/AEDResponse/Application/ConnectionRetryCoordinator.swift` 已接管目标 URL、退避次数、单一等待任务和取消 generation；AppStore 仅通过 `begin`、`scheduleIfNeeded`、`markConnected`、`cancel` 接入，继续维护 `connectionGeneration`、LiveSession、连接状态和 REST-first 恢复。旧 `desiredBaseURL`、`reconnectAttempt`、`reconnectTask` 已从 AppStore 移除。
- `D5-native-components.log` 实际 **16 Phone + 78 Watch** 组件、`D5-native-chain.log` 两个真实HTTP/重启阶段通过；新增测试验证重复调度只保留一条等待退避、失败后仍保持下一次机会、取消旧 generation 后不再建立连接。`D5-final-unit-build.log` 为 `TEST BUILD SUCCEEDED`，`D5-final-release-build.log` 为 `BUILD SUCCEEDED`。
- 独立只读复审确认自动连接、手动连接、Socket 断开和登出/权限撤回均经过同一 coordinator，未绕过 REST 恢复；边界测试已修正为只禁止 AppStore 旧字段声明/旧写入，等价源码谓词确认通过。D5 仍不宣称 bootstrap 在途期间的全流程 single-flight，也未运行 AppStore 完整模拟器断言或真机。

## Xcode Cloud 外部能力核验（2026-09-09）

- 源码证据：当前工作树没有 `ci_scripts`、Cloud workflow 文件、Cloud build 脚本或 `develop` 分支引用；本机只有 Xcode `26.6 (17F113)`，没有可调用的 `xcode-cloud` CLI。该结论只说明本地项目尚未配置/连接 Xcode Cloud，不说明 Apple 账号没有资格。
- 官方流程依据：[配置首个 Xcode Cloud workflow](https://developer.apple.com/documentation/xcode/configuring-your-first-xcode-cloud-workflow) 要求先在 Xcode 中为项目配置首个 workflow；首个构建成功后才能在 Xcode 或 App Store Connect 编辑/新增 workflow。[自定义脚本](https://developer.apple.com/documentation/xcode/writing-custom-build-scripts) 必须位于项目或 workspace 同级的 `ci_scripts` 目录。当前缺少仓库连接、workflow、App Store Connect 应用绑定和首个云端构建证据。
- 处理类型：V（外部能力/配置），单列工作包 `XCLOUD-01`。不把云端构建替代本地组件、后端恢复、权限和跨端链验证；不触发云构建、不创建 workflow、不写入 App Store Connect，也不提交密钥。解除会员资格冻结后，后续可在配置齐全且用户明确要求时建立首个受控 workflow。

## D6：iPhone REST 恢复重试调度职责迁移（实施前约束）

- 对应风险：R03（AppStore 同时拥有会话、恢复和重试调度）及 R15（恢复不应依赖用户再次查询）；D5 已迁出连接退避，本批继续迁出恢复调度，不迁移事件快照维护者。
- 当前职责证据：`AppStore.swift` 的 `restoreRetryTask`、`restoreAttempt`、`restoreFollowUpRequested`、`restoreFollowUpImmediate` 与 `scheduleRestoreRetry` 共同维护 REST 恢复的等待、指数退避、同一连接代次的 follow-up 和取消；`reconcileVisibleEvents` 仍写入事件投影与 `restoredConnectionGeneration`。
- 目标归属：新增 `RestoreCoordinator` 只负责恢复调度状态、退避等待、同一代次的 follow-up 合并和取消 generation；AppStore 继续唯一维护连接/会话、`connectionGeneration`、`reconcileVisibleEvents`、事件/任务/位置投影和服务端真值。
- 可写状态：协调器唯一写入恢复任务句柄、退避次数、follow-up 标志和调度 generation；AppStore 唯一写入 `restoredConnectionGeneration`、`visibleEvents`、任务关系、位置封口和 `lastError`。协调器不能创建事件、改变终态、决定权限或清理事实队列。
- 接口与事务边界：`schedule(immediate:)` 仅在 AppStore 提供的“当前连接且存在 LiveSession”门通过时安排一次等待；`markRestored()` 清零退避；`cancelWaiting()` 用于 Socket 暂时断开，只取消当前等待/follow-up 并保留已有退避次数；`reset()` 用于新连接、主动断开和登出，清零并使旧回调失效。实际恢复仍调用 AppStore 的 `reconcileVisibleEvents`，成功后才推进位置/Presence/待处理结束操作。
- 非修改范围：不改变恢复 URL、字段权限、错误文本、退避上限（即时、1/2/4/8/16/30 秒）、连接建立/Socket 授权、事件状态或业务待决规则；不宣称整个 AppStore runtime single-flight，也不启动真机或云端 workflow。
- 兼容影响：REST API、客户端投影和 Socket 唤醒语义保持；旧恢复字段和方法在迁移后停用，不与新协调器并行写入。没有数据库、本地事实队列或契约格式迁移。
- 验收用例：重复 Socket/前台唤醒在一次恢复进行中只合并为一个 follow-up；失败保留同一连接代次并按原退避继续；成功清零退避；断开、登出或新连接取消旧等待且旧回调不能写入；事件恢复成功后仍按原顺序恢复位置上传、Presence 和待提交结束意图。
- 回退：只回退 D6 源码、工程接线、测试与文档 patch；从 D5 归档逐文件比对并保留任何已经确认的事件位置、结束意图和发件箱事实，不做代码回退以外的数据删除或旧库恢复。

### D6 实现与验证

- `ios/AEDResponse/Application/RestoreCoordinator.swift` 已接管 REST 恢复等待、1/2/4/8/16/30 秒退避、同一连接代次的 follow-up 合并和取消 generation；`cancelWaiting()` 保留 Socket 暂时断开前的退避次数，`reset()` 才清零。`AppStore` 的旧 `restoreRetryTask`、`restoreAttempt`、`restoreFollowUpRequested`、`restoreFollowUpImmediate` 已停用。AppStore 仍通过 `reconcileVisibleEvents` 写入已授权服务端事件快照，并决定恢复后位置批次、Presence 和待提交结束意图的顺序。
- `D6-native-components.log` 实际 **17 Phone + 78 Watch** 组件、`D6-native-chain.log` 与 `D6-native-after-server-restart.log` 两个真实 HTTP/重启阶段通过；新增恢复测试验证在途恢复只合并一个 follow-up，`reset()` 后旧退避不再执行。`D6-final-unit-build.log` 为 `TEST BUILD SUCCEEDED`，`D6-final-release-build.log` 为 `BUILD SUCCEEDED`。
- 源码边界测试确认恢复调度字段不再由 AppStore 直接维护；工程三目标均已接入新文件。该批仍不宣称完整 runtime single-flight、真实通知送达、OS 后台频率、物理设备或 Xcode Cloud 构建。

## D7：iPhone 事件投影合并职责迁移（实施前约束）

- 对应风险：R03（AppStore 同时承担投影合并和业务编排）以及 R15（恢复快照必须按服务端版本一致应用）；不迁移事件/任务全局写权或位置事实队列。
- 当前职责证据：`AppStore.swift` 的 `applyServerSnapshot` 和 `replaceEvent` 直接维护服务端事件投影的过滤、同 ID 合并、终态单调性和 coordination revision 门；随后还在同一方法中触发响应请求、assignment、位置窗口和 Presence 副作用。
- 目标归属：新增纯 `EventProjectionReducer` 负责“已捕获服务端事件列表 → 可见事件投影”的过滤与单调合并。AppStore 继续唯一持有 `visibleEvents`，并负责权限/退出 tombstone、事件角色、任务、位置窗口和 UI 副作用；Reducer 不读取账号、权限、位置、任务或终态业务规则。
- 可写状态：Reducer 无持久可写状态，只返回新的 `[EmergencyEvent]`；AppStore 仍写 `visibleEvents` 和其余投影。输入包含已有投影、服务端快照及已确认的 suppressed event ID 集合。
- 接口与事务边界：Reducer 保持现有顺序，过滤 suppressed ID；相同 ID 的已有终态不得被活动快照回退；非终态快照不得覆盖更高 coordination revision；其他快照原样替换。AppStore 在得到结果后继续按现有顺序执行 pending patient、assignment、response request、位置窗口和 Presence 处理。
- 非修改范围：不改变主体权限、事件终态、接受/退出、人数、邀请、AED、位置采样时间、Socket 语义、REST JSON 或本地队列格式；不把 Reducer 宣称成完整 AppStore runtime 或新的全能协调器。
- 兼容影响：服务端快照字段和返回顺序保持；`visibleEvents` 的单调合并结果保持。旧 `applyServerSnapshot`/`replaceEvent` 接口继续作为 AppStore 内部入口，但合并规则由新 Reducer 统一提供，不能保留第二套合并逻辑。
- 验收用例：同 ID 终态对活动旧快照不回退；更高 revision 覆盖旧投影、较低 revision 被拒绝；退出 tombstone/deferred ID 被过滤；未知事件按服务端顺序加入；重复快照不复制事件；AppStore 其余恢复副作用仍执行一次。
- 回退：只回退 D7 Reducer、AppStore 接线、测试、工程接线与文档 patch；从 D6 归档逐文件比对。没有数据迁移；不得通过回退清理已确认终态、位置事实或结束意图。

### D7 实现与验证

- `ios/AEDResponse/Application/EventProjectionReducer.swift` 已接管 suppressed event 过滤、同 ID 事件合并、终态单调性和 coordination revision 保护；AppStore 的 `applyServerSnapshot` 只负责收集退出 tombstone/deferred ID 并应用返回结果，继续维护 `visibleEvents`、pending patient、assignment、response request、位置窗口和 Presence 副作用。`replaceEvent` 仍通过同一快照入口，旧合并规则未保留第二套实现。
- `D7-native-components.log` 实际 **18 Phone + 78 Watch** 组件、`D7-native-chain.log` 与 `D7-native-after-server-restart.log` 两个真实 HTTP/重启阶段通过；新增测试覆盖低 revision 不覆盖、高 revision 覆盖、终态阻止活动回退和 suppressed ID 过滤。`D7-final-unit-build.log` 为 `TEST BUILD SUCCEEDED`，`D7-final-release-build.log` 为 `BUILD SUCCEEDED`。
- D7 只迁移投影合并策略，未改变权限、业务终态、任务/人数、位置事实或存储格式；不宣称完整 AppStore runtime、真实设备或 Xcode Cloud 构建。

## D8：iPhone 响应邀请与投递回执投影迁移（实施前约束）

- 对应风险：R03（AppStore 同时维护响应邀请、回执和其他业务编排）以及 R18（VIEWED/接受门槛仍需保持原语义）；不迁移后端接受权限、人数或 assignment 真值。
- 当前职责证据（D8时点）：`AppStore.swift` 直接写入 `responseRequest`、`deliveryStatus`、`receiptMachine`，并在 `receiveResponseRequest`、`advanceReceipt`、`clearResponseRequest` 和接受/拒绝入口之间分散维护回执状态；D16 后待发送事实已迁入受保护 delivery receipt owner，AppStore 仍保留 transport 错误投影。
- 目标归属：新增 `ResponseOfferProjectionCoordinator` 作为响应邀请投影和 `DeliveryReceiptMachine` 的唯一维护者；AppStore 保留 UI 发布镜像、VIEWED/过期/患者角色门禁、后端 `respond` 调用和队列发送副作用。协调器不决定接受人数、任务分配、事件终态或权限。
- 可写状态：协调器拥有当前 `ResponseRequest`、当前投影 `DeliveryStatus` 和回执状态机；AppStore 只持有不可变 UI projection，以及独立的待发送回执传输队列。两者不能各自修改同一回执状态。
- 接口与事务边界：`receive` 捕获服务端邀请及其初始状态；`advance(to:)` 只执行已批准的状态机转换并回调一次回执意图；`clear()` 清理当前邀请投影。AppStore 在回调中追加原有 timeline 和待发送队列，仍由 REST ACK/恢复决定发送结果；接受/拒绝的 `VIEWED` 门、过期检查和后端请求保持原入口。
- 非修改范围：不改变 `SENT/DELIVERED/VIEWED/ACCEPTED/REFUSED/EXPIRED` 规则、VIEWED 门槛、接受/拒绝 API、事件/人数/assignment、通知送达定义、位置事实或登出数据策略；不把推送成功解释为用户已查看。
- 兼容影响：外部 `AppStore.responseRequest`、`deliveryStatus`、视图和 API JSON 保持兼容；旧直接写入停用，改由 coordinator 更新 `responseOfferProjection` 后触发 AppStore 的 UI 发布。离线/确定性 TestHost 仍可使用同一投影接口。
- 验收用例：同 messageId 重放不复制邀请；初始 SENT 仍按原顺序产生 DELIVERED；DELIVERED 才能 VIEWED，VIEWED 才能 ACCEPTED/REFUSED；非法状态转换不发送；错误 eventId/deliveryId 的过期消息不清当前邀请；清理后旧回执结果不能写入新邀请；真实回执传输队列仍保留原内容和重试。
- 回退：只回退 D8 coordinator、AppStore 接线、测试、工程接线和文档 patch；从 D7 归档逐文件比对。不得通过回退删除待发送回执或改变已确认的终态/位置事实。

### D8 实现与验证

- `ios/AEDResponse/Application/ResponseOfferProjectionCoordinator.swift` 已接管当前 `ResponseRequest`、`DeliveryStatus` 和 `DeliveryReceiptMachine`；`receive` 明确区分重复 messageId 与新邀请，`advance` 统一执行回执状态转换并回调投影。AppStore 只发布 `responseOfferProjection` 镜像，继续执行 VIEWED/过期/患者门禁、REST respond 和待发送回执队列。
- 接受/拒绝的在途 REST 回调现在复验连接代次、当前 messageId/eventId/deliveryId、认证状态和患者角色，旧响应不会推进新邀请或覆盖当前错误。新增 boundary 断言覆盖这一保护。
- `D8-native-components.log` 实际 **19 Phone + 78 Watch** 组件、`D8-native-chain.log` 与 `D8-native-after-server-restart.log` 两个真实 HTTP/重启阶段通过；新增测试覆盖重复 messageId、SENT→DELIVERED→VIEWED→ACCEPTED、非法转换、clear 和旧投影回调。`D8-final-unit-build.log` 为 `TEST BUILD SUCCEEDED`，`D8-final-release-build.log` 为 `BUILD SUCCEEDED`。
- D8 收口时的旧缺口已由 D16 处理：回执队列现在按服务/账号/设备 context 持久化，logout 只 reset 内存 owner；D16 尚未证明完整 AppStore runtime、真实崩溃点和 APNs/用户查看。

## D9：iPhone Assignment/任务投影迁移（实施前约束）

- 对应风险：R03（AppStore 同时维护 assignment、接受事件投影和 AED 回执）以及 R10/R18 的异步结果一致性；不迁移后端 assignment 真值、接受人数、任务分工或 AED 生命周期规则。
- 当前职责证据：`AppStore.swift` 直接写入 `assignment`、`acceptedResponseEventID`、`receiptByAssignmentID` 和 `aedReceiptMachine`；`applyAssignment`、`applyAedAcquiredReceipt`、`advanceAssignment`、`reportAssignedAedAcquired`、`reportAssignedAedUnavailable` 与 Socket assignment 回调各自触发写入。
- 目标归属：新增 `AssignmentProjectionCoordinator` 唯一维护当前 assignment、接受事件投影和 AED receipt 幂等状态；AppStore 保留患者角色/退出 tombstone 门禁、REST task 操作、timeline、位置窗口和 Presence 副作用。
- 可写状态：协调器拥有 assignment、`acceptedResponseEventID`、assignment receipt 去重表和 `AedAcquiredReceiptMachine`；AppStore 只发布不可变 UI 镜像，不再直接改这些字段。后端仍是任务和人数权威。
- 接口与事务边界：`apply` 统一 revision/终态 assignment 投影；`markAccepted` 只记录已通过后端决定或确定性测试的本地事件关联；`prepareAedReceipt` 复用稳定 receiptId；`applyAedReceipt` 执行幂等/冲突状态机；`clear`/`stop(for:)` 只清对应本地投影，不删除位置事实或待提交退出意图。
- 非修改范围：不改变接受/拒绝 API、任务状态枚举、AED 无替代规则、跨事件争用、持有 AED 退出/归还、人数上限、终态或位置采样规则；不把本地 assignment 投影视为全局任务真值。
- 兼容影响：`AppStore.assignment`、`acceptedResponseEventID` 和现有 UI 读取接口保持兼容，改为 coordinator 镜像属性；REST/Socket JSON 不变。异步 assignment/AED 结果必须在写回前复验当前 assignment 身份与连接代次，旧结果不能覆盖新 revision。
- 验收用例：低 revision assignment 不覆盖高 revision；不同 assignment ID 只能在服务端/REST确认后替换；同 receipt 重放幂等、冲突回执拒绝；clear/换事件后旧 AED/任务回调不能写入新投影；Socket assignment 只作为提示并走同一 projection 入口。
- 回退：只回退 D9 coordinator、AppStore 接线、测试、工程接线和文档 patch；从 D8 归档逐文件比对。不得通过回退删除已确认 assignment、AED receipt、位置事实或结束意图。

### D9 实现与验证

- `ios/AEDResponse/Application/AssignmentProjectionCoordinator.swift` 已成为 assignment、接受事件投影、按 assignment 的 AED receipt 身份和 `AedAcquiredReceiptMachine` 的唯一本地写入口。AppStore 仅发布 `assignmentProjection` 镜像，保留角色/退出门禁、REST task 调用、timeline、位置窗口和 Presence 副作用；旧的 `aedReceiptMachine`、`receiptByAssignmentID` 及直接 assignment 写入已停用。`project.pbxproj` 将协调器接入三个 iPhone source target，Watch 不依赖它。
- assignment 与 AED 的三个异步 REST 回调现在在认证、连接代次、event/assignment ID、revision 和原状态同时匹配后才回写。`AED_UNAVAILABLE` 在同一会话出现替代/更高 revision 时只做原事件 REST 对账；账号切换或登出后不使用旧结果启动新会话读取。Socket `assignmentTimedOut` 只保留 terminal-restore/REST 对账提示，不再先调用本地 timeout writer；不改变后端超时、重派或接受规则。
- D9 组件测试实际 **20 Phone + 78 Watch** 通过；包括 revision 门、同 assignment 稳定 receiptId、同 receipt 幂等、不同 assignment 冲突隔离、非当前 receipt 不篡改当前投影和 timeout 投影。`/tmp/aedresponse-d9-native-final-20260909` 的两个真实 HTTP/服务重启阶段通过，源清单在执行期间保持一致、fixture 已退出。
- `/tmp/aed-d9-unit-build-final-20260909.log` 与 `/tmp/aed-d9-controlled-build-final-20260909.log` 均为 `TEST BUILD SUCCEEDED`，`/tmp/aed-d9-release-build-final-20260909.log` 为 iOS+Watch `BUILD SUCCEEDED`。另以 `swiftc -parse` 逐文件检查 77 个 Swift 源/测试文件通过。
- D9 的在途 AppStore 异步交错仍以静态 guard、组件运行和 generic 构建为证据；没有将其写成完整 AppStore runtime、模拟器 XCTest、真机/Watch 后台或跨用户正式服务验收。AED 生命周期、跨事件争用、持有 AED 退出/交接和归还仍保持待决。

## D10：iPhone Presence 上传职责迁移（实施前约束）

- 对应风险：R03（AppStore 同时维护 Presence latest-state 上传和其他业务编排）以及 R15（恢复后 Presence 必须在当前会话/快照代次下发送）；不迁移事件位置事实、附近摘要查询、账号权限或后端 Presence 权威。
- 当前职责证据：`AppStore.swift` 的 `PresenceSignature`、`PresenceUpload`、`pendingPresenceUpload`、上传 task/sequence、重试和 `lastPresenceSignature` 共同维护待发送 Presence；`enqueuePresenceUpdateIfNeeded` 同时执行业务门禁和传输编排，`drainPresenceUploads` 直接写 UI 镜像并触发附近摘要。
- 目标归属：新增 `PresenceUploadCoordinator` 只负责 Presence latest-state 的稳定 update、pending/coalescing、重试、取消 generation 和 ACK signature；AppStore 保留连接/认证/恢复/角色门禁、`lastPresence` UI 镜像、错误展示及 ACK 后附近摘要副作用。
- 可写状态：协调器拥有 Presence signature、待发送 `DevicePresenceUpdate`、传输 task、重试次数和最近已确认 signature；AppStore 不再直接写这些传输状态。Presence 是可重新生成的 latest-state 投影，本批不把它冒充为不可丢失的事件事实，也不改变现有断线时清除 pending 的语义。
- 接口与事务边界：`enqueue(signature:force:sessionGeneration:)` 在 AppStore 已确认连接/权限/恢复代次后生成稳定 `presenceUpdateId`；发送前、ACK 后、失败重试前由 AppStore 提供当前 session generation 门；`reset(resetLastSignature:)` 保留现有 disconnect/terminal 的差异。服务端仍通过 `PUT /me/presence` 返回权威 `DevicePresence`。
- 非修改范围：不改变 `availableForResponse`、通知/定位 capability 字段、重试退避、Presence API JSON、附近摘要权限/分桶/TTL、事件位置队列、登出和终态规则；不引入本地 Presence 持久队列或新的后台执行假设。
- 兼容影响：AppStore 的 `lastPresence` 对外镜像和附近摘要刷新时机保持；旧 Presence 字段和 `drainPresenceUploads` 写路径停用，不能与新协调器并行写入。REST/Socket/跨端契约不变。
- 验收用例：相同 signature 抑制重复发送；`force` 重新生成稳定新 ID；在途期间新 signature 替换 pending；临时失败保留原 updateId 并退避重试；连接代次变化后旧 ACK/错误不写回；ACK 后仅在中立且可参与时刷新附近摘要；disconnect 保持已确认镜像但清除未发送 latest projection。
- 回退：只回退 D10 coordinator、AppStore 接线、测试、工程接线和文档 patch；从 D9 归档逐文件比对。没有数据库/本地队列迁移，代码回退不删除后端 Presence 事实或事件位置记录。

### D10 实现与验证

- `ios/AEDResponse/Application/PresenceUploadCoordinator.swift` 已接管 Presence signature、待发送 `DevicePresenceUpdate`、稳定 `presenceUpdateId`、重试退避和取消 generation。AppStore 只负责连接/认证/恢复门禁、`lastPresence` UI 镜像、错误展示及 ACK 后的附近摘要刷新；旧 `presenceUploadTask`、`pendingPresenceUpload`、`lastPresenceSignature` 和 `drainPresenceUploads` 写路径已停用。
- 协调器保留原语义：相同 signature 抑制重复发送，force 生成新的稳定 ID，在途时由最新 signature 替换 pending，临时错误用同一 ID 重试；连接代次失效后旧 ACK/错误不再回写。Presence 仍是可重新生成的 latest-state，不新增本地持久队列，也不把它解释为事件位置事实。
- D10 原生组件测试实际 **22 Phone + 78 Watch** 通过；新增测试覆盖 503 后同 ID 重试、相同 signature 抑制、force 新 ID、REST Presence JSON 以及 reset 后暂停请求的迟到 ACK 抑制。`/tmp/aedresponse-d10-native-final-rerun2-20260909` 的两个真实 HTTP/服务重启阶段通过，fixture 已退出。
- `/tmp/aed-d10-unit-build-final2-20260909.log` 与 `/tmp/aed-d10-controlled-build-final2-20260909.log` 均为 `TEST BUILD SUCCEEDED`，`/tmp/aed-d10-release-build-final2-20260909.log` 为 iOS+Watch `BUILD SUCCEEDED`。另以 `swiftc -parse` 逐文件检查 78 个 Swift 源/测试文件通过。
- D10 仍不覆盖附近摘要查询的完整恢复交错、事件位置调度、模拟器 XCTest 宿主执行、真实设备/Watch 后台或 APNs；这些保持后续工作包，不改变任何人数、权限、终态和 AED 待决规则。

## D11：iPhone 附近志愿者摘要查询迁移（实施前约束）

- 对应风险：R03/R15（AppStore 同时维护聚合查询、请求代次和业务门禁）；不迁移后端附近人数权威、位置坐标、招募半径、事件任务或响应者身份。
- 当前职责证据：`AppStore.swift` 的 `nearbyVolunteerRequestGeneration`、`clearNearbyVolunteerSummary` 和 `refreshNearbyVolunteers` 同时负责清理 UI、发起 REST、取消旧请求、角色/任务门禁和摘要新鲜度检查。
- 目标归属：新增 `NearbyVolunteerSummaryCoordinator` 维护查询 task、请求 generation、旧结果抑制和 `NearbyVolunteerSummary.isCurrent` 检查；AppStore 保留业务门禁、离线预览分支、`nearbyVolunteerSummary` UI 镜像和 ACK/Presence 触发时机。
- 可写状态：协调器拥有请求 generation、查询 task 和结果回调；AppStore 唯一发布摘要 UI，不复制第二份摘要或坐标。服务端仍是聚合人数和半径结果的权威。
- 接口与事务边界：`clear()` 取消在途查询并使旧回调失效；`refresh(sessionGeneration:)` 只接受 AppStore 已确认的中立/无任务/无待处理邀请状态，并在返回时复验 session、权限、角色、任务、邀请及摘要时间窗口。
- 非修改范围：不改变 1/1.5/2 公里分桶、累计人数、120 秒新鲜度、错误时显示不可用、权限规则、Presence 上传、事件位置或招募业务规则；不把摘要查询成功解释为已收到具体志愿者位置。
- 兼容影响：`AppStore.nearbyVolunteerSummary` 和现有 REST `/me/nearby-volunteers` 契约保持；旧 `nearbyVolunteerRequestGeneration` 与直接 task 写路径停用，不能与新协调器并行更新同一摘要。
- 验收用例：重复刷新只保留最新 generation；清理/角色切换后旧响应不能回写；有效摘要通过固定字段和新鲜度校验；过期/无效摘要被丢弃；离线预览仍只生成明确标记的本地示例；无权限或已有 assignment/response request 时不发送查询。
- 回退：只回退 D11 coordinator、AppStore 接线、测试、工程接线和文档 patch；从 D10 归档逐文件比对。没有数据库、队列或业务事实迁移。

### D11 实现与验证

- `ios/AEDResponse/Application/NearbyVolunteerSummaryCoordinator.swift` 已接管附近摘要查询 task、请求 generation、取消、旧结果抑制和 `NearbyVolunteerSummary.isCurrent` 检查。AppStore 保留业务门禁、离线预览、`nearbyVolunteerSummary` UI 镜像和 ACK/Presence 触发时机；旧 `nearbyVolunteerRequestGeneration` 与直接 REST 查询路径已停用。
- `refreshNearbyVolunteers()` 保留原来的可等待完成语义：协调器拥有独立 task，但 AppStore 会等待该 task 完成；调用者取消只取消捕获的旧 task，并通过 generation 防止清掉新查询。真正发 HTTP 前和返回后均复验 session、权限、角色、assignment、response request 和摘要新鲜度。
- D11 原生组件测试实际 **23 Phone + 78 Watch** 通过；新增测试覆盖清理后挂起 HTTP 的旧响应抑制、随后有效摘要接受以及 refresh 在 HTTP 返回前不会提前完成。`/tmp/aedresponse-d11-native-final-rerun2-20260909` 的两个真实 HTTP/服务重启阶段通过，fixture 已退出。
- `/tmp/aed-d11-unit-build-final2-20260909.log` 与 `/tmp/aed-d11-controlled-build-final2-20260909.log` 均为 `TEST BUILD SUCCEEDED`，`/tmp/aed-d11-release-build-final2-20260909.log` 为 iOS+Watch `BUILD SUCCEEDED`。另以 `swiftc -parse` 逐文件检查 79 个 Swift 源/测试文件通过。
- D11 不覆盖事件位置调度、具体志愿者身份、完整 AppStore/UI runtime、模拟器 XCTest 宿主、真实设备/Watch 后台或 APNs；后端测试本批未修改后端源码，未重复完整后端套件。

## D12：iPhone 事件位置 UTC slot scheduler 迁移（实施前约束）

- 对应风险：R03/R12/R15（AppStore 同时维护事件位置事实、持久化、封口、恢复和周期调度）；本批只迁周期 slot scheduler，不迁移事件位置事实权威、队列格式、封口、恢复分类或批上传。
- 当前职责证据：`AppStore.swift` 的 `eventPositionSchedulerTask` 在 `startEventPositionCaptureIfReady` 中直接计算 UTC slot、等待、catch-up、context 检查和 `captureEventPositionSlot` 调用；停止、终态暂停、登出和清理入口分别直接取消该 task。
- 目标归属：新增 `EventPositionSchedulerCoordinator` 唯一维护 scheduler task、context/generation lease、UTC 等待和 catch-up；AppStore 保留 `eventPositionContext`、slot candidate、持久 draft、`FIX/NO_NEW_FIX`、封口、恢复窗口和 REST 批上传。
- 可写状态：协调器只写 task、active context 和 scheduler generation；它不能创建/修改 slot 记录、更新时间戳、删除队列、改变参与窗口或决定是否上传。
- 接口与事务边界：`start(context:)` 接收已由 AppStore 建立的 context、generation、开始时间和最后封口 slot；每次等待后、每个 catch-up slot 前复验 context lease，再回调 AppStore 的 `captureEventPositionSlot(at:)`；`stop()` 只取消调度，不触碰事实队列。
- 非修改范围：不改变 UTC 整秒规则、实际 `observedAt`、5 秒批窗口、APP_NOT_RUNNING 恢复分类、终态/退出门禁、后端 ACK/重试、位置权限或后台执行能力；TestHost 仍使用显式 `captureEventPositionSlot`，不依赖墙上时钟。
- 兼容影响：事件位置 JSON、持久化结构和 AppStore 对外测试入口保持；旧 `eventPositionSchedulerTask` 停用，不能与新 scheduler 并行运行。生产 OS 挂起/后台频率仍不能由本协调器推断。
- 验收用例：从开始时间和最后封口 slot 计算下一 UTC slot；catch-up 逐秒且让出 MainActor；context/generation 变化后停止；重复 start 不产生两个 scheduler；stop/终态/登出不删除未确认事实。
- 回退：只回退 D12 coordinator、AppStore 接线、测试、工程接线和文档 patch；从 D11 归档逐文件比对。不得回退删除已持久化事件位置批次或改变队列事实。

### D12 实现与验证

- `ios/AEDResponse/Application/EventPositionSchedulerCoordinator.swift` 已接管周期等待、UTC slot catch-up、context/generation lease 和停止；AppStore 的 `captureEventPositionSlot(at:)`、draft/queue 持久化、恢复分类、封口与 `sendEventPositionBatch` 仍是唯一业务事实入口。TestHost 分支不启动 wall-clock scheduler，继续使用显式 slot 测试入口。
- 新增 scheduler 回归实际验证从开始时间和最后封口 slot 计算下一 UTC slot；catch-up 逐秒且让出 MainActor；context/generation 变化后 scheduler 自行停止；stop/终态/登出不删除未确认事实。
- D12 原生组件实际 **24 Phone + 78 Watch**，两个真实 HTTP/服务重启阶段通过，最终 source manifest 与当前 coordinator SHA 一致；fixture 已退出。
- `/tmp/aed-d12-unit-build-final3-20260909.log` 与 `/tmp/aed-d12-controlled-build-final3-20260909.log` 均为 `TEST BUILD SUCCEEDED`，`/tmp/aed-d12-release-build-final3-20260909.log` 为 iOS+Watch `BUILD SUCCEEDED`。另以 `swiftc -parse` 逐文件检查 80 个 Swift 源/测试文件通过。
- D12 只证明 scheduler 组件和静态接线；事件位置恢复/批上传完整交错、OS 后台执行频率、完整 AppStore/UI runtime、真机/Watch 和容量仍未验证。

## D13：iPhone 事件位置恢复 grace scheduler 迁移（实施前约束）

- 对应风险：R03/R12/R15（AppStore 同时维护进程重启后的恢复等待、恢复循环和事件位置事实）；本批只迁恢复 grace scheduler，不迁移恢复窗口判定、`APP_NOT_RUNNING` 记录、持久化或封口。
- 当前职责证据：`AppStore.swift` 的 `eventPositionRecoveryTask`、`scheduleEventPositionRecoveryIfNeeded` 和 `completeRecoveredEventPositionSlots` 同时维护 5 秒等待、context 检查、恢复循环和状态推进。
- 目标归属：新增 `EventPositionRecoverySchedulerCoordinator` 唯一维护 grace task、context/generation lease、循环调度和停止；AppStore 保留 `eventPositionRecoveryPending`、cutoff、slot draft、恢复分类、持久化、封口和批上传。
- 可写状态：协调器只写 task、active context 和 scheduler generation；它不能创建恢复 slot、修改 gap reason、删除队列或跳过后端窗口。
- 接口与事务边界：`start(context:)` 只在 AppStore 已建立恢复 context 后启动 5 秒等待；每轮调用 AppStore 的恢复推进入口，并在 context/generation 失效或 pending 清空后停止；`stop()` 只取消调度。
- 非修改范围：不改变 5 秒 grace、`APP_NOT_RUNNING` 语义、事件位置时间窗、真实 fix 时间、批大小、ACK/重试、权限和 OS 后台能力；TestHost 的 controlled recovery 入口保持。
- 兼容影响：事件位置 JSON、持久化结构和恢复测试入口保持；旧 `eventPositionRecoveryTask` 写路径停用，不能和新 scheduler 并行运行。
- 验收用例：5 秒等待后按 context 推进恢复；pending 清空后自然停止；context 变化、终态暂停、登出和 stop 后不再推进；恢复推进失败不删除原 draft；同一 context 不重复启动多个 task。
- 回退：只回退 D13 coordinator、AppStore 接线、测试、工程接线和文档 patch；从 D12 归档逐文件比对，不删除未确认事件位置事实。

### D13 实现与验证

- `ios/AEDResponse/Application/EventPositionRecoverySchedulerCoordinator.swift` 已接管事件位置恢复 grace task、5 秒等待、context/generation lease、恢复循环和停止；AppStore 的 `completeRecoveredEventPositionSlots` 仍唯一修改恢复窗口、APP_NOT_RUNNING slot、持久化 draft、封口和批上传状态。
- 旧 `eventPositionRecoveryTask` 写路径已停用；终态/登出/清理入口通过 coordinator stop，TestHost 的 controlled recovery 入口仍直接调用 AppStore 的恢复推进函数。恢复 scheduler 不删除失败 draft、不改变 gap reason，也不推断后台执行能力。
- D13 原生组件实际 **25 Phone + 78 Watch**，两个真实 HTTP/服务重启阶段通过，最终 source manifest 与当前 recovery coordinator SHA 一致；新增测试精确断言等待时长为 5 秒、grace 完成前推进次数为 0、随后循环推进三次并在 pending 清空后自动停止。
- `/tmp/aed-d13-unit-build-final2-20260909.log` 与 `/tmp/aed-d13-controlled-build-final2-20260909.log` 均为 `TEST BUILD SUCCEEDED`，`/tmp/aed-d13-release-build-final2-20260909.log` 为 iOS+Watch `BUILD SUCCEEDED`。`/tmp/aedresponse-d13-native-final-rerun3-20260909` 的 runner 输出为 `/tmp/aedresponse-d13-runner-output-final3-20260909.log`；另以 `swiftc -parse` 逐文件检查 81 个 Swift 源/测试文件通过。
- D13 只证明恢复 scheduler 组件和静态接线；恢复/批上传完整交错、持久化失败现场、OS 后台执行频率、完整 AppStore/UI runtime、真机/Watch 和容量仍未验证。

## D14：iPhone 事件位置批上传 single-flight 迁移（实施前约束）

- 对应风险：R03/R12/R15（AppStore 同时维护批上传 task、在途标识、退避计数、传输回调和事件位置队列）；本批只迁移批上传 transport single-flight 与稳定重试调度，不迁移事件位置记录、批次封口、队列持久化、退出窗口重写或后端规则。
- 当前职责证据：`AppStore.swift` 的 `eventPositionBatchUploadTask`、`eventPositionInflightBatchID`、`eventPositionRetryAttempt`、`scheduleEventPositionRetry` 与 `drainEventPositionBatchesIfPossible` 共同维护在途 REST 请求和退避；ACK、永久拒绝隔离和队列保存仍在同一方法内。
- 目标边界：新增 `EventPositionBatchUploadCoordinator` 只拥有一条批上传/退避 task、immutable batch 的发送、连接/账号/设备代次 lease 复验和结束回调；AppStore 保留选择哪个已持久化 batch、业务门禁、退出窗口 reconciliation、ACK 后删除、永久拒绝隔离和错误投影。
- 非修改范围：不改变 `batchId`/`recordId` 幂等、ACK 验证、403/409/413/422 隔离语义、1/2/4/8/16/30 秒退避上限、队列 JSON、5 秒封口、真实 `observedAt`、终态/退出门禁、权限和 OS 后台能力；不清空合法历史队列。
- 兼容影响：旧 AppStore task/退避字段停用，只有新 coordinator 可以发起该 REST 批上传；API endpoint、body、错误语义和 TestHost controlled 入口保持。迁移期间不得保留两条上传写路径。
- 前置决策：无需未决业务规则；同标识不同正文、响应丢失、账号/连接代次变化和持久化失败按现有规则处理。生产容量、真实 APNs/后台和真机仍不属于本批。
- 验收用例：重复 drain 只保留一个 task；响应 ACK 丢失后用同一 immutable batch 重试；临时错误按原退避；永久错误隔离并保留正文；ACK/错误晚于 reset、账号切换或连接代次变化不能回写；stop/reset 不删除队列；重试期间新 drain 不产生第二个请求。
- 回退：只回退 D14 coordinator、AppStore 接线、测试、工程接线、runner 和文档 patch；从 D13 归档逐文件比对。代码回退不删除已持久化 batch，不以旧 AppStore 写路径覆盖队列。

### D14 实现与验证

- `ios/AEDResponse/Application/EventPositionBatchUploadCoordinator.swift` 已接管已封口批次的 REST single-flight task、immutable batch 发送、1/2/4/8/16/30 秒退避、连接/账号/设备代次复验和 reset；AppStore 继续选择 pending batch，维护退出窗口重写、ACK 后队列持久化删除、永久拒绝隔离与错误投影。
- AppStore 中旧 `eventPositionBatchUploadTask`、`eventPositionInflightBatchID`、`eventPositionRetryAttempt` 和 `scheduleEventPositionRetry` 写路径已停用；只有新 coordinator 可以发起事件位置批上传。队列、batchId/recordId、ACK 验证和 403/409/413/422 语义未改变。
- 新增组件回归验证重复 `start` 不并行发请求、503 后复用同一 batch 和 1 秒起步退避、reset 后挂起请求的迟到 ACK/错误不回写；边界测试确认 AppStore 不再声明旧 task 状态。D14 原生组件实际 **27 Phone + 78 Watch**，两个真实 HTTP/服务重启阶段通过，fixture 已退出。
- `/tmp/aed-d14-unit-build-final2-20260910.log` 与 `/tmp/aed-d14-controlled-build-final2-20260910.log` 均为 `TEST BUILD SUCCEEDED`，`/tmp/aed-d14-release-build-final2-20260910.log` 为 `BUILD SUCCEEDED`。`/tmp/aedresponse-d14-native-rerun3-20260909` 的 runner 输出为 `/tmp/aedresponse-d14-runner-output-rerun3-20260909.log`；另以 `swiftc -parse` 逐文件检查 82 个 Swift 源/测试文件通过。
- D14 只证明批上传 coordinator 的组件行为和静态接线；恢复/批上传完整交错、持久化失败现场、历史规模、OS 后台执行频率、完整 AppStore/UI runtime、真机/Watch 和生产容量仍未验证。

## 后续四类工作包状态（2026-09-10）

用户要求继续处理的四类事项都属于整改范围，但不能合并成一个“已完成”结论：

| 类别 | 类型 | 当前可执行部分 | 当前阻塞/边界 |
| --- | --- | --- | --- |
| 正式身份、App Attest、APNs、Xcode Cloud | V 外部能力/配置 | 可先维护 provider、失败闭合、受众授权、workflow 前置检查和契约测试 | 真实 SMS/Apple verifier、App Attest key/profile、APNs topic/key、App Store Connect/Xcode Cloud 连接未配置；不触发真实通知或云端发布 |
| 路线服务、OS 后台、真机/Watch | V 外部能力/运行时 | 可先保持 route adapter、后台恢复状态、超时分类和测试入口的 fail-closed 边界 | 高德/路线凭据、系统后台频率、物理 iPhone/Watch 与 capability 证据缺失；不把 Mac/Simulator/generic build 当真机结果 |
| 存储性能、历史增长、目标负载 | S/V 本地结构与验证 | E-STORAGE-01 已修复无变化写放大；E-STORAGE-02 已测量实体读、历史/队列增长、重启和 8 个串行事务 | 不更换数据库、不做生产迁移、不声称当前基准是目标容量验收 |
| AED 生命周期、跨事件争用、失联补位、活动登出 | D 业务待决 | 只能整理选项、影响、决策门和不变量，继续保护当前权威/撤权边界 | 未确认产品规则；不能自行决定归还、替代、关闭、补位或 logout 后事件语义 |

## 业务影响优先级调整（2026-09-10）

用户要求把会改变业务结果或恢复能力的项目置于辅助自动化之前。本排序不把尚未确认的产品规则伪装成实现，也不把外部能力的申请等同于通过：

1. **P0 后端用例权威边界**：沿接受、退出、任务/assignment 和非终态通知逐条迁移具体入口；保持原主体权限、终态原因、错误语义和同一事务提交，不让兼容入口形成第二写入权威。每条路径先覆盖重复请求、同标识不同内容、并发接受/结束、撤销会话和响应丢失。
2. **P0 跨进程事实恢复**：先做 D16 回执队列持久化，再验证进程退出/重启、登出换号、发送成功后本地崩溃和服务恢复。回执必须绑定服务、账号、设备和 delivery；未确认记录不得因 logout、409 或终态被静默清空。
3. **P0 路线服务边界**：后端继续是路线和任务真相；客户端只消费已授权快照。先建立 provider/超时/错误分类和旧路线版本门，外部路线凭据到位后再做真实路线验证；没有路线结果时 fail-closed，不用客户端估算覆盖服务端任务。
4. **P0 Watch/OS 后台恢复**：补充 `CMFallDetectionManager` 启动、短时后台执行、completion 时限、不可达切换和恢复状态的可观测证据；进程内 5 秒 timer 不能被写成系统后台保证。架构链完成后再用物理 iPhone/Watch 验证。
5. **P1 业务决策门**：无人回答关闭、重复跌倒仲裁、人数/邀请查看、失联补位、AED 无替代、持有 AED 退出/交接归还、活动 logout/权限下降以及手机可达但后端无有效 P 的策略，只整理选项、影响、不变量和验收场景，等待明确选择后才改代码。
6. **P1 存储与目标负载**：在上述恢复链稳定后，再处理全状态加载/写事务和历史增长；现有 E-STORAGE-01/02 只提供写放大修复和合成成本证据。
7. **P2 外部能力验证**：正式身份、App Attest、APNs、真实路线凭据和真机 capability 分开验证。Apple Developer Program 已获批，但 provider、profile、设备和送达证据仍需实际配置。
8. **暂缓 XCLOUD-01**：Xcode Cloud 仅作为自动化调试辅助评估，不进入当前整改主线；不创建 workflow、不触发云构建、不写入 App Store Connect。

该排序启动时首个批次为 **P0-D16：回执队列持久化与跨进程恢复**；D16、P0-RECOVERY-01、P0-USECASE-RESPOND-01、P0-USECASE-EXIT-01、P0-USECASE-ASSIGNMENT-01、P0-NOTIFY-DECISION-01、P0-NOTIFY-ASSIGNMENT-01、P0-NOTIFY-REPLAN-01、P0-NOTIFY-EXIT-REPLAN-01、P0-NOTIFY-ROUTE-01、P0-NOTIFY-AED-REPLACEMENT-01、P0-ROUTE-BOUNDARY-01、P0-STATUS-USECASE-01、P0-WATCH-ADMISSION-01、P0-APPSTORE-RECEIPT-01 和 E-STORAGE-03 已完成本地源码整改与复审。当前继续起点是 AppStore 事件位置事实/封口的进一步迁移，以及真实路线、OS 后台和目标容量证据；业务规则待决项不阻塞可独立结构批次，但不能用模拟器/本地 runner 代替真机或 Watch 证据。

### P0-D16 实施前约束

- 对应风险：R03/R05/R18；当前 `AppStore` 同时保存回执数组、上传 task、退避计数，并在 `clearBusinessState` 中清空未确认回执。该批只迁 delivery receipt 队列的事实与 I/O owner，不改变 `DELIVERED`/`VIEWED` 状态机、接受/拒绝门槛、后端权限或发送错误语义。
- 目标边界：新增受保护 `DeliveryReceiptQueuePersistenceCoordinator`，唯一维护待发送回执队列的 load/append/ACK 删除和持久化失败门；AppStore 只提供当前认证 context、UI 错误和 transport 回调，不再拥有独立数组。
- 跨账号约束：每条记录绑定 canonical service namespace、user、device 和 event/delivery；登出只重置内存 owner，不删除磁盘事实。重新登录仅恢复同 context 记录，其他账号记录继续隔离保留。
- 验收用例：同一 delivery 的 DELIVERED→VIEWED 顺序、进程重启后队列恢复、ACK 只删除精确记录、发送成功而本地删除失败时保留原记录、损坏文件 fail-closed 且原字节不覆盖、logout 不清磁盘、不同账号不能互取回执。
- 非修改范围：不迁移后端 receipt endpoint、不改变回执有效期/受众授权、不把发送成功解释为用户查看、不顺便修改 AED 或事件终态规则。
- 回退：只回退 D16 coordinator、AppStore 接线、Environment 注入、工程接线、测试和文档；不删除已产生的受保护回执文件，回退代码必须继续能读取 D16 文件格式。

## Apple Fall Detection entitlement 申请预检（2026-09-10）

- Apple 官方要求 `CMFallDetectionManager` 使用 Apple 授予的 entitlement；当前项目申请目标为 Watch App ID `dev.codex.aedresponse.watchkitapp`，key 为 `com.apple.developer.health.fall-detection`。
- 源码预检已通过：`ios/AEDResponseWatch/AEDResponseWatch.entitlements` 和 `ios/project.yml` 已声明 entitlement；`ios/AEDResponseWatch/Info.plist` 已声明 `NSFallDetectionUsageDescription`；`CoreMotionFallDetectionMonitor` 在 `applicationDidFinishLaunching` 路径中创建单一 manager、设置 delegate，并单独请求用户授权。
- **状态（2026-09-13 更正）**：申请已于 **2026-09-11** 通过 Apple 官方表单提交，**等待审核、尚未获批**。此前本文“待提交申请”的写法已过期：提交动作确实发生过（`docs/apple-fall-detection-entitlement-request-2026-09-10.md` 与提交 `64c4759`），但仓库里没有申请编号、提交时间或 Apple 回复原文，故只能记“已提交未获批”。本地 entitlement 文件、generic build 或 Xcode 里能看到该 capability，都不代表 Apple 已批准或 profile 已包含该 key。
- **为什么开发者网站上找不到**：Fall Detection 不在 Certificates, Identifiers & Profiles 的 Identifiers 可勾选能力列表里，Xcode 的 Signing & Capabilities 里也没有对应开关；唯一入口是专用表单 <https://developer.apple.com/contact/request/fall-detection-api/>，提交后网站不生成任何可查记录。2026-09-13 16:03 复核本机 Watch development profile（2026-09-11 11:03 下载）的 entitlement 仍只有 `application-identifier`、`devicecheck.appattest-environment`、`team-identifier`、`get-task-allow`、`keychain-access-groups`，不含 `health.fall-detection`。
- `DEVELOPMENT_TEAM = [TEAM]` 已写入 `ios/project.yml` 的项目级签名设置并同步到 Xcode project；`xcodebuild -showBuildSettings` 已在 iOS、Watch 和 ControlledTests 三个 scheme 回读该 Team。`-allowProvisioningUpdates` 已生成/下载两个主 bundle ID 的本地 development profile，但 Watch profile 明确拒绝 Fall Detection capability，且当前 Watch profile 不包含 `com.apple.developer.devicecheck.appattest-environment`；这两个 entitlement 仍分别等待 Apple capability/配置处理，不能把 Team 配置误写成能力批准。
- 回退：申请准备文档和本地说明可独立删除；不删除现有 adapter、Info.plist 或 entitlement 声明，不修改业务终态和 Watch fallback 规则。

## SIGNING-TEAM-01：Development Team 与自动 profile 配置（2026-09-10）

- 处理类型：V 外部能力配置；范围仅为把本机已核实的 Apple Team 绑定到工程的项目级 `DEVELOPMENT_TEAM`，不修改业务代码、entitlement 内容或生产数据。
- 源码证据：本机 `Apple Development` 证书有效；Xcode 本地 development profile 的 `TeamIdentifier` 为 `GR6YBCDW7R`。`xcodebuild -showBuildSettings` 已在 `AEDResponse`、`AEDResponseWatch` 和 `AEDResponseControlledTests` 三个 scheme 回读同一 Team。
- 结果：`xcodebuild -allowProvisioningUpdates` 已为 `dev.codex.aedresponse` 和 `dev.codex.aedresponse.watchkitapp` 生成/下载本机 profile。签名构建继续被 Apple 能力边界阻止：Watch profile 不含 `com.apple.developer.health.fall-detection`，且不含当前 Watch AppAttest entitlement；这是能力审批/配置问题，不是 Team ID 问题。
- 未做事项：未删除任何受限 entitlement、未创建伪 profile、未上传证书/密钥。本行原写“未提交 Apple 申请”已过期——申请于 2026-09-11 提交（见上一节 2026-09-13 更正）；Fall Detection 申请口径仍以 `docs/apple-fall-detection-entitlement-request-2026-09-10.md` 为准。
- 验证：`/tmp/aed-signing-retry-20260910.log` 已确认 Team 缺失错误消失；`/tmp/aed-signing-auto-20260910.log` 已确认错误收敛为 Fall Detection 审批和 Watch AppAttest entitlement。三类 scheme 的 `showBuildSettings` 均回读 `DEVELOPMENT_TEAM = [TEAM]`。
- 回退：只移除 `ios/project.yml` 和 Xcode project 的 Team 设置即可；本机 profile 由 Xcode 管理，不作为代码回退对象。

### D16 实现与验证

- 新增 `ios/AEDResponse/Services/DeliveryReceiptPersistence.swift` 和 `ios/AEDResponse/Application/DeliveryReceiptQueuePersistenceCoordinator.swift`。新 owner 负责受保护 JSON 队列的 load/append/精确 ACK 删除、服务/账号/设备 context 隔离、损坏文件保留和 blocked 生命周期；AppStore 不再声明 `pendingDeliveryReceipts` 数组，仍负责当前认证 context、错误显示和既有 transport 退避。
- `logout`/`clearBusinessState` 只 reset 内存 owner，不删除 delivery receipt 文件；重新认证后从同一 store 恢复所有记录，但发送只筛选当前 canonical service/user/device context。同一 delivery 的 DELIVERED→VIEWED 保持有序，服务器已接受而本地 ACK 删除失败时原记录保留以便幂等重试。
- 新增回归：两次 coordinator 实例重启恢复、精确 ACK 只移除一条、账号隔离、损坏文件原字节保留、持久化 ACK 失败后原记录留在 store；边界测试确认 AppStore 不再拥有独立 receipt 数组。最终 runner `/tmp/aedresponse-d16-final-runner-20260910.log` 为 **32 Phone + 78 Watch + 2 个真实 HTTP/服务重启阶段**，0 失败。
- 构建：`/tmp/aed-d16-unit-build-20260910.log`、`/tmp/aed-d16-controlled-build-20260910.log` 均为 `TEST BUILD SUCCEEDED`；Watch Release unsigned generic build `/tmp/aed-d16-watch-release-build-20260910.log` 为 `BUILD SUCCEEDED`。带生产 scheme 的 Release 签名构建 `/tmp/aed-d16-release-build-20260910.log` 因两个 target 未配置 Development Team 被 Xcode 拒绝；未猜测 Team ID，不能把它写成正式签名通过。
- D16 仍不证明完整 AppStore runtime、实际进程崩溃点恢复、APNs/用户查看、OS 后台、真机/Watch 或生产容量；持久化 I/O 本身失败时会进入 blocked 并显示错误，后续需单独定义人工/会话恢复入口。
- 回退：只回退 D16 新文件、AppEnvironment 注入、AppStore 接线、工程/测试和文档；不删除已经写入的 delivery receipt 文件，不回退 D15 位置队列事实。

### E-STORAGE-01：无变化事务写放大边界

- `MemoryStateStore`、`JsonFileStateStore` 和 `SQLiteStateStore` 在完成 clone/validate/append-only 校验后，如果状态没有变化，不再发布新状态或执行 JSON/SQLite 持久化；SQLite `persistChanges` 也不再无条件推进 `state_metadata.revision`。
- 真实状态变化仍按原顺序校验、持久化和更新内存；没有修改 SQLite schema、collection、迁移格式、append-only 规则或任何业务状态语义。
- 新增 `backend/test/store.test.ts` 回归：无变化事务保持 revision，真实 timeline 变化只推进一次，后续无变化事务不再推进。
- `npm test` **162/162**、`npm run check`、`npm run build` 通过；`npx tsx test/architecture-repair-native/state-cost.mts` 的 0/1k/10k/50k 合成历史结果保存在 `/tmp/aed-storage-capacity-baseline-20260910.log`。该探针仍显示 clone/validate 与全状态启动成本，不能称容量整改完成。
- 回退：仅回退 E-STORAGE-01 的 `store.ts`、`store.test.ts` 和本台账记录；不删除数据库、不恢复旧库、不改变已有持久化事实。

### E-STORAGE-02：历史增长与受控串行事务基准

- 新增 `backend/test/architecture-repair-native/storage-load.mts` 和 `npm run architecture:storage-load`，在隔离临时 SQLite 中同时生成 timeline 历史、notification outbox backlog 和 event-position batch backlog。
- 探针覆盖 0/1,000/10,000/50,000 条历史，分别测量 full read、实体 read、no-op transaction、一次真实 append、8 个并发提交的串行化成本、文件大小、冷启动/重启，并在重启后核对三类计数和事务结果未丢失。
- 本机一次实测（macOS arm64，Node 24.18.0）：50,000 历史 + 500 通知 + 500 位置批次时，full read 约 64.43ms、实体 read 约 37.58ms、重启约 168.16ms、8 个串行事务约 1,057.55ms，SQLite 文件约 9.82MB；结果日志为 `/tmp/aed-storage-load-probe-20260910.log`。
- `npm test` **162/162**、`npm run check`、`npm run build` 和 `npm run architecture:storage-load` 通过；所有计数在 SQLite 重启后保持。结果是受控合成基准，不代表 P20、生产并发、队列积压上限或服务恢复 SLA。
- 回退：删除探针、package script、测试文档和本批证据即可；不涉及 schema、生产数据库或历史数据回退。

## E-POSITION-INTERLEAVE-01：恢复 grace 与批上传交错验证

- 对应风险：R03/R12/R15；本批只验证已经迁出的 `EventPositionRecoverySchedulerCoordinator`、`EventPositionBatchUploadCoordinator` 与受保护事件位置队列在交错时的边界，不改变业务窗口、批次封口、ACK 语义或队列格式。
- 场景：原批次 REST 请求被挂起时，恢复 grace 到期并追加第二个 pending batch；原批次 ACK 后只移除原批次，恢复批次仍保留，原请求 body 和 batchId 不被改写。
- 测试使用真实 `APIClient`、`ProtectedEventPositionQueueStore`、两个实际 Swift coordinator 和受控 HTTP transport；不是只调用复制的业务实现。完整 AppStore runtime、Core Location、OS 后台和真机仍不在本批范围。
- 验证：`/tmp/aedresponse-position-interleave-runner-20260910.log` 实际 **28 Phone + 78 Watch + 2 个真实 HTTP/服务重启阶段**，0 失败；Unit、ControlledTests、Release generic build 均通过；82 个 Swift 文件 parse 通过。独立复审需在本批收口前完成。
- 回退：只回退交错测试、runner 证据和本台账记录；不删除受保护队列、不回退 D13/D14 coordinator 或任何持久化事实。

## 新目标：六项业务关键整改后的电脑端小规模试验（2026-09-10）

- 目标：完成当前六项会改变救援结果或恢复能力的整改后，先执行受控小规模试验；存储容量、历史增长、通知/位置队列积压和目标负载由电脑通过 HTTP 向测试服务器发送合成数据验证，不触碰生产数据库、不触发真实求助、不发送真实通知。
- 六项整改范围：后端接受/退出/任务用例的唯一事务入口；跨进程事实与未确认队列恢复；后端路线 provider 的权威边界和失败闭合；Watch/OS 后台恢复与有效位置判定；会话撤销/查询字段/实时消息权限；业务变更后的可靠通知发件箱与重试授权。
- 非范围：不在小规模试验中决定无人回答关闭、重复跌倒仲裁、人数/邀请查看、失联补位、AED 交接归还或活动 logout 等待决策规则；不把合成数据结果写成真实 Watch、APNs、Fall Detection 或生产负载证据。
- 试验门槛：后端业务与恢复测试通过；iOS/Watch 代码测试通过；六项整改各自有失败场景和回退记录；测试服务器使用隔离数据库和受控账号。任何一项关键用例失败都不能进入试验。
- 当前可复现基线：`backend/npm test` **178/178**、`npm run test:business` **116/116**、`npm run check`、`npm run build`、`npm run architecture:storage-load` 和 `git diff --check` 通过；既有存储探针重启后保留历史、通知和位置批次计数。该探针仍是隔离合成基准，尚不是服务器端目标容量验收。
- 本轮真机 XCTest 暴露并修正 `WatchPersistence.swift` 的 Keychain 更新缺陷：`SecItemUpdate` 只更新 `kSecValueData`，`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` 仅在首次 `SecItemAdd` 时设置。修复后物理 iPhone 全套 `AEDResponseUnitTests` 为 **309 执行、0 失败、29 跳过**；修复前 9 项失败均集中在 Keychain 持久化，证据分别为 `/tmp/aedresponse-ios-device-tests-20260910.log` 和 `/tmp/aedresponse-ios-device-tests-fix-20260910.log`。
- P2 延后：正式身份/App Attest/APNs/真实路线/物理 Watch capability 等外部能力，以及 Xcode Cloud，等 App 通过当前基础测试后再进入；但如果发布范围包含 Watch 后台救援或关闭应用通知，这些 P2 在正式发布验收时必须重新提升为发布门槛。
- 回退：代码回退只涉及本次 Keychain 更新策略和相关测试证据，不删除已有受保护队列；试验数据使用临时隔离库，数据回退直接删除临时库，不对生产库执行迁移或恢复。

## P0-RECOVERY-01：delivery receipt 持久化失败恢复入口（2026-09-10）

- 对应风险：D16 留下的 R03/R05/R12；本批处理本地安全队列读写失败后的恢复入口，不改变回执状态机、服务器接口、受众权限或发送错误语义。
- 修改范围：`DeliveryReceiptQueuePersistenceCoordinator` 增加受保护队列 `recover()`；合法回执在存储暂时不可用或保存失败时进入仅内存的 blocked 保留区，仍不出现在可发送队列中；重新登录或重新建立连接时先重新读取持久化文件，再以稳定 key 合并并成功落盘后恢复发送。`AppStore` 在连接成功后调用同一恢复入口，再启动回执 drain。
- 非修改范围：不把内存保留区当作已持久化事实；不删除损坏文件；不改变 logout 的磁盘保留语义；不处理 APNs、Watch、路线或后端用例。
- 先行回归：新增 `testBlockedAppendIsRetainedUntilTheQueueCanBeRecovered`，覆盖保存失败、阻止发送、存储恢复、合并落盘和恢复发送前的顺序。现有 ACK 保存失败测试仍要求原持久化记录保持。
- 验证：`xcodebuild ... -destination generic/platform=iOS ... build-for-testing` **通过**（`/tmp/aedresponse-p0-recovery-build-20260910.log`）；物理 iPhone 定向测试因设备在执行前掉线而未运行，Xcode 错误为 destination 不可用（`/tmp/aedresponse-p0-recovery-device-20260910.log`）；Mac Designed-for-iPhone 运行被 provisioning profile 不包含 Mac 设备阻塞（`/tmp/aedresponse-p0-recovery-mac-20260910.log`）。未把这些环境阻塞写成代码断言失败。
- 回退：仅回退本批 coordinator、AppStore 恢复调用、边界测试和台账；不删除已有 delivery receipt 文件，不执行数据库或生产数据回退。恢复后仍可读取 D16 文件格式。
- 当前状态：代码整改完成，通用编译证据通过；真机/运行时回归待设备恢复后补测。下一项继续后端接受/退出/任务用例边界，保持本批不与旧路径并行写入。

## P0-USECASE-RESPOND-01：响应接受/拒绝事务用例边界（2026-09-10）

- 对应风险：R03/R10/R18；本批先迁移响应请求的接受/拒绝入口，不同时改响应者退出、任务状态、AED 生命周期或业务待决规则。
- 目标归属：新增 `backend/src/response-decision.ts`，唯一拥有 decision fingerprint、delivery 幂等、服务端资格复核、参与区间写入、assignment 重算和 recruitment 更新的同一 `StateStore.transact`。`service.ts` 只保留 iPhone scope 入口、依赖适配、提交后 Socket/REST 投影发布和原错误语义。
- 非修改范围：不改变 ACCEPT/REFUSE 状态、30 秒 offer、VIEWED 门槛、人数上限、assignment 公式、错误状态码、通知受众或终态规则；不把客户端决定当作全局真值。
- 兼容影响：HTTP `/events/{eventId}/responses/{deliveryId}` 路径和返回 JSON 不变；旧测试直接调用 `EmergencyService.respond` 仍经同一新用例入口，不保留第二套事务实现。
- 验收：重复同内容请求保持幂等；同 delivery 不同内容冲突；接受时服务端重新验证位置/资格；参与区间、任务分配、招募状态和 decision fingerprint 同事务提交；事务失败不发布新 assignment/recruitment 结果。
- 验证：`npm run test:business` **100/100**、`npm test` **163/163**、`npm run check` 和 `npm run build` 通过；新增 `backend/test/architecture-repair-native/response-decision-boundary.test.mts` 通过，确认 `service.respond` 不再拥有第二个 `store.transact`。
- 独立复审：同一执行者按源码差异、原有业务测试、静态边界测试复核；没有发现新增失败。完整后端全量测试通过后才允许进入响应者退出/任务状态的下一子批。
- 回退：只回退 `response-decision.ts`、`service.ts` 的接线、边界测试、package script 和台账；无数据库迁移。回退必须恢复原 `respond` 单一事务代码，不删除已有事件/参与/assignment 数据。

## P0-USECASE-EXIT-01：响应者退出事务用例边界（2026-09-10）

- 对应风险：R03/R10/R12；本批迁移已批准的响应者退出行为，不改变单响应者确认、退出后禁止重入、AED 已取得事实保留或补招规则。
- 目标归属：新增 `backend/src/responder-exit.ts`，唯一拥有 exit fingerprint、幂等回放、参与窗口结束、pending offer 过期、assignment 取消、设备位置/事件绑定撤销、人数低于目标时重开招募和退出结果的同一 `StateStore.transact`。`service.ts` 只保留 iPhone scope、依赖适配和提交后的 assignment/coordination 通知。
- 非修改范围：不改变终态、AED 归还/交接规则、人数目标、失联补位、路线 provider 或跨事件争用；不把客户端 `exitedAt` 当作服务器权威时间，仍按原 causal clamp。
- 兼容影响：`POST /events/{eventId}/exit`、请求/响应 JSON、错误状态码和原幂等语义保持；旧业务测试直接调用 `EmergencyService.exitEvent` 仍进入新用例。
- 验收：重复同内容 exit 幂等；同 `exitId` 异内容冲突；唯一响应者未确认保持事务无变化；退出后的稳定 userId 不能重新接受；AED acquired assignment 被取消但 AED 事实保留；剩余响应者和候选招募在同一事务结果上重算。
- 验证：`npm run test:business` **101/101**、`npm test` **164/164**、`npm run check` 和 `npm run build` 通过；新增 `backend/test/architecture-repair-native/responder-exit-boundary.test.mts` 通过，确认 `service.exitEvent` 不再保留第二个 `store.transact`。
- 独立复审：按源码差异、退出业务回归、幂等/并发场景和边界测试复核；未发现新增失败。下一子批再处理 assignment 状态入口，不把 AED 生命周期规则提前实现。
- 回退：只回退 `responder-exit.ts`、`service.ts` 接线、边界测试、package script 和台账；无数据库迁移，不能删除已写入的 participant exit、assignment 或 AED 事实。

## P0-USECASE-ASSIGNMENT-01：普通 assignment 状态事务边界（2026-09-10）

- 对应风险：R03/R10；本批只迁移普通 assignment 状态推进入口，专用终态动作继续由 `acquireAed`、`reportAedUnavailable`、超时和退出入口产生。
- 目标归属：新增 `backend/src/assignment-status.ts`，唯一拥有设备/事件/assignment 权限检查、状态图校验、服务器时间因果校正、revision 写入、完成招募阶段更新和同事务 recruitment projection。`service.ts` 只保留 scope、依赖适配和提交后的 assignment/coordination 通知。
- 非修改范围：不改变 assignment 状态图、AED 生命周期、任务分工公式、路线、跨事件争用或终态规则；客户端不能直接写入终态 assignment。
- 兼容影响：`PUT /events/{eventId}/assignments/{assignmentId}/status` 请求/响应和错误语义保持；相同状态仍返回幂等视图，专用状态仍返回原冲突错误。
- 验收：重复普通状态请求幂等；非法跳转拒绝；退出用户不能写任务；终态状态必须经专用入口；assignment revision、timeline、recruitmentState 和 coordination revision 同一事务提交。
- 验证：`npm run test:business` **102/102**、`npm test` **165/165**、`npm run check` 和 `npm run build` 通过；新增 `backend/test/architecture-repair-native/assignment-status-boundary.test.mts` 通过，确认 `service.updateAssignmentStatus` 不再保留第二个 `store.transact`。
- 独立复审：按源码差异、assignment 状态图、退出/接受回归和架构边界测试复核；未发现新增失败。下一项进入非终态通知/发件箱或路线 provider 边界前置，不提前改业务待决规则。
- 回退：只回退 `assignment-status.ts`、`service.ts` 接线、边界测试、package script 和台账；无数据库迁移，不删除已有 assignment 事实。

## P0-NOTIFY-DECISION-01：响应决定通知进入事务发件箱（2026-09-10）

- 对应风险：R05/R10；本批处理响应 ACCEPT/REFUSE 结果的非终态通知一致性，保证业务提交和待发送意图共同落库；不把 Socket handoff 当作用户已收到或已查看。
- 修改前范围：`service.respond` 在响应事务提交后直接调用 `publisher.emitToDevices(..., "response:decision-recorded", ...)`；传输失败可能只留下已改变的业务状态，重启也没有该消息的持久记录。
- 目标归属：`runResponseDecision` 事务内通过 `enqueueDecisionNotification` 写入 `notificationOutboxById`；`enqueueNotification` 负责稳定 message/device identity、受众 context 快照和同标识不同正文冲突；`NotificationOutbox` 在提交后按当前授权快照派发并保留 PENDING 重试。
- 本批修改：`backend/src/models.ts`、`backend/src/notification-outbox.ts`、`backend/src/response-decision.ts`、`backend/src/service.ts`，以及业务/边界测试。响应通知仍只发患者和已接受响应者；退出、会话撤销、设备重绑或 event 终态后由发送时授权复核抑制。Wire payload 与 `contracts/events.md` 的字段、受众和 messageId 语义不变。
- 明确非范围：不迁移 `assignment:created`/`assignment:updated`、`response:requested`、`response:offer-expired`、`event:coordination-updated` 等其它非终态直发；不改邀请查看门槛、人数/任务分工、终态原因、APNs、送达/查看定义或任何待决业务规则。上述旧路径仍需后续单独批次迁移，当前不允许新旧路径对同一 `response:decision-recorded` 并行发送。
- 验收场景：响应提交后 publisher 返回空集合仍有两条 PENDING 记录；恢复 publisher 后同一 payload 聚合派发一次并标记 DISPATCHED；重复同内容请求不新增记录；已撤权的受众不能在恢复时收到；事务提交失败不能留下业务或通知草稿。
- 验证：`npm run test:business` **105/105**、`npm test` **167/167**、`npm run check`、`npm run build`、`npm run architecture:storage-load` 和 `git diff --check` 通过。新增 `backend/test/domain.test.ts` 恢复/去重/退出后授权复核场景与 `backend/test/architecture-repair-native/response-decision-boundary.test.mts` 边界断言通过。测试中的 publisher 是受控内存 transport，不是 APNs 或真机送达证据。
- 独立复审：同一执行者按源码差异、通知 schema、dispatch 授权分支、已有终态 outbox 回归和新增断线恢复测试复核；未发现新增失败。尚未完成 assignment/recruitment 其它通知迁移，不能把 R05 写成全部非终态已修复。
- 回退：仅回退本批 `response:decision-recorded` schema、用例 callback、service 接线、测试和文档；不删除 `notificationOutboxById` 已保存记录，不执行数据库/生产数据回退。回退代码需保留现有终态 outbox 读取兼容，并恢复原响应通知直发路径。

## P0-NOTIFY-ASSIGNMENT-01：普通 assignment 更新通知进入事务发件箱（2026-09-10）

- 对应风险：R05/R03；本批处理普通 assignment 状态推进的任务本人通知一致性，沿用已有状态用例事务边界，不改变 assignment 状态图、任务分工或专用 AED 终态入口。
- 修改前范围：`service.updateAssignmentStatus` 在 `runAssignmentStatusUpdate` 提交后直接调用 `publisher.emitToDevices(..., "assignment:updated", ...)`；断线或 transport handoff 失败没有持久待发送事实。
- 目标归属：`runAssignmentStatusUpdate` 在修改 assignment、revision、timeline 和 recruitment projection 的同一 `StateStore.transact` 内调用 `enqueueAssignmentNotification`；`NotificationOutbox` 负责稳定 messageId、recipient context、重试和发送时授权复核。
- 本批修改：新增 `assignment:updated` 内部通知 schema；任务本人记录只有在当前 assignment ID/revision、事件 ACTIVE、设备绑定未变且 delivery 仍为 ACCEPTED 时派发。`service.updateAssignmentStatus` 停止该消息的事务外直发，提交后 drain；Wire payload 和既有任务本人受众不变。
- 明确非范围：本批不迁移路线刷新、AED 不可用替代任务、退出补招和其它 recruitment 直发；响应接受重算另由 P0-NOTIFY-REPLAN-01 处理。不改专用终态状态、人数上限、AED 生命周期、通知查看语义或 APNs。
- 验收场景：publisher 返回空集合时 assignment 更新和 outbox 记录共同提交并保持 PENDING；恢复后按同一 revision 派发一次；同状态重复请求不新增记录；任务本人退出后旧 revision 被 SUPPRESSED；事件终态后的旧任务消息不恢复为活动通知。
- 验证：新增 `backend/test/domain.test.ts` 的断线恢复与退出授权复核场景，`backend/test/architecture-repair-native/assignment-status-boundary.test.mts` 确认旧入口无 `assignment:updated` 直发；`npm run test:business` **107/107**、`npm test` **169/169**、`npm run check`、`npm run build`、`npm run architecture:storage-load` 和 `git diff --check` 均通过。
- 独立复审：同一执行者按源码差异、schema、revision/退出授权分支和已有 assignment 测试复核；未冒充独立审查者。接受/路线/替代任务的旧发送路径仍明确保留，R05 继续按部分修复记录。
- 回退：仅回退 `assignment-status.ts`、`notification-outbox.ts`、`service.ts` 接线、测试、契约和台账；不删除已保存 assignment outbox 记录，不执行数据库或生产数据回退。回退代码需保留旧终态 outbox 读取兼容。

## P0-NOTIFY-REPLAN-01：响应接受重算 assignment 通知进入事务发件箱（2026-09-10）

- 对应风险：R05/R10/R03；本批处理响应接受触发的 assignment 创建/重排通知，使 delivery 接受、参与关系、assignment revision 和任务本人通知共同提交。
- 修改前范围：`runResponseDecision` 在同一事务内重算 assignment，但 `service.respond` 在提交后通过 `publishAssignmentEmissions` 直接派发；进程中断或 transport 不可用时，接受已成功而任务通知没有持久记录。
- 目标归属：`runResponseDecision` 通过 `enqueueAssignmentEmissions` 在自身事务内写入 `assignment:created`/`assignment:updated`；outbox 在发送时验证事件 ACTIVE、当前 assignment ID/revision、任务设备、已接受关系和退出撤权。响应决定和 assignment emission 不再由两条写入权威分别发送。
- 本批修改：扩展通知模型和 payload schema 支持 `assignment:created`；停止响应入口对该 emission 集合的直发；保留 wire payload、任务本人受众、messageId 和 assignment 状态规则。
- 明确非范围：不迁移响应者退出补招、路线刷新、AED 不可用替代任务、患者位置重算及其它 `publishAssignmentEmissions` 调用；不改变接受资格、人数分工、AED 生命周期、任务状态图、APNs 或用户查看语义。
- 验收场景：接受时 publisher 返回空集合，响应决定和 assignment 创建记录共同保持 PENDING；恢复后患者收到决定、任务本人收到 assignment 创建且各自只派发一次；同一接受重试不新增 assignment 记录；退出或 revision 变化后旧 assignment emission 被抑制；事务失败不保留 assignment 通知草稿。
- 验证：`backend/test/domain.test.ts` 扩展断线接受/重试并核对 `assignment:created`；`backend/test/architecture-repair-native/response-decision-boundary.test.mts` 确认响应入口无 `publishAssignmentEmissions`。`npm run test:business` **107/107**、`npm test` **169/169**、`npm run check`、`npm run build`、`npm run architecture:storage-load` 和 `git diff --check` 均通过。
- 独立复审：同一执行者按源码差异、事务 callback、assignment schema、revision 授权和旧终态 outbox 回归复核；未冒充独立审查者。其它 assignment emission 仍保留在明确的后续批次。
- 回退：仅回退 `response-decision.ts`、`notification-outbox.ts`、`models.ts`、`service.ts` 接线、测试、契约和台账；不删除已保存通知记录，不执行数据库或生产数据回退。回退代码需继续读取已有终态与普通 assignment outbox 记录。

## P0-NOTIFY-EXIT-REPLAN-01：响应者退出重算 assignment 通知进入事务发件箱（2026-09-10）

- 对应风险：R05/R08/R10；本批处理响应者退出后剩余参与者的 assignment 重算通知，确保退出撤权、任务取消/重排和任务本人通知共同提交。
- 修改前范围：`runResponderExit` 在退出事务内重算 assignment，但 `service.exitEvent` 提交后通过 `publishAssignmentEmissions` 直发；退出后进程中断可能留下已取消/重排状态而没有可靠任务通知。
- 目标归属：`runResponderExit` 通过 `enqueueAssignmentEmissions` 在同一 `StateStore.transact` 内写入 assignment outbox；发送时按当前 assignment ID/revision、事件 ACTIVE、仍接受参与和退出撤权复核。`service.exitEvent` 保留退出事件通知和 recruitment 发布适配，不再直接派发 assignment emission。
- 本批修改：退出重算产生的 `assignment:created/updated` 进入已有 schema/outbox；任务本人仍是唯一 assignment 受众，退出者及旧 revision 不会收到重排任务。
- 明确非范围：不迁移路线刷新、AED 不可用替代任务、患者位置重算及其它 `publishAssignmentEmissions` 调用；不改单响应者确认、退出后禁止重入、AED 已取得保留、失联补位或其它业务待决规则。
- 验收场景：两名响应者中一人退出时，剩余响应者的 assignment emission 与退出事务共同保持 PENDING；恢复后只向剩余响应者派发一次；退出者和旧 assignment revision 被抑制；重复 exit 不新增通知记录；退出 Socket/coordination 仍保持原契约。
- 验证：新增 `backend/test/domain.test.ts` 退出重算断线/恢复场景和 `responder-exit-boundary.test.mts` 边界断言；API integration 的 coordination 监听提前到状态请求前，消除旧测试竞态。`npm run test:business` **108/108**、`npm test` **170/170**、`npm run check`、`npm run build`、`npm run architecture:storage-load` 和 `git diff --check` 均通过。
- 独立复审：同一执行者按退出事务、assignment revision 授权、旧路径调用点和 API Socket 回归复核；未冒充独立审查者。路线/AED/患者位置路径仍明确保留。
- 回退：仅回退 `responder-exit.ts`、`service.ts` 接线、边界/业务测试、契约台账改动；不删除已保存 assignment outbox 记录，不执行数据库或生产数据回退。

## P0-NOTIFY-ROUTE-01：患者位置路线刷新通知进入事务发件箱（2026-09-10）

- 对应风险：R05/R06/R03；本批处理患者最新位置变化引起的已有 `FETCH_AED` assignment route 更新通知，先统一位置事实与任务路线通知的提交边界。
- 修改前范围：`refreshPatientRoutes` 在位置事务中修改 assignment route 并返回 emission，`publishPatientPositionChange` 在事务外直接调用 `publishAssignmentEmissions`；断线或进程中断会使路线状态已更新但任务本人缺少持久通知。
- 目标归属：`refreshPatientRoutes` 在调用方 `StateStore.transact` 内通过已有 `enqueueAssignmentEmissions` 写入 `assignment:updated` outbox；位置接口提交后 drain，再发布患者位置/招募投影。发送时复核 assignment ID/revision、任务本人、ACTIVE 事件和已接受关系。
- 本批修改：覆盖 iPhone 患者位置、严格事件位置批次和 Watch fallback 促成的路线刷新调用；移除位置投影发布 helper 中的 assignment 直发，保留位置变化和 recruitment 的原 wire 事件。
- 明确非范围：不迁移 AED 不可用替代任务、专用资源回执、其它非位置驱动 assignment emission、真实路线 provider、路径失败分类或 AED 生命周期规则。
- 验收场景：患者位置改变路线时，位置事实、assignment route 和待发送记录共同提交；publisher 不可用时记录保持 PENDING，恢复后仅任务本人收到当前 route revision；重复/过期位置不生成新路线通知；事件终态或任务退出后旧 route revision 被抑制。
- 验证：新增 `backend/test/domain.test.ts` 路线刷新断线/恢复场景和 `route-notification-boundary.test.mts`；API integration、全量业务测试、类型检查、构建、存储探针和 `git diff --check` 均通过：`npm run test:business` **110/110**、`npm test` **172/172**。
- 独立复审：同一执行者按位置事务调用点、route revision、outbox 授权分支和现有 Socket 回归复核；未冒充独立审查者。AED 替代及其它非位置路径仍保留后续边界。
- 回退：仅回退 `service.ts` route 接线、route 边界/业务测试、package script 和台账；不删除已保存 assignment outbox 记录，不执行数据库或生产数据回退。

## P0-NOTIFY-AED-REPLACEMENT-01：AED 不可用替代 assignment 通知进入事务发件箱（2026-09-10）

- 对应风险：R05/R06/R07；本批处理 `AED_UNAVAILABLE` 事务内创建的替代任务通知一致性，不改变 AED 资源规则或替代路线选择。
- 修改前范围：`reportAedUnavailable` 在同一事务内写入不可用事实和 replacement assignment，但提交后直接向替代任务本人发送 `assignment:created`；进程中断可能留下替代 assignment 而没有可靠任务通知。
- 目标归属：replacement assignment 创建后立即在同一 `StateStore.transact` 内调用 `enqueueAssignmentEmissions`；提交后由 outbox drain，发送时复核 assignment 当前 revision、任务本人、ACTIVE 事件和接受关系。`aed:unavailable` 参与者广播仍保持原语义。
- 明确非范围：不改 AED 无替代、跨事件争用、归还/交接、持有 AED 退出、真实路线 provider 或专用资源回执规则；不迁移其它 AED 业务通知。
- 验收场景：publisher 不可用时 `AED_UNAVAILABLE` 事实、replacement assignment 和 PENDING 通知共同提交；恢复后只向替代任务本人派发一次；重复 report 幂等且不新增 replacement 通知；终态/退出后旧 replacement revision 受抑制。
- 验证：新增 `backend/test/domain.test.ts` 替代任务断线/恢复场景和 `aed-replacement-notification-boundary.test.mts`；`npm run test:business` **112/112**、`npm test` **174/174**、`npm run check`、`npm run build`、`npm run architecture:storage-load` 和 `git diff --check` 均通过。
- 独立复审：同一执行者按 replacement 事务、outbox schema、发送授权和既有 AED_UNAVAILABLE 回归复核；未冒充独立审查者。其它 AED 生命周期仍保持待决边界。
- 回退：仅回退 `service.ts` replacement 接线、边界/业务测试、package script 和台账；不删除已保存 assignment outbox 记录，不执行数据库或生产数据回退。

## P0-USECASE-BACKEND-CLOSE：核心后端用例权威边界（2026-09-10）

- 对应风险：R03/R05/R10；本批把“谁能改变全局救援状态”落实到可执行的事务入口，不改变已批准的主体权限、终态原因、assignment 状态图、人数公式或 AED 交接待决规则。
- 当前归属：`response-decision.ts` 维护接受/拒绝，`responder-exit.ts` 维护退出，`assignment-status.ts` 维护普通任务推进，`event-resolution.ts` 维护患者结束、误报和授权操作结束，`aed-actions.ts` 维护 AED 取得及 AED 不可用/替代。各模块是具体用例入口，不是转发壳；每个模块拥有自己的 fingerprint/权限复核/幂等和唯一 `StateStore.transact`。
- service 边界：`service.ts` 现在只做 scope/身份入口、依赖适配、提交后 outbox drain 和兼容返回；不再在这些入口保留第二个业务事务或同一消息的事务外直发。后端提交快照仍是事件状态、参与人数、任务、AED 事实和通知意图的权威。
- 已迁移路径：`respond`、`exitEvent`、`updateAssignmentStatus`、`acquireAed`、`reportAedUnavailable`、`resolveEvent`、`confirmFalseAlarm`。`AED_UNAVAILABLE` 的 replacement assignment、`aed:unavailable`/`aed:acquired` 广播意图与 AED 事实同事务提交。
- 尚未宣称完成：状态确认 `tick`/`respondToStatusConfirmation` 的 scheduler 用例、尚未存在明确业务规则的 assignment `TIMED_OUT` writer，以及 `reportWatchObservation` 等事件创建/位置写入口仍在 service 内；这些不与本批混写，继续作为下一边界批次。没有把不存在的超时业务规则补出来。
- 验收：新增 `event-resolution-boundary.test.mts`、`aed-replacement-notification-boundary.test.mts`；重复请求、同标识不同内容、接受/结束交错、AED 幂等/替代、事务失败和原有终态测试均保留。`npm run test:business` **116/116**、`npm run check` 通过；完整 test/build 结果以本批最终记录为准。
- 回退：只回退上述用例模块、service 接线、边界/业务测试和文档；不删除已经提交的事件/assignment/AED/outbox 事实，不执行数据库或生产数据回退。

## P0-NOTIFY-RELIABLE：业务通知事务发件箱与授权重试（2026-09-10）

- 对应风险：R05/R17；本批将业务变更与待发送记录放入同一状态事务，发送时重新核对当前设备、账号、pair、事件关系、assignment revision、接受关系和退出撤权。发送器返回 handoff 只表示交给当前 Socket，不表示用户收到或查看。
- 已入箱的消息：`response:requested`、`response:offer-expired`、`event:patient-activated`、`event:patient-position-updated`、`event:coordination-updated`、`event:status-confirmation-requested`、`response:decision-recorded`、`event:participant-exited`、`aed:acquired`、`aed:unavailable`、`assignment:created`、`assignment:updated` 以及三种终态消息。`assignment:timed-out` 当前没有业务 writer，不能把它写成已完成。
- 可靠性边界：`NotificationOutbox` 先持久化 attempt，再按稳定 message/recipient identity 分组发送；Socket 不可用、部分设备未连接、授权变化、设备重绑或事件终态会分别保留 PENDING 或 SUPPRESSED。`replayPendingResponses` 仍是授权 REST 快照的即时恢复，不与历史 outbox 记录混为用户送达凭证；旧的 `SENT` 候选重试直发已停用，避免两个发送权威。
- 兼容影响：wire 名称、字段、messageId 和既有受众规则保持；候选不再通过协调消息获得额外字段，发送时按服务端当前权限 fail-closed。新增通知记录沿既有 `state_items` collection 持久化，不更换数据库、不迁移生产数据；旧程序若不识别新 collection 不能直接读取新状态。
- 验收：候选请求/过期、患者位置/coordination、状态确认、AED 取得/不可用、退出和终态在 publisher 失败、服务重启、部分连接、重绑/撤权、重复请求及 ACK 写回失败时保持稳定；新增 `reliable-notification-boundary.test.mts`，业务套件 **116/116**、完整套件 **178/178** 通过。受控 publisher/SQLite 证据不是 APNs 或用户查看证明。
- 非范围/阻塞：APNs provider、跨实例发送、通知权限下降后的真实系统行为、用户收到/查看回执、容量和历史清理策略仍未验证；这些不能用本地 Socket 成功替代。
- 回退：代码回退必须保留已写 `notificationOutboxById` 的前向读取和未确认记录，不删除队列、不恢复旧库抹掉新事实；仅回退本批模块/接线/测试/契约文档。

## 路线服务权威边界（当前实现与下一批）

- 后端权威保存患者有效 P、响应者有效 R、AED 资源、R-A-P route、ETA/距离分桶、任务角色、assignment revision 和路线变更的因果时间。`replanAssignments` 与 `refreshPatientRoutes` 在业务事务内决定或更新 assignment；assignment outbox 只记录已提交 revision。
- iPhone/Watch 只提交带原始采样时间的事实或展示后端授权快照。它们可以缓存地图展示、待提交位置和恢复意图，但不能根据本地路线、设备可达性或 Socket 顺序改变全局任务、人数、AED 占用或路线 revision。Socket 断线后必须 REST 对账。
- 当前 `makeAedRoute` 是模块化单体内的参考几何估算，手机地图展示不是后端选路结果；本批只修复 route 事实与 assignment 通知提交边界，没有把地图 SDK 或本地 ETA 宣称为真实 provider。provider adapter、超时/重试/无路线 fail-closed、旧 revision 门和真实路线凭据另列 P0 路线批次。
- 路线失败、无替代 AED、跨事件争用、持有 AED 退出交接和真实路线服务的产品规则仍是待决项；本批不自行选择。可以继续验证的是“后端提交 route/assignment 与通知是否同事务、旧 revision 是否被抑制、客户端是否只读授权快照”。

## D15：事件位置队列 I/O 边界迁移（实施前约束）

- 对应风险：R03/R12/R15（AppStore 同时保存事件位置业务事实、直接调用受保护 store、维护加载/不可用/保存失败状态）；本批只迁移队列 I/O 生命周期，不迁移队列内容、context、开放 draft、封口、ACK 删除或业务窗口。
- 目标边界：新增 `EventPositionQueuePersistenceCoordinator` 唯一执行 `EventPositionQueuePersisting.load/save`，拥有 loaded/unavailable/blocked 生命周期；AppStore 继续唯一维护 `EventPositionQueueState` 及其业务字段。
- 非修改范围：不改变 JSON 编码、文件保护、损坏文件保留、append-only 校验、登出保留事实、批上传或恢复规则；不清理、不截断、不迁移本地队列。
- 验收用例：首次加载建立空队列；保存失败进入 blocked；损坏文件 load fail-closed 且原字节不被覆盖；reset 只清内存 flags 不清文件；AppStore 不再直接调用 store 的 load/save。
- 回退：只回退 D15 coordinator、AppStore 接线、测试、工程接线、runner 和文档；不删除受保护文件或已确认批次。

### D15 实现与验证

- `ios/AEDResponse/Application/EventPositionQueuePersistenceCoordinator.swift` 已接管队列 `load/save` 和 I/O 生命周期 flags；AppStore 仍写入 `eventPositionQueueState`，并保留恢复上下文、开放 draft、封口、批 ACK/重试和终态窗口。
- 新增回归验证正常 load/save、损坏文件 fail-closed、原文件保留；边界测试确认 AppStore 没有直接 `environment.eventPositionQueueStore.load/save` 写路径。D15 原生组件实际 **29 Phone + 78 Watch**，两个真实 HTTP/服务重启阶段通过。
- `/tmp/aed-queue-persistence-unit-final2-build-20260910.log` 与 `/tmp/aed-queue-persistence-controlled-final2-build-20260910.log` 均为 `TEST BUILD SUCCEEDED`，`/tmp/aed-queue-persistence-release-final2-build-20260910.log` 为 `BUILD SUCCEEDED`；`swiftc -parse` 检查 83 个 Swift 文件通过。最终 runner 为 `/tmp/aedresponse-queue-persistence-final-runner-20260910.log`，证据目录为 `/tmp/aedresponse-queue-persistence-final-20260910`。
- D15 只证明 I/O owner 和失败边界；完整 AppStore runtime、跨进程恢复、OS 后台、真机/Watch、历史容量和生产迁移仍未验证。

## P0-WATCH-OS-01：Watch 生命周期恢复与有效定位事实门（2026-09-10）

- 对应风险：R02/R12/R16/R17；处理类型 F/S。修改前 Watch runtime 只在进程启动和进程内 heartbeat 机会执行恢复；Core Location 适配器只检查精度/坐标构造结果，未来时间、非有限精度或测试/恢复 provider 注入的未来事实仍可能进入 fallback 发送判断。
- 目标边界：Watch runtime 继续只组合 Fall/Call/位置适配器和两个 coordinator；新增统一 `recoverAfterLifecycleBoundary`，由进程启动、前台 scene active 和周期机会共同调用，依次执行会话恢复、待确认触发重试、fallback resume、已知事件状态恢复和展示代次门。它不拥有后端事件状态、终态或位置队列。
- 有效定位事实：`LocationFixValidity` 放在 iPhone/Watch 共用模型中，拒绝非有限经纬度、越界坐标、非有限/非正精度、非有限时间和晚于接收时刻的未来时间；不新增产品 freshness 窗口，不改写旧 fix 的 `observedAt`。Watch fallback coordinator 对注入/恢复样本再次 fail-closed，历史样本仍可按原时间补传。
- 生命周期入口：`AEDResponseWatchApp` 在 `scenePhase == .active` 时调用 `WatchRuntimeModel.appDidBecomeActive()`；该入口只创造一次恢复机会，保留旧 session/connection generation 和受保护队列事实。UI 可读 `lastRecoveryAt/lastRecoveryReason` 诊断值，但它们不表示 watchOS 提供了固定后台执行频率。
- Fall callback 边界：Watch 先让 `FallEmergencyCoordinator` 完成受保护本地事实写入，再立即调用 Core Motion completion；后端/Watch fallback 网络请求在 completion 之后异步继续。这样不会把网络等待误当成系统回调确认，也不改变一次性问答、35 分钟观察保留或授权门。
- 权限/查询/实时边界：B1/B2 的撤销断连、按主体字段投影和实时发送授权保持；`IdentityAccess.assertCurrent` 仅补在 `replayPendingResponses` 内部恢复入口，防止已撤销/过期/重绑的旧 principal 通过内部回放继续发消息。普通 HTTP 查询仍由每请求认证获得当前 principal，未扩大字段或主体权限。
- 验收用例：未来/非有限 iPhone 与 Watch fix 不进入 current/fallback；有效 fix 保留 OS `CLLocation.timestamp`；未来 preferred fallback 不发 HTTP；前台恢复复用同一触发/位置恢复链；撤销后旧 principal 的恢复回放返回 401；既有 Socket 撤销、Watch 专用状态查询、投影字段白名单和发件箱回归保持通过。
- 验证：`npm run check` 通过；后端全套 `npm test` **179/179** 通过（含新增 `recovery/query entry points reject a principal captured before session revocation`）；iPhone generic `AEDResponseUnitTests` build-for-testing 与 Watch generic `AEDResponseWatch` build-for-testing 作为编译证据；新增 `LocationFixValidityTests`、`WatchLocationProviderTests`、future fallback coordinator 回归已纳入对应 target。隔离本地 runner `/private/tmp/aedresponse-p0-watch-os-runner-1789028543` 实际 **33 Phone + 79 Watch + 2 个真实 HTTP/重启阶段** 通过，覆盖 future sample 不上传和历史事实/通知发件箱重启保持。未运行物理 Watch、watchOS XCTest、系统挂起/终止后台频率或蜂窝网络。
- 非修改范围：不选择 Watch fix freshness、手机可达但后端无有效 P 的 fallback 规则，不承诺 5 秒后台调度，不启用 extended runtime，不改变 Fall Detection 授权、终态、人数、任务、AED、APNs 或路线规则。已有 D16 跨进程 delivery receipt owner 和 C4c Watch 事实保留继续生效。
- 回退：代码回退只涉及 `LocationFixValidity`、Watch/iPhone adapter gate、`WatchRuntimeModel` 生命周期接线、`IdentityAccess.assertCurrent`/回放门和本批测试/文档；不删除 Keychain、受保护 fallback、事件位置或 delivery receipt 文件，不执行数据库/生产数据回退。外部 OS/真机验证失败时保留源码门和队列事实，回退不以清队列代替恢复。

### P0-WATCH-OS-01 复审结论

- 本次为同一执行者的只读复审：逐行核对共享定位门、Watch delegate、fallback coordinator、scene 生命周期和 stale principal 入口，再运行后端与 generic target 验证；未冒充独立审核者。
- 本批没有新增严重回归。仍开放的证据是 physical Watch capability/Fall callback、scene 之后的真实 OS 后台机会、APNs/正式身份和 route provider；这些属于外部能力或后续工作包，不能由本批 build 结果替代。
- 可恢复快照：`/Users/REDACTED/Documents/AEDResponse-local-baselines/20260910-p0-watch-os-final/`，含本批源码/测试/文档副本、`VALIDATION.md`、`REVIEW.md` 和已复核 `SHA256SUMS`；与前一批 `20260910-p0-usecase-notify-final` 配合使用，恢复前需逐文件比较，不删除持久队列或数据库。

## P0-ROUTE-BOUNDARY-01：路线服务权威边界（2026-09-10）

- 对应风险：R06/R03；处理类型 S/F。路线选择以前散落在 `domain.ts`、`service.ts` 和 `aed-actions.ts`，存在未来接入真实 provider 时形成第二套选路算法的结构风险。
- 目标归属：`backend/src/route-provider.ts` 的 `AedRouteProvider` 是 best/eligible/refresh 的唯一入口；当前 `ReferenceAedRouteProvider` 仅封装既有确定性几何算法，保持有效输入的现有 ETA、排序和错误语义。服务注入 provider，AED 替代任务也从同一 provider 取 route。
- 失败边界：非法坐标/时间返回 `INVALID_INPUT`，没有可用 AED 返回 `NO_AVAILABLE_ROUTE`，未来 provider 不可用可返回 `PROVIDER_UNAVAILABLE`；`estimateAedRoute` 保持原 404，refresh 不删除已提交旧 route，replan 在 provider 不可用时不虚构 assignment。
- 非修改范围：没有引入地图 SDK、真实路线凭据、超时数值、无替代 AED 业务规则或跨事件资产争用；真实路线能力仍是外部验证项。
- 验证：新增 `route-provider-boundary.test.mts` 覆盖确定性 best/eligible、一致排序、非法几何 fail-closed 和 service 不再直接调用三套 domain route 函数；后端 `npm test` **183/183**、`npm run test:business` **120/120**、check/build 通过。
- 复审与回退：同一执行者核对 provider 注入和旧 direct call 消失，未发现新增严重回归。代码回退只涉及 provider、service/aed-actions 接线和测试，无数据库/路线数据回退；回退时保留有效 assignment.route，不清理已提交事实。

## P0-STATUS-USECASE-01：状态确认请求与 scheduler 用例边界（2026-09-10）

- 对应风险：R10/R15/R03；处理类型 S。状态确认响应的幂等、截止时间和 CONTINUE 事务此前仍内嵌 `service.ts`，scheduler 也直接拥有状态确认写入逻辑。
- 目标归属：`backend/src/status-confirmation.ts` 现在同时拥有 `runStatusConfirmationResponse` 和 `advanceStatusConfirmation`；响应/过期关闭/周期请求的状态、timeline、终态转换和事务内通知意图由该模块协调。service 只做 iPhone scope、时间适配、recruitment/outbox callback 和提交后的 transport drain。
- 保持规则：30 分钟周期、5 分钟回答窗、同 confirmationId 同内容幂等、异内容冲突、超时 `CLOSED_UNCONFIRMED_NO_RESPONSE` 和现有错误语义均不改变；没有选择“未送达是否关闭”等待决产品规则。
- 验收：同内容重试不新增事实；同标识异内容冲突；回答早于 sentAt/晚于 deadline 或服务器已过 deadline 拒绝；tick 与 response 并发仍单写；scheduler 产生请求与终态通知都在原 StateStore 事务内。
- 验证：新增边界测试确认 service adapter 不再直接拥有 response transaction，tick 调用模块 scheduler；状态确认原有业务回归保持通过。全后端 **183/183**、业务 **120/120**、check/build 通过。
- 复审与回退：同一执行者按模块、tick adapter、时间/终态回归复核；未发现新增失败。回退只涉及 `status-confirmation.ts`、service 接线、边界测试和 package script，不回退事件状态或历史记录。

## P0-WATCH-ADMISSION-01：Watch fallback 业务准入策略边界（2026-09-10）

- 对应风险：RV-04/R02/R08；处理类型 S/D。当前“iPhone 可达则停止 fallback”仍是未决业务规则，不能在没有“后端已收到有效 P”事实时擅自改成新的产品门槛。
- 目标归属：`WatchFallbackAdmissionPolicy` 负责 `eligible / waitForIPhoneRecovery / waitForConnectivity / blockedPendingBusinessRule` 决策；默认 `ReachabilityOnlyWatchFallbackAdmissionPolicy` 保持现行行为，`WatchFallbackCoordinator` 只执行策略结果、保留队列和停止/启动采集。
- 安全边界：策略返回 `blockedPendingBusinessRule` 时不开始新采集、不写新事实、不删除已有 pending/history；网络错误、权限错误、终态和内容冲突仍按原隔离/退避语义处理。未来 server-P-health 策略可替换 policy，不需要第二套 coordinator。
- 验证：新增 XCTest 注入阻断策略，确认未发送且原队列事实保留；iOS Unit 与 Watch generic `build-for-testing` 通过。模拟器 targeted run 因 CoreSimulator launch IPC server died 未得到运行结果，不能写成 XCTest 通过；本地 runner/已有 Watch 组件证据仍保持原记录。
- 待决/回退：手机 reachable 与后端有效 P 的关系、初始 Watch fix 年龄和 freshness 仍列业务待决；回退只移除 policy 注入和新增结果分支，不清空 fallback 队列或改变旧默认规则。

## P0-APPSTORE-RECEIPT-01：AppStore 剩余回执编排迁移（2026-09-10）

- 对应风险：R03/R05/R12；处理类型 S/F。D16 已迁持久化 owner，但 AppStore 仍负责 append 后的发送 loop、退避、ACK 和 transport 取消，跨进程恢复证据不完整。
- 目标归属：新增 `ios/AEDResponse/Application/DeliveryReceiptUploadCoordinator.swift`，拥有 context admission、queue append、single-flight drain、指数退避、ACK 保留和 transport cancel；`AppStore` 仅维护会话 context、UI timeline/error projection，并在连接成功后调用 `startDrain`。
- 运行语义：logout/reset 只清内存 owner；受保护队列文件保留。新 AppStore 实例先 recover 同一账号/设备 context，再由新连接 drain；发送成功而本地 ACK 失败时原事实继续保留，不能当作用户已查看。
- 验收：新增 `testDeliveryReceiptSurvivesAppStoreRestartAndDrainsFromSameProtectedQueue`，覆盖第一次发送失败、销毁第一个 AppStore、重建第二个 AppStore、同队列重读和后续幂等发送；边界测试确认 AppStore 不再直接调用 `sendReceipt`。
- 验证：Unit generic build-for-testing **通过**，Watch generic build-for-testing **通过**；模拟器 targeted test 因 CoreSimulator `NSMachErrorDomain Code=-308 (server died)` 未完成，记录为环境阻塞而非代码通过。真机/真实崩溃点仍未验证。
- 复审与回退：同一执行者核对新 coordinator、AppEnvironment 注入、`project.pbxproj` 三个 iPhone target 接线和旧队列格式；回退只移除上传 coordinator/接线与测试，保留 `DeliveryReceiptQueuePersistenceCoordinator` 文件格式和既有回执，不删除数据。

## E-STORAGE-03：历史与存储成本测量及 SQLite committed-row cache（2026-09-10）

- 对应风险：R04/R12/R15；处理类型 F/V。原 SQLite transaction 每次都重新 flatten previous state 与 next state，虽然 no-op 不写入，但仍承受重复全状态比较成本；历史增长只有合成探针，缺少实体计数/字节指标。
- 修改范围：`SQLiteStateStore` 缓存最后一次成功提交的 flattened rows，只在变化事务提交后更新；写失败时 cache 不前移。新增 `measureStorageCost` 输出实体数、序列化 payload bytes、collection counts、timeline 条目、event-position records 和 PENDING notification 数；storage-load probe 对 0/1k/10k/50k 档记录该快照。
- 保持边界：没有 schema migration、生产迁移、删除历史、改变 append-only 校验或绕过 clone/validate；缓存不是实体数据库替换，也不表示横向扩展或目标 SLA 已满足。
- 验证：`npm run architecture:storage-load` 通过，50k synthetic 档重启后 history/notification/batch/concurrent counts 保持一致，约 9.82MB 文件、287ms reopen、67ms full read、50ms entity read、138ms no-op transaction、1.08s 八个串行事务（机器/Node 版本见日志）；全后端 **183/183**、业务 **120/120**、check/build/git diff --check 通过。
- 复审与回退：同一执行者核对 cache 只在 SQLite write 成功后更新，seed/legacy normalization 仍可持久化；回退只移除 cache/measurement 和 probe 字段，不删除 SQLite rows。正式历史保留期、目标并发、队列积压阈值和生产容量仍为 P1/V 验证项。

## P0-APPSTORE-EVENT-FACTS-01：事件位置开放事实与封口边界（2026-09-10）

- 对应风险：R03/R12/R15；处理类型 S/F。AppStore 仍直接持有开放 slot、clocked slot、APP_NOT_RUNNING 标记和候选坐标，导致事件位置事实 owner 与 UI/连接编排混在一个对象中。
- 目标归属：新增 `EventPositionFactCoordinator`，拥有事件位置上下文中的开放 slot、候选 fix、clock 状态、恢复草稿、候选更新、封口后移除和 movement 计算；AppStore 继续维护账号/事件/连接代次、服务端 `canPublishEventPosition` 窗口、受保护队列、批上传和 UI 错误投影。
- 保持不变量：仍使用原始 `CLLocation.timestamp`；同 slot 只保留观测时间较新的 fix；未确认 draft 先持久化；ACK 前批次不删除；终态/权限/跨事件边界仍由 AppStore 与后端快照决定；没有新增 freshness 或 APP_NOT_RUNNING 规则。
- 验证：新增 `EventPositionFactCoordinator.swift` 工程接线与架构边界断言；更新本地真实 HTTP/重启 runner，实际通过 **33 Phone + 80 Watch + 2 个 HTTP/重启阶段**；iOS Unit generic `build-for-testing` 通过。未运行物理设备或模拟器 XCTest。
- 非修改范围：没有迁移后端批次 ACK、退出窗口对账、服务端权限判定、路线、Watch fallback 或数据库；AppStore 仍保留这些外部权威适配职责。
- 复审与回退：同一执行者核对新 coordinator 的 draft/candidate/clock/seal state owner、project target 接线和旧队列格式；回退只移除 coordinator、AppStore 接线、runner/test/doc changes，不删除开放草稿、已封口批次或任何持久化事实。

## P0-APPSTORE-EVENT-WINDOW-01：事件位置参与时间窗与权威对账边界（2026-09-10）

- 对应风险：R03/R12/R15；处理类型 S/F。AppStore 仍内嵌服务端参与时间窗的越界判定、开放草稿隔离和未 ACK 批次重组；退出 ACK 在切换到新事件后还需要一条不触碰新事件开放事实的恢复路径。
- 修改前范围：`applyEventPositionParticipationWindow`、`eventPositionExclusionReason`、`reconcilePendingEventPositionBatches` 和 `reconcileOpenEventPositionDraft` 同时读取/改变 AppStore 的 queue、open facts、错误投影与持久化；旧事件退出恢复直接复用其中的局部实现。
- 目标归属：新增 `ios/AEDResponse/Application/EventPositionWindowReconciliationCoordinator.swift`。它只接收后端已确认的开始/结束时间、开放事实值快照和持久化队列值快照，负责越界原因、原记录保留、合法批次重建、隔离证据和权威结束时间写入；不做 REST 权限、队列 I/O、上传、ACK 删除或业务终态判断。`EventPositionFactCoordinator` 提供快照/应用边界，AppStore 只负责授权上下文、持久化成功后的应用、封口和传输 gate。
- 保持不变量：后端 `canPublishEventPosition` 与参与时间窗仍是权威；不得用 Socket/本地时钟替代；`recordId`、`slotAt`、`fixObservedAt`、状态和坐标原样保留；越界记录进入 append-only `quarantinedEvidence`；合法未 ACK 记录才可用新 `batchId` 重组；退出事件恢复只重排对应旧 context，不触碰当前新事件的开放槽；没有改变终态原因、退出资格、补招、人数或 AED 规则。
- 修改范围：AppStore 的窗口入口改为值级协调器结果，`retryPersistedAuthoritativeExitWindows` 与退出 ACK 的旧 context 对账改走同一 persisted-batch 方法；新增 `EventPositionWindowReconciliationCoordinatorTests` 覆盖开始前/结束后记录隔离、合法记录保留、开放快照不被失败前置计算改变；`ArchitectureBoundaryTests` 禁止 AppStore 保留三组窗口重排 helper；工程与本地 runner 接线同步更新。
- 非修改范围：不改变后端窗口签发、查询字段/权限、批次 ACK、路线、Watch fallback、OS 后台或任何待决业务门槛；不清空队列、不新增 freshness、不把事件结束解释成 AED 已归还。
- 验收场景：退出 ACK 到达时旧批次含同窗与越界槽，重排只保留合法 `recordId` 并把越界事实隔离；开放草稿含旧槽、终态后槽和真实候选，结果保留合法 fix、隔离越界候选、不制造无 fix gap；受保护写失败时输入快照未被协调器部分改写；新事件 active 时旧事件恢复不改变新事件 open facts。
- 验证：最终 `python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-window-outcome-runner3` 通过，实际 **38 Phone + 80 Watch + 2 个 HTTP/重启阶段**（包含窗口与 outcome 纯状态测试）；`xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` 为 **TEST BUILD SUCCEEDED**（日志 `/tmp/aedresponse-window-outcome-build-for-testing1.log`），包含新 XCTest 与边界测试；`git diff --check` 通过。尝试运行 Simulator XCTest 时实际设备启动遇到 `NSMachErrorDomain Code=-308 (IPC server died)`，未把它写成断言通过；无物理设备证据。
- 复审：同一执行者按差异逐行核对“窗口计算/证据隔离/队列 I/O/封口/上传”边界，并确认旧 AppStore helper 已停用；没有冒充独立审查者。后端本批未改，既有后端 **183/183**、业务 **120/120** 证据沿用，不因 iOS-only 批次重复声称新后端测试。
- 回退：代码回退仅涉及窗口协调器、Fact snapshot/apply、AppStore 接线、工程/测试/runner/文档；保留已写队列、open draft 和 `quarantinedEvidence` 格式，不用 git revert 替代数据恢复，不执行本地/生产数据删除或迁移。

## P0-APPSTORE-EVENT-OUTCOME-01：事件位置 ACK 与永久拒绝状态边界（2026-09-10）

- 对应风险：R03/R12/R15；处理类型 S/F。批上传 transport 已有 single-flight，但 ACK 删除和永久拒绝隔离仍在 AppStore 内直接修改 `pendingBatches`，形成 transport 回调与队列业务状态的第二个隐式 owner。
- 目标归属：新增 `ios/AEDResponse/Application/EventPositionBatchOutcomeCoordinator.swift`，只负责 ACK 与原请求的强校验、按完整 context + batchId 删除一条已确认批次、以及把单个永久拒绝批次改为 `blockedReason`；它不做持久化、重试、上传、窗口、权限或终态判断。AppStore 只持有队列快照，调用结果并在持久化成功后更新 `lastEventPositionBatchAck`/错误投影；`EventPositionBatchUploadCoordinator` 继续只拥有 transport single-flight 和代次 lease。
- 保持不变量：ACK 结构、`recordId` 集合、批次 ID 和 event ID 不匹配时返回失败并保留原批次；永久拒绝不删除事实、不阻塞后续合法批次；context 不匹配不写入；保存失败时队列内存/磁盘均不前移；没有改变服务端 4xx 分类或业务规则。
- 修改范围：AppStore 的 `commitEventPositionBatchAck`/`isolateEventPositionBatch` 改为调用 outcome coordinator；新增纯状态单元测试，扩展架构边界测试和 iPhone 工程/runner 接线。修改 `EventPositionBatchUploadCoordinator` 注释以标明 transport/outcome 分工。
- 非修改范围：不改变参与时间窗、事件位置封口、ACK API、服务端权限、通知、Watch fallback、路线、存储格式或 ACK 后队列事实保留策略。
- 验收场景：原批次 ACK 只移除同一 batch，后续批次保留；错误 ACK 让 transport 继续重试；永久 422/403/409/413 批次变 blocked 且 payload/record 保留，后续合法批次继续发送；进程切换/持久化失败仍保留原批次。
- 验证：`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-window-outcome-runner3` 通过，实际 **38 Phone + 80 Watch + 2 个 HTTP/重启阶段**，并编译/运行窗口与 outcome 纯状态测试；`xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-window-outcome-build-for-testing1.log`）；`git diff --check` 通过。此前 targeted Simulator XCTest 仍因 `NSMachErrorDomain Code=-308` 未形成运行证据，无物理设备证据。
- 复审与回退：同一执行者核对 outcome coordinator 的 exact-match、无匹配 no-op、AppStore 持久化后应用顺序和旧 transport 回调；未冒充独立审核者。回退只移除 outcome coordinator、接线、测试/工程/文档，不删除 pending/blocked 记录，不执行数据库回退。

## P0-APPSTORE-ASSIGNMENT-TIMEOUT-REST-01：Socket 超时提示回归 REST 权威（2026-09-10）

- 对应风险：R03/R10；处理类型 F/S。`assignmentTimedOut` Socket 提示此前直接调用本地 `markTimedOut`，在 REST 对账前把任务投影改成 `TIMED_OUT`，与“Socket 只作通知、后端提交状态权威”约束冲突。
- 修改范围：AppStore 仍在已匹配 event/assignment context 下暂停终态相关采集并保留 timeline，但不再写本地 timeout 状态；只触发 `reconcileEvent`，由 REST 快照决定 assignment 是否真的超时、是否重派或保持原状态。现有 `AssignmentProjectionCoordinator.markTimedOut` 保留为独立投影组件能力和历史单元测试，不再作为 Socket 生产写入口。
- 保持不变量：不改变后端超时 writer、重新招募、任务分工、接受资格或位置队列；终态/恢复仍保留合法历史事实，不清空队列。
- 验收：新增 AppStore 回归断言，REST 缺失/失败时收到 Socket 超时提示不会先把 assignment 改成 `TIMED_OUT`；架构边界断言确认 AppStore 不再调用 `markTimedOut`，仍记录提示并发起 REST 对账。
- 验证：最终 `python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-assignment-timeout-runner1` 通过，实际 **38 Phone + 80 Watch + 2 个 HTTP/重启阶段**；`xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` 为 **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-assignment-timeout-build-for-testing1.log`）；`git diff --check` 通过。物理设备、Simulator runtime、OS 后台和真实后端超时规则仍未验证。回退只需恢复 Socket 分支调用和对应测试/文档，不涉及数据库/生产数据。

## P0-APPSTORE-STATUS-CONFIRMATION-GENERATION-01：状态确认回调代次与事件身份边界（2026-09-10）

- 对应风险：R03/R10/R15；处理类型 F/S。`continueCurrentStatusConfirmation` 的异步 REST 回调此前没有复验连接代次、账号、事件 ID 和 confirmationId，旧账号/旧事件响应可能更新 `lastStatusConfirmationResult` 或触发新会话恢复。
- 修改范围：捕获提交时的 event/confirmation/user/generation；响应和错误写回前统一经过 `isCurrentStatusConfirmationSubmission`，登出/断线后不污染新会话；`disconnect()` 同步释放提交中的 UI gate。后端状态确认规则、截止时间和终态不变。
- 验收：新增延迟状态确认回调测试，断开连接后恢复旧响应不得写入结果；架构边界断言覆盖 confirmationId、event、generation 和当前患者状态复验。
- 验证：`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-status-confirmation-generation-runner1` 通过，实际 **38 Phone + 80 Watch + 2 个 HTTP/重启阶段**；`xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-status-confirmation-generation-build3.log`）；`git diff --check` 通过。首次 build 发现 Swift `defer` 中错误的 `return` 和 XCTest async autoclosure，已修正后重测通过。未运行 Simulator runtime、真机或生产状态确认。
- 回退：只回退 AppStore guard、测试和文档；不回退后端状态确认用例、不删除事件历史或状态确认记录。

## P0-APPSTORE-COMPANION-TICKET-GENERATION-01：Watch 配对票据回调代次边界（2026-09-10）

- 对应风险：R02/R03/R15；处理类型 F/S。Watch companion ticket 请求的成功路径已有 connection generation 检查，但旧任务的 `defer` 和失败回调仍可能在断线/切号后清理新任务或写入新会话错误。
- 修改范围：票据 task 的清理只在原 connection generation 仍有效时执行；失败回调同时复验 generation、认证状态和业务服务激活状态；成功路径继续校验 generation、认证和业务服务后才创建/发送 envelope。未改变票据内容、WCSession 传输白名单、Watch 配对权限或后端票据规则。
- 验收：旧 ticket 请求在断线/切号后返回错误不得污染新会话 `lastError`，不得清除新 generation 的 ticket task；同一会话仍只请求一次并在 Watch reachable 时发送。
- 验证：`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-companion-ticket-generation-runner1` 通过，实际 **38 Phone + 80 Watch + 2 个 HTTP/重启阶段**；`xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-companion-ticket-generation-build1.log`）；`git diff --check` 通过。未运行 Simulator runtime、真机或真实 Watch 配对切换。
- 回退：只回退 companion ticket task guard、边界测试和文档；不删除 Keychain/session、票据或业务队列，不执行数据库/生产回退。

## P0-APPSTORE-AUTH-REFRESH-GENERATION-01：LiveSession token refresh 回调代次边界（2026-09-10）

- 对应风险：R02/R03/R15；处理类型 F/S。LiveSession 注入的 token refresh 回调此前只按当前 userId 写回 `AuthSession`，旧连接在重连或切号后可能把轮换后的 token 保存到新会话。
- 修改范围：refresh 回调捕获建立连接时的 `connectionGeneration` 和账号 userId；回调写入前同时复验 generation、认证状态和当前账号。后端 token rotation、Keychain 格式和登出撤销语义不变。
- 验收：旧连接 refresh 回调在新 generation/账号下不得调用 `persistRefreshedAuthSession`；同一连接同一账号仍正常保存轮换 session。新增架构边界断言覆盖 generation/user guard。
- 验证：`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-auth-refresh-generation-runner1` 通过，实际 **38 Phone + 80 Watch + 2 个 HTTP/重启阶段**；`xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-auth-refresh-generation-build1.log`）；`git diff --check` 通过。未运行 Simulator runtime、真机或真实 token rotation 服务器。
- 回退：只回退 refresh callback guard、边界测试和文档；不恢复旧 token 写入行为，不删除 Keychain/session 或生产认证数据。

## P0-APPSTORE-AUTH-RESTORE-GENERATION-01：冷启动认证恢复取消与旧回调边界（2026-09-10）

- 对应风险：R02/R03/R15；处理类型 F/S。冷启动 `refreshSession` 任务此前没有独立 generation；logout 或新登录后，旧恢复结果可能保存旧账号 session 并调用 `finishAuthenticationRestore`。
- 修改范围：新增 authentication restore generation；创建、成功、失败、logout 和显式登录都会使 generation 单调失效/取消。refresh 返回、持久化和失败处理前都复验当前 restore generation 与未认证恢复状态；旧任务不能重新建立业务服务或覆盖 Keychain。
- 验收：新增阻塞 refresh 的冷启动测试，logout 后释放旧 refresh 回调，旧结果不得恢复登录或写回持久 session；既有成功冷启动 refresh 保持通过。
- 验证：`python3 ios/scripts/run_architecture_repair_checks.py --output /private/tmp/aedresponse-auth-restore-generation-runner1` 通过，实际 **38 Phone + 80 Watch + 2 个 HTTP/重启阶段**；`xcodebuild ... -scheme AEDResponseUnitTests ... build-for-testing` **TEST BUILD SUCCEEDED**（`/tmp/aedresponse-auth-restore-generation-build1.log`）；`git diff --check` 通过。未运行 Simulator runtime、真机或真实 refresh 服务。
- 回退：只回退 restore generation、logout/login 接线、测试和文档；不恢复旧账号回写，不删除其它账号的持久队列或认证数据。

## APPLE-LOGIN-CONFIG-ISSUER（2026-09-10）

- 风险/证据：公网 challenge 503 尚存在；main 依赖显式 appleClientIds。AuthView 原授权回调读取可变 serviceBaseURL，Debug 切换地址可能错投 token（静态确认，未真机复现）。
- 类型 F/V；依据：身份与 issuer 隔离、失败关闭；目标边界为服务启动配置和客户端授权上下文，不改变用户合并规则。
- 本批：新增无数据库副作用的配置检查；绑定 challenge/request issuer；扩展同 Apple 身份重登复用账号专项；修正文档中“没有 Apple verifier”的过期描述。
- 验收：缺配置失败退出、合成合法配置通过；本地签名 JWT/REST 专项 6/6、TypeScript check 通过；无真实 Apple、部署、数据库或设备操作。
- 回退：逐文件对比 apple-login-20260910-215000 备份，移除本批脚本/接线/issuer 绑定；无需数据迁移。复审由同一执行者完成。
- 仍待：真实签名 capability、服务器配置上线、授权码交换及 Apple 撤销事件同步。不能将本批称为完整 Apple 登录验收。

## Apple 登录签名核对与测试目标接线（2026-09-10）

- 本机正式 profile 的 application-identifier 为 [TEAM].dev.codex.aedresponse，applesignin=[Default]，到期 2027-09-10；只输出能力与到期信息，没有导出凭据。
- 受控联网目标 AEDResponseControlledTests 原无 CODE_SIGN_ENTITLEMENTS；已在 project.yml 和工程 Debug/Release 配置接入现有 Apple entitlement 文件。离线 TestHost 未改。现有 testhost profile 无 Apple capability，仍需经 Apple 侧配置更新，不能作为已可登录。
- 验证：showBuildSettings 检查目标 entitlement 接线；git diff --check 通过。正式 AEDResponse generic iOS 签名 build 失败：嵌入的 Watch Fall Detection entitlement 尚需 Apple 审批（/tmp/aedresponse-apple-signed-build.log）。没有删除该 entitlement 绕过审核，未安装或启动设备。
- 此构建失败是既有外部 capability 阻塞，不是 Apple 登录验签失败。正式 iPhone profile 的 Apple 能力已确认，但完整签名产物和真实 Apple 登录仍未验证。
- 回退基线：/Users/REDACTED/Documents/AEDResponse-local-baselines/apple-signing-20260910-215431/；只撤销本批两个构建配置的 entitlement 接线，不修改数据库、会话或历史队列。同一执行者复核。
- 下一步：为联网测试 App ID 配置 Sign in with Apple 并更新 profile，或在 Watch 审批完成后构建正式组合 App；随后配置服务器 audience（当前公网此前返回 503）、保留原 pepper，执行真实登录。未部署、未自动申请 capability。


## DEVICE-ACCOUNT-ISOLATION（2026-09-10 23:39）

- 用户报告 Apple 认证后 bootstrap 返回 deviceInstanceId is already bound to a different authenticated account。源码确认 AppEnvironment 原安装级固定 ID 与后端不可覆盖账号绑定冲突。
- 本批仅修改 iPhone：UserDefaultsDeviceIdentityStore 对明确拒绝的 issuer/user 开启稳定 namespace，设备和 pair 同时隔离；旧 ID 不变，其他账号仍沿用原 ID，重新打开 store 仍取得同一 scoped ID。AppStore 所有设备/pair 读取使用同一个当前身份入口。
- 只在 bootstrap 精确 403 detail、当前连接代次/账号仍匹配、无活跃 capture 时迁移一次并重试；普通403、网络错误、第二次失败均不继续生成身份。清除旧配对票据并按新context恢复队列；旧磁盘事实不删、不改属主，不修改后端权限。
- 签名设备构建通过：/tmp/aed-account-device-build.log。原生 Swift harness 执行生产 identity store 源码，AuthSession/APIConfiguration 用最小stub；验证用户/issuer隔离、重建store稳定、只迁一次、legacy保留和UUID有效。该证据不是完整 AppStore 或跨进程验证。新增 XCTest 源码尚未执行。
- 已将修复包覆盖安装到17 Pro。后续亲自启动登录态App并确认bootstrap恢复；不以安装成功当作业务连接成功。
- 备份：/Users/REDACTED/Documents/AEDResponse-local-baselines/device-account-fix-20260910-233729/。代码按本批文件差异回退；保留账户隔离标记与所有队列。回退旧代码会重新遇到绑定冲突，不应删除服务器设备或将历史改绑。
- 尚未验证 Watch 新pair兑换、跨账号旧历史补传、真实bootstrap恢复；身份规则仍由服务器判定。复审由同一执行者完成，无部署、无DB修改。


## ACCOUNT-DEVICE-CONTRACT（2026-09-10）

- 范围：账号切换设备绑定错误契约及回归；不部署，不操作手机当前账号，不删除或转移历史事实。
- 后端 bootstrap 绑定冲突增加明确 problem type device-account-binding-conflict，保留403/title/detail；AppStore使用ProblemDetails分类，旧服务器仅精确generic403+原detail兼容，其他403禁止迁移。
- 新增实际用例测试：B不能覆盖A绑定、拒绝无副作用、B独立绑定、B设备和账户依次撤销后令牌失效、返回A仍保留双方独立身份。
- 修改前新增测试在专用type断言失败；修复后认证/Apple 28/28通过。测试初稿误将账号撤销视为自动撤销设备，按实际iPhone双撤销流程补齐调用后保留原失效断言；未改变账户/设备撤销语义。
- companion-link专项7/7通过；Swift直接执行生产ProblemDetails源码，5种typed/legacy/无关拒绝断言通过；TypeScript check与git diff --check通过。iOS generic build-for-testing通过（/tmp/aed-account-boundary-ios.log）；新增XCTest仅编译，未运行真机测试。
- 备份：/Users/REDACTED/Documents/AEDResponse-local-baselines/account-boundary-20260910-235022/；逐文件撤销本批差异，不改账号设备或数据。客户端兼容线上旧格式，当前未部署新后端。
- 未完成本工作项：登录/权限异步旧回调统一隔离、远端撤销失败的恢复、旧账号历史补传全链、Watch跨账号重新兑换/恢复。账号级注销与设备级注销是两个入口，单独账号注销不等于所有设备撤销；不得宣称完整账号切换闭环已验收。
- 复审：同一执行者核对错误类型、原状态不变断言、旧部署兼容和撤销入口，无独立审查者。


## ACCOUNT-AUTH-CALLBACK（2026-09-11）

- 三个显式认证写入口（手机号challenge、手机号验证、Apple登录）共享authenticationActionGeneration和single-flight gate。登出使旧代次失效并释放UI gate；await成功/失败写回前检查代次、任务取消和仍未登录，旧defer不得清理新登录任务状态。
- 新增阻塞Apple登录→登出→手机号登录→释放旧Apple响应测试，验证新账号与Keychain fake保存内容均保持新账号。原设备/pair namespace与队列未修改；手机账号未被登出。
- generic build-for-testing通过，日志 /tmp/aed-login-generation-build.log。定向Simulator test-without-building等候超过3分钟仍停在Resolve Package Graph，未进入用例，已中断（/tmp/aed-login-generation-runtime.log）；设备服务另报passcode protected，不断言它是模拟器阻塞根因。
- 本批备份为/Users/REDACTED/Documents/AEDResponse-local-baselines/login-generation-20260911-000542/（含SHA256SUMS）；回退只比对AppStore和AuthenticationArchitectureTests本批差异，不撤销之前设备身份修复，不删除数据。
- 未完成：权限弹窗旧回调隔离、撤销失败恢复、跨账号历史补传、Watch重新绑定。没有部署、没有真机新登录测试；同一执行者复核。


## PERMISSION-CONTEXT-ISOLATION（2026-09-11）

- 风险：旧通知/定位权限回调在登出或换账号后仍可写权限、同意记录或激活服务。类型F；只修复回调有效性，不改变通知/Always/精确定位门禁或业务规则。
- AppStore以permissionContextGeneration统一认证上下文；新登录、认证恢复及stopBusinessServices更新代次。六入口覆盖onboarding、requestRequiredPermissions、authorizationCheckTask、appDidBecomeActive、establishConnection与location onAuthorizationChange。成功/错误/defer先校验有效性；协议保存绑定原userId。连接检查另复验connectionGeneration。
- 新增阻塞权限授权→登出→释放授权回调测试，断言不能完成onboarding、授予本地权限或启用业务。新增XCTest已编译；generic build-for-testing成功（/tmp/aed-permission-isolation-build.log）；git diff --check通过。
- 定向运行使用已有xctestrun跳过包解析：/tmp/aed-permission-runtime.log。等待约两分钟仍无用例启动记录，已中断。日志含设备服务passcode protected错误，但未证明其为根因；运行未完成，不能把编译算成行为验证。
- 备份：/Users/REDACTED/Documents/AEDResponse-local-baselines/permission-isolation-20260911-001357/。回退仅AppStore本批权限代次和对应测试，保留账号/设备隔离及历史队列。没有数据库变更、部署或手机账号操作。
- 复审由同一执行者逐行检查：旧defer不释放新任务；权限检查不在await赋值前写入；定位Task也受同一代次约束。仍缺同账号重新登录及OS真实权限弹窗运行验证。


## ACCOUNT-RECOVERY（2026-09-11）

- 用户授权撤销失败恢复、旧历史补传、Watch跨账号恢复。处理类型F/S/V，不更改事件或资产规则，不部署/不退出手机账号。
- SessionRevocationRecovery接管进程内撤销：独立记住device/account成功步骤，1/2/4秒退避后保留失败步骤，前台恢复重试；失败提示只进入原登出代次，不能污染新账号。旧AppStore一次性remoteLogout路径停用。该owner尚未持久化，进程终止仍可能丢失待撤销凭据，不能宣称跨进程撤销恢复完成。
- DeliveryReceiptUploadCoordinator补transportGeneration，cancel后的旧defer/错误/ACK不影响新任务；已有受保护回执按原context重读，新增A→B不可读→重建→A可读断言。不清空历史、不换属主。位置历史全窗口和账号切回仍需进一步验证。
- Watch新增显式recoverCompanionLink，复用同一redeem内部用例；原strict redeem仍拒绝不同pair，runtime恢复入口允许同issuer新pair走独立stable device namespace。candidate不改变当前配置；App Attest和后端ticket验证成功后提交linked配置。新linked配置以单个UserDefaults字典发布，旧字段只作为迁移读取，避免新pair/旧device混写。配对ID→设备ID表保留原映射，返回A可恢复原sourceBinding；pending trigger/fallback事实不重标不删除。
- 原生runner通过38 Phone/81 Watch和2个HTTP服务重启阶段；最后配置原子发布修改后定向重测SessionRevocationRecoveryTests、DeliveryReceiptPersistenceTests、WatchCompanionLinkTests，21/21通过（/tmp/aed-account-recovery-targeted.log）。撤销新测试不在旧runner默认filter中，明确通过单独filter执行，未借用旧总数。
- iOS generic build-for-testing成功（/tmp/aed-account-recovery-final-build.log）；watchOS Simulator generic build亦成功（/tmp/aed-account-recovery-watch-build.log），覆盖runtime接线。git diff --check通过。同一执行者复审。
- 回退基线 /Users/REDACTED/Documents/AEDResponse-local-baselines/account-recovery-20260911-002240/；逐文件回退本批差异。保留新linked配置、pair映射和所有队列，不删除数据。旧代码不读取新linked配置，回退后必须经重新配对验证，不用git回退宣称恢复了账号绑定。
- 尚未完成：Keychain持久待撤销队列与过期/已撤销响应语义、真实旧账号位置历史补传、Watch真机/真实AppAttest兑换；不得把本地双身份合成测试称为真实双账号验收。


## DURABLE-SESSION-REVOCATION（2026-09-11）

- 用户授权待撤销凭据安全持久化。新增独立Keychain item pending-session-revocations-v1，AfterFirstUnlockThisDeviceOnly；仅保存原issuer、撤销bearer、步骤种类和来源登录token标记。不保存refresh token，不写UserDefaults/普通文件/诊断日志。
- 生产logout使用APIClient actor快照（等待已有refresh/bootstrap完成）→持久化prepare→清理登录Keychain→本地signedOut→独立发送owner。暂停期间isLoggingOut关闭业务门；存储失败保持原登录凭据和可重试退出，不伪称注销成功。注入测试环境无durable store时沿用原进程内fake路径。
- 冷启动先读取待撤销队列：若原登录token已有退出意图，则清理该登录项，不允许冷启动刷新重新登录；队列损坏/Keychain不可读时关闭恢复门。源token标记覆盖actor刷新与UI持久化回调之间的窗口。前台恢复重试。
- 网络恢复只能POST原APIConfiguration的auth/logout，无重定向/刷新/业务调用；仅204才ACK。ACK写失败保留记录；每轮4次有界重试（1/2/4s），401/过期/其他错误不丢弃记录，不宣称全部远端会话或Watch已撤销。
- 验证：DurableRevocationTests原生macOS运行3/3（真实独立Keychain测试item、重建store后读取、ACK写失败保留、损坏不覆盖），/tmp/aed-durable-revocation-targeted.log。测试仅以合成凭据/发送闭包运行，没有真实注销。iOS generic build-for-testing通过（/tmp/aed-durable-revocation-final-build.log）。已有runner38 Phone/81 Watch及2 HTTP重启阶段通过，但新Durable测试通过独立filter运行，不借用旧总数；已将新测试纳入后续默认filter。
- 实际OS杀进程后端到端恢复、iPhone真机Keychain失败、远端204响应丢失后恢复尚未执行；原生测试的store重建不是OS跨进程测试。401保留待处理，需要服务器进一步提供幂等撤销确认/过期凭据撤销能力。
- 同一执行者差异复核，git diff --check通过；没有部署、没有手机退出账号或真实用户通知。
- 回退基线 /Users/REDACTED/Documents/AEDResponse-local-baselines/durable-revocation-20260911-003315/。逐文件撤销本批接线；保留Keychain待撤销item，不删除凭据。旧版不消费新队列，回退前需记录未完成撤销，不能以代码回退宣称远端撤销已完成。


## LOGOUT-ACK-REPLAY（2026-09-11）

- 针对204响应丢失：SessionRecord新增可选logoutCompletedAt，IdentityAccess在原logout事务内与撤销效果共同提交。auth/logout在普通principal校验前走专用logoutToken入口：仅已持久化显式完成标记+revokedAt可回放204，不生成Principal、不放行业务请求、不重新触发配对撤销。
- 保持既有401边界：过期但未明确logout、refresh rotation、未知token、正常清理后不存在的会话均不能凭空确认。没有扩大旧token撤销新Watch会话的权限，没有更改会话保留期或生产数据库结构。
- 客户端上一批logout-only transport已只接受204，因此无需再次改客户端；旧服务继续保留401记录，新服务部署后可确认仍保留完成标记的重试。
- 测试：新增显式logout重放/业务权限仍拒绝、事务失败无标记、过期不等于撤销、HTTP两次204及未知token401。HTTP测试初稿缺必填challengeId而400，补齐合法合成请求后通过，未放宽API校验。
- 认证/Apple/存储专项50/50、全后端npm test 188/188、npm run check、git diff --check通过。日志 /tmp/aed-logout-confirmation-final.log 和 /tmp/aed-logout-confirmation-all.log。未部署、未调用真实用户logout、未重跑iOS构建。
- 回退 /Users/REDACTED/Documents/AEDResponse-local-baselines/logout-confirmation-20260911-004745/，按本批源码/契约差异回退；保留已写marker/Keychain记录，不删除数据。可选字段无迁移，旧服务不提供重放确认，回退后客户端继续保留待处理记录。
- 限制：完成标记随现有session清理周期一起移除；超出该窗口、首次请求已过期、旧版本成功但无marker等仍需要后续确认机制，不能声称永久或任意过期凭据都可完成撤销。复审为同一执行者。


## REAUTH-LOGOUT-RECOVERY（2026-09-11，用户确认重新登录原账号）

- 用户决定：旧凭据过期且记录已清理时重新登录。已实现requiresReauthentication持久状态，401后停止旧bearer发送；提示原账号重新登录，同issuer/user才尝试恢复。仅恢复204后ACK删除。
- 新生成pending记录保存ownerUserID、deviceInstanceID、requestedAt；仍只放独立Keychain。源码sender仅auth/logout与auth/logout/recover，阻止redirect，不用旧token登录或刷新。
- 后端新POST /auth/logout/recover需要当前ACCOUNT+session:bootstrap，事务内复验当前Principal。旧account记录存在时只撤销原refresh family且拒绝当前family；记录已按统一refreshExpiresAt清理时确认inactive，不撤销新family。iPhone恢复要求原device归属当前账号，按原requestedAt处理旧设备sessions/未消费tickets/旧Watch绑定及相关旧refresh families；新bootstrap和新Watch绑定保留，跨账号拒绝。
- 重复恢复无新增权限，completion标记使用原首次时间；不授予业务Principal，不清空事件/位置队列。
- 验证：后端全套190/190（/tmp/aed-reauth-all-tests.log）；后续扩充旧Watch撤销/新Watch保留断言，认证专项28/28（/tmp/aed-reauth-watch-protection.log）。TypeScript check通过；客户端DurableRevocationTests4/4运行通过（/tmp/aed-reauth-client-tests.log），含401持久状态、错误账号不发送、正确账号恢复后删除、旧bearer只发送1次。iOS generic build-for-testing通过（/tmp/aed-reauth-build.log）；OpenAPI解析与git diff --check通过。
- 未部署/未安装：真实Apple重新登录和线上recover联调未执行。本地闭环覆盖新格式记录；旧格式缺少owner/device/boundary元数据时仍保留待显式迁移，不推断原账号、不假确认。
- 备份 /Users/REDACTED/Documents/AEDResponse-local-baselines/reauth-revocation-20260911-005835/；逐文件回退本批源码/契约接线，保留Keychain记录；旧版本不理解requiresReauthentication或recover接口，回退不能当作撤销完成。无数据库结构迁移、无生产写入。复审由同一执行者完成。


## INTEGRATED-BOUNDARIES-RECOVERY（2026-09-11）

用户要求后端剩余用例、可靠通知、历史存储与跨端后台一起整改。本轮按事件创建→通知→存储选择→Watch生命周期推进；不改变路线/人数/AED等未决规则，不部署不触发真实求助。

| 工作项 | 本轮实际接管/修复 | 证据与剩余边界 |
| --- | --- | --- |
| 后端用例边界 | watch-event-creation.ts拥有创建事务、重放幂等、患者设备关联、激活通知和历史审计；service仅权限/时间校验及recruit/priority/query适配。原内嵌创建事务已停用 | 创建事务失败全回滚、ACK丢失后的重放测试通过。其他位置写入口和招募内部逻辑仍在service，不宣称全部迁移完 |
| 可靠通知 | status-confirmation-requested发送时复验当前confirmationId/PENDING/deadline；已回答旧提醒SUPPRESSED | 新测试修改前失败、修复后通过。创建后发件箱ACK丢失→服务对象重建→同message重发且事件仅1条通过；真实APNs未验证 |
| 历史存储 | StateReadView.select提供有界、脱离原状态的单collection选择；outbox取100条due不再复制全部事件/位置历史 | 本机50k历史/500通知扫描原全状态约48.03ms，新选择约1.59ms；0/1k/10k/50k各档重启计数一致。仍线性扫描collection，事务clone/validate和发送授权全状态读取保留；不能称存储性能整体已解决 |
| Watch/OS恢复 | lifecycle恢复前后、hasValidWatchSession快速路径和Fall权限回调增加session代次检查，旧回调不能操作新配对UI/继续后续恢复 | watchOS generic build通过。没有固定后台频率承诺，真实Watch/OS后台与完整跨账号位置补传尚未验收 |

- 验证：修改前本轮后端190/190；最终全后端193/193（/tmp/aed-integrated-backend-final.log）、TypeScript check通过。领域/存储专项80/80；旧提醒修复另有先失败后通过日志/tmp/aed-obsolete-prompt-before.log与after.log。
- 原生链：43 Phone +81 Watch +2真实本地HTTP/进程重启阶段通过（/private/tmp/aed-integrated-recovery-checks）；fixture已停止。该runner不包含WatchRuntimeModel运行测试，其变化仅由/tmp/aed-integrated-watch-build.log构建覆盖。
- 存储实验：/tmp/aed-integrated-storage.log，原始JSON在/var/folders/39/811t3lrx5779_h84h35lmxvr0000gn/T/aedresponse-storage-load-htekaV/result.json；50k档reopen约251ms、no-op事务约143ms，单次本地合成探针不代表目标负载SLA。
- 回退基线 /Users/REDACTED/Documents/AEDResponse-local-baselines/integrated-repair-20260911-091009/。按本轮差异恢复源码/测试/文档；新usecase模块可移除并恢复原入口，保留已提交事件/通知/历史数据。没有schema或生产迁移，不用代码回退替代数据恢复。
- 同一执行者复审真实差异、事务回滚断言、通知发送时授权和原状态隔离；未冒充独立审查者。git diff --check通过，未commit/push。
- 下一继续点：位置写用例和招募内部边界；完整跨账号位置历史补传故障注入；目标负载/积压与真实设备后台。上一组账号撤销/重认证修改仍未部署，不把本轮本地运行当线上验收。



## ROUTE-WATCH 收尾（2026-09-11，覆盖下方早期接线待办）

- 状态：本地实现与验证完成；未部署、未安装本轮候选版、未完成真实跨端验收。仓库根无 AGENTS.md，遵守用户提供的规则。保留已有工作区修改，无提交或推送。
- 路线权威：新增 AmapAedRouteProvider 接管配置 AED_AMAP_WEB_KEY 时的路线报价；事务外调用高德，事务内按当前精确输入读取匹配报价并提交任务。原几何 provider 仅用于未配置 Key 的参考环境，高德失败不切回几何报价。accept 等待报价后复验身份；tick 异步预热，不阻塞到期业务，报价就绪后才重排。
- 边界：GPS→高德坐标只作派生转换，原始定位事实不改；缓存成功15秒/失败5秒，最多2048项、256个待处理报价、4个并发任务。报价缓存不是持久业务权威，也不是位置有效性判定。尚未证明目标负载下性能。
- Watch：按用户批准的“手机可达但后端10秒无有效手机位置”规则，快照返回 fallbackAllowed，写入事务再次判定。既有幂等重放及合法终态历史保留。过期 candidate 重放不得提升为当前位置。准入变化403使用 fallback-admission-changed，客户端暂停采样、重新查询，保留待上传事实；普通权限错误仍独立处理。
- 最终后端 npm test：197/197，通过日志 /tmp/aed-route-watch-release-tests.log；npm run check 通过。原生 runner 43 Phone +82 Watch +2本地HTTP/重启阶段通过（/private/tmp/aed-route-watch-final2）；此后仅准入竞态改动由27项 WatchFallbackCoordinatorTests 覆盖（/tmp/aed-watch-admission-race.log）。最终 Watch generic Simulator BUILD SUCCEEDED（/tmp/aed-route-watch-release-build.log）。这些不是 Simulator运行或实机验收。
- 过程失败：首次原生编译误传 serverAllowsFallback 给上传payload，已移除；首次全后端因严格快照断言未包含新增字段失败，已更新期望并全量重测，未放宽断言。最终无已知新增失败。同一执行者复审 provider、事务接线、错误分类及测试证据，非独立审核。
- 候选包：/Users/REDACTED/Documents/AEDResponse-local-baselines/route-watch-release-20260911-095528/，含 manifest.json、backend-candidate.tar.gz 和 DEPLOYMENT-REVIEW.md；包含累计未部署后端整改，排除凭据。代码基线：route-integration-20260911-094354 与 route-watch-20260911-092848，均位于同一 baselines 目录。
- 回退：按上述快照逐文件恢复本批差异，不重置已有工作；无本批数据库迁移。保留业务事实/Keychain队列，代码回退不等于数据回退。远端部署前另备份代码、配置和一致SQLite，不能用旧数据库覆盖部署后的新事实。
- 下一步：取得现有 Azure 联调后端候选包部署授权后，配置仓库外 Key，再进行 iPhone16 原生联调；真实 Watch/Fall entitlement、OS后台、真实APNs及目标负载仍待验证。原始授权明确排除部署，因此不能把“收尾”解释为已授权更新远端服务。


## Azure 路线/Watch 候选部署与 iPhone16 验收进度（2026-09-11）

- 用户本轮明确确认部署。已切换 /opt/aedresponse/current → /opt/aedresponse/releases/route-watch-20260911-095528；服务在02:07:40 UTC重启，active、NRestarts=0。候选SHA256 731b8093a540c3f213bbdf1ef6aa0aeacd46b547e3baa3bb2122cc944fe462c6。补充4个Windows脚本供既有测试读取，未变更候选业务源码。
- Azure Node24.18.0：npm ci（better-sqlite3原生编译）、npm test 197/197、npm run check、npm run build均通过。隔离测试未连接业务数据库。公网health200，Apple challenge在loopback/Caddy TLS/电脑无代理直连均201。Mac默认网络另一次SSL失败、iPhone Wi-Fi请求-1001超时，不能据此宣布手机登录通过。
- 备份 /var/backups/aedresponse/route-watch-20260911-095528/ 包含旧current完整目录、backend.env和停服后一致state.sqlite。备份及现有数据库integrity_check=ok；事件1→1、历史位置批次311→311、位置回执95→95。原配置逐项保持，新增受限高德配置；上传暂存Key已删除，未写入候选包/日志。
- Azure调用真实高德：合成北京坐标，转换1次+步行3次HTTP200；启用的provider返回AVAILABLE，walking921秒、ETA981秒。只运行派生报价，无业务写入、真实求助或通知。不是手机端真实路线验收。
- iPhone16：新ControlledTests签名build成功、覆盖安装成功、原生启动成功。诊断显示Wi-Fi路径、authenticated=false、agreementsComplete=false、Apple challenge请求超时(-1001)。未执行卸载/退出/替用户Apple确认；已请用户关闭Wi-Fi改蜂窝后本人完成登录。未确认手机登录、事件恢复或Watch运行通过。
- 本地证据与ROLLBACK.sh：/Users/REDACTED/Documents/AEDResponse-local-baselines/route-watch-release-20260911-095528/。回退仅切代码和配置，保留部署后事实；若需数据恢复必须单独评估新增事实，禁止直接覆盖数据库。无Git提交/推送。
- 下一步：观察iPhone16蜂窝原生challenge/login/session/恢复请求结果；真实Watch/OS后台及完整路线救援验收仍未完成。不把部署健康检查当跨端闭环。


## iPhone16 蜂窝正式登录实测（2026-09-11 02:11 UTC）

- 用户完成本人Apple登录。原生日志确认蜂窝请求：auth/apple/challenges 201、auth/apple 200；Keychain原条目不存在后新增status=0，登录凭据保存成功。
- session/bootstrap先403后201，随后SOCKET_CONNECTED和SERVER_READY_RECEIVED，GET events 200。与现有设备绑定冲突恢复路径相符，但日志未输出403 problem内容，不能单凭状态码认定具体冲突类型。
- responder-position PUT200及POSITION_ACK；presence PUT200；nearby-volunteers GET200。后端只读核对accounts/devices均4，位置回执97（部署时95），presence回执61（此前59），quick_check=ok。未读取或输出账号身份/令牌/坐标内容。
- 这证明本次真实手机蜂窝登录、业务会话建立、实时连接、事件查询及位置上传确认通过；不证明非空活动事件恢复、进程重启后登录保持、真实救援路线或Watch后台闭环。
- 证据：仓库外route-watch-release-20260911-095528/iphone16-login-redacted.json。此前Wi-Fi超时未复现定位原因，不归因于已确认服务器缺陷。


## 17 Pro UI自动化实机抽验（2026-09-11）

- 用户要求连接17 Pro进行UI自动化。实际设备D3DF0C66-AB47-562E-8978-DFA10FEB5BA9 connected，Xcode destination [REDACTED_UDID]。
- AEDResponseTestHost Debug，运行现有testDefaultActionHidesSafeTestDialer及testSettingsShowsAccountConnectionCoordinatesAndSystemSettingsOnly；2/2通过、0失败，实际测试19.7秒。完成启动、点击设置、滚动与界面断言，导出两张截图。
- 使用UITestMode本地夹具及TestHost禁止联网路径，不是真实Apple登录/救援/Watch验收。未改测试断言或业务代码。测试后覆盖恢复AEDResponseControlledTests联网版，未卸载或执行退出账号。
- 证据：/Users/REDACTED/Documents/AEDResponse-local-baselines/17pro-ui-20260911/，含test.log、result.xcresult与screenshots。无Git提交/推送。


## 指定Apple双机测试入口与送达复核（2026-09-11）

- 用户批准16患者→17 Pro响应者，只通过服务器核对16。新增可选AED_SIMULATION_APPLE_DEVICE_IDS：必须配置私有IPC、恰好两个不同UUID；Apple provider且设备在名单内才允许创建SIMULATED_TEST。未启用CONTROLLED_TEST账号签发，未修改Apple登录校验/普通事件权限/位置有效期。原双设备user/device隔离沿用。
- 修改：backend/src/config.ts、server.ts、service.ts；新增配置与完整Apple测试事件/第三设备拒绝/幂等/恢复/正常接受测试。新增用例修改前失败，修改后本地199/199、Azure最终199/199、check/build通过。首次上线校验误拒大写UUID，服务自动回退；补大小写和等价重复测试后按真实配置预检并部署成功。此启动失败为本轮新增，已修复，不归为原有失败。
- 源码基线：/Users/REDACTED/Documents/AEDResponse-local-baselines/apple-pair-test-entry-20260911/；远端旧代码/配置/一致数据库：/var/backups/aedresponse/apple-pair-20260911/。当前release /opt/aedresponse/releases/apple-pair-20260911。回退代码和配置，不能覆盖部署后事实。
- 真实位置准入核对：两机约4米，16定位约292秒、17 Pro约35秒，精度约36/15米，均满足既有规则。通过私有IPC创建测试事件b5a64c01-f38f-4f13-8bb2-7c9ae6e0040b，2026-09-11T02:40:34.873Z提交。仅指定17 Pro产生delivery，02:40:35.069Z为VIEWED，02:41:04.873Z到期，随后EXPIRED，无接受。
- 用户明确反馈未看到任何请求。故“界面展示通过”撤回：仅确认客户端回执到达，视觉展示/用户感知验收失败或证据冲突。ResponderDashboardView外层和请求卡onAppear会触发markResponseRequestViewed；此生命周期回调不证明用户看到，尚未复现具体遮挡/页面/后台原因，不直接判定根因。
- 已要求用户说明17 Pro当时所在页面/前后台，并在16结束测试。不得重发新事件或改30秒期限来掩盖失败；现有事件是否终态需继续查询。未完成真实Watch/Fall/APNs后台通知验收。


- 追加用户反馈：17 Pro当时位于行动页，不能以后台或其他页解释。已请求恢复17 Pro调试连接以核对可见UI；16不要求连接。外层/卡片onAppear仅是静态线索，未据此改业务或声称已找到根因。临时Apple名单及私有IPC配置已关闭；保留当前测试事件和历史，需患者明确结束后再验收下一次。

- 17 Pro重新连接后新增显式opt-in testOptInLiveScreenEvidence：只激活联网ControlledTests并截屏/读取控件树，不调用UITestMode，不点击接受/结束。使用仓库外xctestrun把目标设为联网包，build-for-testing与实际test-without-building通过。截图10:48为行动页中立待命、无请求卡；采集在30秒请求到期后，不能据此复现请求窗口内的问题。截图/控件树位于基线live-screen/。临时测试配置已删除、服务健康正常；现有ACTIVE事件待16患者端明确结束，之后才可重试。

## Xcode签名故障处理（2026-09-11，跨端验收暂停）

- 当前用户要求先修Xcode，未继续发送测试事件。Xcode完整AEDResponse scheme原显示Personal Team/Apple登录profile/17 Pro注册/Watch AppAttest/Fall Detection错误。
- 通过xcodebuild -allowProvisioningUpdates -allowProvisioningDeviceRegistration刷新签名，Xcode Apple Accounts下载profiles并正常重启。GUI团队已从Personal Team刷新为yuzhang cao；未退出账号、删除证书或关闭entitlement。
- 完整AEDResponse Debug真机build仍失败，但当前命令行仅剩Fall Detection capability未获Apple授权两条错误。AppAttest entitlement是有效官方key，保留；Fall权限不删除，不将手机方案成功冒充完整Watch成功。
- 发现ControlledTests Debug/Release Bundle ID在工程里变成dev.codex.aedresponse.test-host，与既有安装及后端Apple audience不一致；先保存当前pbxproj后将这两处恢复dev.codex.aedresponse.testhost，保留其他用户修改。project.yml原本即为正确值。修正后17 Pro目标命令行build成功，签名保留Apple登录。
- GUI active scheme选择AEDResponseControlledTests（联网手机方案）；不修改完整scheme的Watch依赖。原工程、日志在/Users/REDACTED/Documents/AEDResponse-local-baselines/xcode-signing-20260911/。git diff --check通过。回退本轮仅恢复备份中的两处Bundle设置，但恢复错误Bundle会破坏既有登录兼容性。
- 未获Fall审批仍是外部阻塞。之前测试事件b5a64c01-f38f-4f13-8bb2-7c9ae6e0040b最后确认ACTIVE，未代用户关闭；临时双机IPC已停用。请求用户可见验收尚未通过。

