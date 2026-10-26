# 存储层重构最终方案（2026-09-11 定稿）

> 本文是权威实施方案，供实现者与评审者共用。
> 取代并合并：`docs/storage-refactor-review-2026-09-11.md`（评审）、
> `docs/phase1-standby-position-scoping-2026-09-11.md`（Phase 1 界定）。
> 阶段划分与验收标准经用户、GPT-6、我方三方两轮修订后定稿。

---

## 0. 本轮确定的更正（相对上一版）

| 项 | 上一版 | 定稿 |
| --- | --- | --- |
| Phase 1 写吞吐预期 | "300–500 次/秒，由 2.1 ms no-op 推出" | **撤回推导。** 用真实变更事务重测为 **2.88 ms/commit（fsync）**，存储层 1 实体真实提交 **248/s**；预期改为 **~250–350/s，只作预期不作承诺** |
| "全库遍历已消除"的验收 | "no-op 与真实变更差值收敛到 ~3 ms" | **该判据作废**，见 §0.1。改为**结构门槛**：访问范围与应用处理成本不随无关历史增长 |
| 影子校验 | "提交后跑 validateSnapshot" | 改为**提交前**，且明确它是**临时机制**，由隔离新旧对照**替代**（非补充） |
| 影子校验的生命周期 | 未界定 | **切换点 = 第一个历史集合不再完整常驻内存之前** |
| 启动路径 | Phase 2 的一条要求 | 提升为 **Phase 2.0 发布阻断项** |
| `reconcile()` | 只列为 Phase 1.5 | **Phase 1 顺手插桩**（改前改后各测一次），Phase 1.5 按访问范围验收 |
| group commit | Phase 3 | Phase 1 完成后**立即评估**（实测显示批量化几乎免费） |

### 0.1 为什么"差值约 3 ms"不能作为判据（GPT-6 的反例，已验证）

设 `T_noop(E) = aE + b`，`T_write(E) = aE + b + d`（`aE` 是两者**共有**的全库扫描，`d` 是真实写入额外成本），则：

```
T_write(E) − T_noop(E) = d        ← 与 E 无关，恒定
```

数值复现（`a=9e-6 ms/实体, b=0.29 ms, d=3.0 ms`）：

| 历史规模 | no-op | 真实写入 | 差值 | 简化吞吐 |
| --- | --- | --- | --- | --- |
| 1 千实体 | 0.30 ms | 3.30 ms | 3.00 ms | 303/s |
| 1 万实体 | 0.38 ms | 3.38 ms | 3.00 ms | 296/s |
| **10 万实体** | 1.19 ms | 4.19 ms | **3.00 ms** | **239/s** |

**即使每次事务仍全量扫描 10 万实体，差值和吞吐两个判据都照样通过。**
相减会精确抵消掉我们想检测的那一项。**该判据作废。**

---

## 1. 阶段划分与目标

| 阶段 | 明确范围 | 不得提前承诺 |
| --- | --- | --- |
| **Phase 1** | 受控增量事务、change-set 持久化、待命位置上传及其必要索引、提交前影子对照（临时）、`reconcile()` 插桩、空变更提前返回 | 不预先承诺 250–350/s 或"万人在线" |
| **Phase 1 → 2 边界** | 隔离新旧对照**先通过**，再替代事务内全量影子校验；分层实现禁止回退到全库物化 | — |
| **Phase 1.5** | 实时连接定点处理；其余高频设备/会话查询索引；剩余读写入口迁移；到期项查询优化 | 不因单接口变快就宣称全站容量达标 |
| **Phase 2.0**（阻断项） | 大历史库的**有界内存启动**、异常重启恢复、首次历史查询分页 | 不通过则 Phase 2 不得宣称完成 |
| **Phase 2 其余** | 历史证据持久化分层、有限缓存、分页查询、清除全量序列化缓存 | 不把"历史不进堆"视为两万在线已通过 |
| **Phase 3** | 依实测处理提交同步、磁盘、批量提交与扩展需求，再决定是否迁 PostgreSQL | 不预设必须换，也不预设一定不换 |

编号是实施组织方式，**不是硬性等待顺序**：Phase 1 涉及的索引立即做；
Phase 2 的数据边界现在就设计，避免新事务接口又把全历史依赖固定进去。

---

## 2. Phase 1 范围

1. **受控实体事务** `transactEntities(tx => ...)`：业务必须通过 `tx` 读取与修改，禁止直接改整棵树
2. **`tx` 契约**：按键读取（含未提交修改，且不泄露内部可变引用）／更新实体（仅复制被改实体，自动登记前后值）／追加证据（查重，禁止异内容覆盖）／完成后封闭／失败丢弃暂存且不污染已提交状态
3. **校验三拆**：`migrateLegacyState` / `validateSnapshot` / `validateChangeSet`；不删除 `validateState` 的规则，拆成可复用实体校验器
4. **增量持久化**：只序列化与保存变更实体；**相同内容不产生任何 SQL 写入**
5. **空变更提前返回**：在 flatten **之前**判定（当前实现是 flatten 之后，`store.ts:1453-1462`）
6. **本条路径的查询索引与收窄**（详见 §3）
7. **`reconcile()` 插桩**（详见 §6.3），**改前改后各测一次**
8. **开发/测试模式**：提交前执行旧版完整结构校验 + 历史前后比较（临时机制）
9. **插桩**：实体扫描／访问／复制／校验／序列化／SQL 写入／队列等待／实际提交次数

**不下调的不变量**：身份与幂等契约、证据不可改写、位置记录频率与秒槽要求、
状态迁移规则、`synchronous=FULL` 与 WAL、救助流程。

**本批不做**：实时层改造、其余索引迁移、历史分层、`synchronous` 变更、
group commit（Phase 1 完成后立即评估）。

---

## 3. 待命位置上传路径的真实 Δ（关键发现）

`PUT /api/v2/me/responder-position`（`updateResponderPosition`，`service.ts:3187`）
**在事务内并不只碰该设备**：

```ts
// service.ts:3262-3276  ← 事务内部
if (position.applied) {
  for (const event of Object.values(state.events)) {          // ← 遍历全部事件
    const refreshed = this.refreshRecruitmentForEvent(state, event, this.now());
```
```ts
// service.ts:4609-4620
4609  const previousAudience = coordinationAudienceDeviceIds(state, event);
4610  if (event.state !== "ACTIVE") { return { changed: false, ... } }  // ← 已结束事件白算一遍
4620  for (const delivery of Object.values(state.deliveries)) {        // ← 遍历全部投递
```

**成本 `O(事件数) × O(投递数)`**：P20 规模（100 事件 × 2,000 投递）≈ **每次位置上传 20 万次迭代**，
且发生在写事务内部、占用单写者队列。

因此 **只做实体级事务，这条路径仍不是 O(Δ)**。Phase 1 必须同时完成：

| 项 | 位置 | 风险 |
| --- | --- | --- |
| `coordinationAudienceDeviceIds` 改**惰性计算**（调用方只在 `changed` 为真时才用） | `service.ts:4609` | **零风险**，可直接做 |
| 移除事务外多余的 `store.read` 全量克隆（仅为算响应 `positioningTier`，事务内已有 device） | `service.ts:3283` | **零风险**，可直接做 |
| `deliveriesByEventId` 索引 | `service.ts:4620` | 中 |
| 事件相关性筛选（先做包围盒预筛）收窄事件循环 | `service.ts:3264` | 中 |

---

## 4. Phase 1 验收

### 4.1 容量门槛

**≥ 200 次/秒**，且必须满足：真实位置变更（新位置 + 合法新请求标识）、约定延迟目标、
失败率达标、队列不持续积压。

> **口径澄清**：248/s 是**存储层微基准**（251 实体隔离库、合成 `lastSeenAt` 变更、
> 无 HTTP／无鉴权／无业务逻辑／无招募扫描），**不是本接口的基线**。
> 本接口的真实基线是 **10.24 次/秒**（线上实测，54 用户）。
> 所以 10 → 200+ 是真实改善主张；但 **248/s 不是比较基准**，
> 且若最终只有 ~250/s，说明瓶颈已转为 fsync，应如实报告而非称为优化成果。

### 4.2 结构门槛（"全库遍历已消除"的**真正证据**）

> 定稿判据：**访问范围有界，且应用侧处理成本不随无关历史增长。**

固定用户、活跃事件、当前态规模与 payload；历史从 **1 千 → 10 万实体**。
**全部断言均针对"关闭影子校验后的正常路径"**；影子校验自身产生的全量操作
必须**独立标识**，不得混入正常路径的计数。

| 断言 | 要求 | 测试数据下的预期值 |
| --- | --- | --- |
| `validatedEntities` | 不随无关历史增长 | ≈ 5（**必须覆盖相关约束，不得为凑数量省检查**） |
| `serializedEntities` | 不随无关历史增长 | ≈ 2（与本次实际变化的业务实体对应） |
| `historyComparedEntities` | **无关历史的全量比较 = 0** | **0** |
| `fullStateClones`（**全部入口**） | 完整位置上传方法内全量克隆 = 0 | **0** |
| `batchLevelClones` | 不随无关历史增长 | **0** |
| `fullStateFlattens` | 不构造全状态 Map，也不换函数名全量找差异 | **0** |
| 业务扫描范围 | 不随无关设备、会话、历史数量增长 | 需覆盖实际经过的业务循环 |
| 耗时 | 同时报告完整方法 / 排队 / 事务 / 响应构造 | 见 4.3 |

三条必须同时成立，否则是假优化：

1. **`historyComparedEntities = 0` 绝不能被实现成"历史约束全部不检查"。**
   无关历史不做全量比较，但**受影响记录**的不可变规则仍须执行——
   位置批次不可改、通知的有限状态迁移、参与区间只能结束一次、删除请求不可改写，一条都不能少。
2. **`fullStateClones = 0` 覆盖全部入口**（事务 draft、规范化、响应读取），
   不能只要求事务内为 0，也不能靠"不再调用名为 `cloneState()` 的包装函数"达标，
   而放任裸 `structuredClone(完整状态)` 继续执行。
   必要的**单实体**隔离克隆仍可保留。
3. **"处理实体数 ≤ 10"只在纯待命、单设备场景成立**，且必须分别统计
   扫描 / 访问 / 复制 / 校验 / 序列化——只统计写集合会漏掉
   "扫描两万台设备、最后只写一台"的情形（§4bis 正是这种情形）。

### 4.3 成本归因（分段计时，边界互不重叠）

| 分段 | 说明 |
| --- | --- |
| 队列等待 | 排队时间 |
| 相关数据查找与业务判断 | 索引查询 + 业务分支 |
| 实体复制、增量校验、序列化 | 框架成本 |
| SQLite 事务执行 | 写 + 提交同步 |
| 内存状态与索引发布 | 提交后发布 |

比较 no-op 与真实写入时**使用排除排队的服务时间**；
**不得拿两组 P95 相减宣称得到某个阶段的 P95**。

**支持"瓶颈已转到持久化"的证据**：在 §4.2 结构条件成立后，SQLite 阶段占主要服务时间；
必要时用相同数据、SQL、索引、同步配置的**独立写入基准**进一步归因。
`~3 ms` 仅作为**当前机器上的观察值**保留为诊断信息，不是所有正确实现应收敛到的常数。

### 4.4 其余

| 项 | 要求 |
| --- | --- |
| 空变更 | 在**隔离测试**中测**本条操作**：本次写事务提交数 = 0，无全事件扫描，无无意义 revision 更新（不要求整个进程此时无其他提交或检查点） |
| 幂等 | 同 ID 同内容 → 返回既有结果且**不执行 UPDATE**；同 ID 不同内容 → **拒绝** |
| 正确性 | 影子对照 + 新旧对照 + 非法历史修改 + 回滚 + 重试 + 重启恢复全绿 |
| 持续性 | 报告内存峰值、队列等待、WAL 大小、长时运行结果，不能只报短时最高吞吐 |

**性能压测必须关闭影子校验，并在报告中标注开关状态。**

---

## 4bis. Phase 1 的"改前"基线（已实测，2026-09-11；口径已修正）

脚本 `backend/scripts/loadtest/probe-phase1-baseline.mjs`。
隔离库上一台**真实待命设备**走真实业务路径 `service.updateResponderPosition()`，
用无关历史撑到指定规模，每次只测**一次**上传并清零计数器。

### 修正说明（GPT-6 指出的两个口径缺口，已确认并修复）

| 缺口 | 修正 |
| --- | --- |
| 全量克隆只计了 `cloneState()` 包装函数，漏了 `normalizeState()` 内部的裸 `structuredClone`，也漏了**每批次克隆** | 改为**按调用点分类**的完整计数：`transactionDraft` / `normalization` / `storeRead` / `storeOpen` / `storeSeed` / `other`，批次级克隆单列 `batchLevelClones` |
| `serviceMs` 只包住 `store.transact()`，而事务之后的 `positioningTier` 全树读取**被计数却未被计时** | 拆成 `operationElapsedMs`（完整方法）/ `queueWaitMs`（排队）/ `transactionServiceMs`（事务）/ `postTransactionMs`（事务后到响应构造完成） |
| `SQL写入2` 混在一起 | 拆成 `businessEntityUpserts` / `businessEntityDeletes` / `revisionMetadataUpdates` / `commitCalls` 四个不同口径 |

### 修正后的基线

| 实体数 | validated | serialized | historyCmp | clones<br>txDraft | clones<br>norm | clones<br>storeRead | **clones<br>总计** | batch<br>Clones | flattens | bizRows | revision<br>Bumps | commits |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,166 | 999 | 1,168 | 331 | 1 | 1 | 1 | **3** | 330 | 1 | 2 | 1 | 1 |
| 11,472 | 9,831 | 11,474 | 3,277 | 1 | 1 | 1 | **3** | 3,274 | 1 | 2 | 1 | 1 |
| 56,421 | **48,357** | **56,423** | **16,121** | 1 | 1 | 1 | **3** | **16,116** | 1 | 2 | 1 | 1 |

| 实体数 | opMs<br>（完整方法） | queueMs | txServiceMs | **postTxMs** |
| --- | --- | --- | --- | --- |
| 1,166 | 59.92 | 0.00 | 52.31 | 7.38 |
| 11,472 | 511.29 | 0.01 | 434.85 | 76.24 |
| 56,421 | **6,078.84** | 0.01 | 3,731.61 | **2,178.80** |

**两处关键修正改变了结论：**

1. **全量克隆是 3 次，不是 2 次** —— `transactionDraft` + `normalization` + `storeRead` 各 1。
   GPT-6 的判断成立。另外还有一类此前完全未计的 **`batchLevelClones`，56k 实体下高达 16,116 次**。
2. **口径错位已修复。** 准确表述是：**本轮完整方法观测值比上一轮"仅统计事务"的观测值高约 63%**
   （6,078.84 比 3,735.31 高 62.74%）；反过来讲"原数字低估了 63%"是错的（3,735.31 比 6,078.84 低 38.55%）。
   先前的表只覆盖事务，把事务后的 `positioningTier` 读取排除在计时之外、却把它的克隆计入了计数。
   另外两轮不是同一次测量，其差值不能全部当成"同一次请求被遗漏的区间"。

### 这张表证明了什么

写集合只有 **2 行业务数据**，却发生：**3 次全树克隆 + 16,116 次批次克隆 + 48,357 次记录校验
+ 56,423 次序列化 + 16,121 次历史比较**。这就是"实际改动极少、却处理整个数据库"的完整量化。

**两条必须保留的边界**（GPT-6 提出，接受）：
- 6,078.84 ms 是**单次请求观测值**，不是 P95，不能直接换算稳定容量。
- 这些计数证明的是**存储层**的全量处理；`validated`/`serialized` 数值小**不代表** mutation
  没有先扫描大量设备。业务循环（事件 × 投递）的计数要在迁移这条路径时一并覆盖。

### 改后实测（窄访问器独立提交）

同一脚本、同一组规模。**计数类是确定性的，是本次提交的验收证据；计时类在大库档不可复现，见下。**

| 实体数 | clones<br>txDraft | clones<br>norm | **clones<br>storeRead** | **clones<br>总计** | collLoad<br>events | collLoad<br>deliveries | collLoad<br>assignments | deviceLoads | 业务行 | revision | 提交 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,166 | 1 | 1 | **0** | **2** | 1 | 0 | 0 | 1 | 2 | 1 | 1 |
| 11,472 | 1 | 1 | **0** | **2** | 1 | 0 | 0 | 1 | 2 | 1 | 1 |
| 56,421 | 1 | 1 | **0** | **2** | 1 | 0 | 0 | 1 | 2 | 1 | 1 |

**逐条对照本轮验收口径：**

| 验收项 | 预期 | 实测 |
| --- | --- | --- |
| 响应阶段 `store.read()` | 0 次，且不经辅助函数回退 | **0** ✅ |
| 完整方法全量克隆 | 3 → **2** | **2** ✅ |
| `transactionDraft` / `normalization` | 各 1，等待增量事务改造 | 各 1 ✅ |
| 集合重复克隆 | 每次计算每集合 ≤ 1 | events=1，deliveries=0，assignments=0 ✅ |
| SQL 行为 | 2 upsert / 0 delete / 1 revision / 1 commit | 一致 ✅ |
| 历史批次级克隆 | 仍可能保留，不宣称已优化 | `batchClones=16,116` 未变 ✅（如实保留） |
| 响应阶段耗时 | — | **2,178.80 ms → 0.10–2.20 ms** |

> **限制（必须随表报告）：** 本探针的合成历史里**没有事件**，因此
> `deliveries` / `assignments` 因 `some()` 短路**从未被加载**，表中为 0。
> 这两个集合的"加载一次即复用"由单元测试
> （`test/presence-access.test.ts`）覆盖，而不是由本表覆盖。

### 改后实测（增量事务迁移完成，"待命位置上传"路径）

同一脚本、同一组规模，纯待命单设备场景、关闭影子校验：

| 实体数 | validated | serialized | historyCmp | clones 总计 | batchClones | flattens | 增量路径 | 回退 | 业务行 | revision | 提交 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,166 | **1** | **2** | **0** | **0** | **0** | **0** | 1 | 0 | 2 | 1 | 1 |
| 11,472 | **1** | **2** | **0** | **0** | **0** | **0** | 1 | 0 | 2 | 1 | 1 |
| 56,421 | **1** | **2** | **0** | **0** | **0** | **0** | 1 | 0 | 2 | 1 | 1 |

| 实体数 | opMs（加索引前） | opMs（加索引后） | txServiceMs（后） | 响应阶段 |
| --- | --- | --- | --- | --- |
| 1,166 | 3.94 | 4.41 | 4.18 | 0.08 |
| 11,472 | 6.17 | 5.12 | 4.91 | 0.06 |
| 56,421 | 8.31 | **5.27** | 5.09 | 0.06 |

加索引后 48 倍历史增长只带来 4.41 → 5.27 ms（其中 fsync 实测约 2.9 ms），
即耗时已与历史规模基本无关。

**§4.2 结构门槛逐条对照（56,421 实体档）：**

| 断言 | 要求 | 改前 | 改后 |
| --- | --- | --- | --- |
| `validatedEntities` | ≈5，不随无关历史增长 | 48,357 | **1** ✅ |
| `serializedEntities` | ≈2，不随无关历史增长 | 56,423 | **2** ✅ |
| `historyComparedEntities` | 无关历史全量比较 = 0 | 16,121 | **0** ✅ |
| `fullStateClones`（全部入口） | 0 | 3 | **0** ✅ |
| `batchLevelClones` | 0 | 16,116 | **0** ✅ |
| `fullStateFlattens` | 0 | 1 | **0** ✅ |
| SQL 行为 | 2 upsert / 0 delete / 1 revision / 1 commit | 一致 | 一致 ✅ |
| 完整方法耗时 | 不随无关历史增长 | 6,078.84 ms | **8.31 ms** |

**实体数增长 48 倍，上述计数与耗时全部保持不变**——这正是"不随无关历史增长"要证明的。

> **`validatedEntities = 1` 的口径说明**：该计数统计**记录校验器**调用次数。
> 本次变更集是 2 个实体（device 更新 + 位置收据追加）；device 走记录校验器，
> 位置收据在原实现中**本来就没有记录校验器**（`validateState` 只对带
> `watchFallbackFact` 的收据做形状校验），它由**身份规则 + 不可变规则**覆盖。
> 因此 1 是正确值而非漏计；但读表时不要把 `validatedEntities` 当成"本次处理的实体数"。

**关于 §4.2 第二种测试（固定相关数据、增加无关事件与投递）：**

本表的合成历史不含事件，因此它只覆盖第一种测试。第二种测试由
**投影索引**解决，并已在单元层测量（`test/state-projections.test.ts`）：

- 新增 `ProjectionRegistry`（`src/state-projections.ts`）：投影是**单实体的纯函数**，
  **加载后惰性全量重建一次**，之后**只按变更集增量维护（O(Δ)）**，
  读操作只在**工作集**上遍历，不随历史增长。
- `activeRecruitingEvents` 投影索引"ACTIVE + RECRUITING"事件，
  并携带患者位置与当前招募半径，因此**无关事件由算术排除、根本不被读取**。
- 第二种测试实测：已结束事件从 **10 → 10,000**，索引规模恒为 1，
  且对某个已结束事件的增量提交只触发 **1 次派生**（不遍历集合）。

**安全网（已实测有效）**：投影决定"是否刷新招募"，索引过期会**静默漏掉真实更新**。
因此开发/测试模式下 `relevantRecruitingEventIds()` 会**同时用直接扫描算一遍**，
两者判定不一致就抛错。**故意把投影改成索引为空后，集成测试出现 3 项失败**
（`active recruitment projection disagrees with a direct scan`），确认这张网是活的。
生产模式下该对照关闭。

**仍然剩余的边界：**

- **投递按事件索引已完成。** `ProjectionRegistry` 新增**分组投影**
  （`registerGrouped` / `readGrouped`）：按派生分组键把实体归组，
  例如"某个事件的全部投递"。首个消费方是 `acceptedDeviceIds()`——
  它原先 `Object.values(state.deliveries).filter(d => d.eventId === eventId)`，
  现在只走该事件的投递组。该结果喂给 `presenceView().positioningTier`，
  因此同样加了**索引/扫描一致性安全网**（开发/测试模式），
  **故意把投递索引改成空索引后集成测试出现 5 项失败**，确认网是活的。
  分组维护实测覆盖：新增成员、**跨组移动（旧组不留残余成员）**、删除、空组裁剪。
- **招募链本身仍需迁移。** `refreshRecruitmentForEvent()` 有两处全集合扫描：
  ① `Object.values(state.deliveries)` —— **已具备 `deliveriesByEventId` 索引，可直接消费**；
  ② `Object.values(state.devices).sort(...)` 逐个调用 `createDeliveryIfEligible()` ——
  这是**招募圈候选计算**，在 2 万设备规模下是每次刷新 2 万次设备访问，
  **需要一个地理候选索引（网格/geohash 分桶）才能收窄**，属于本路径最后一块。
  在此之前，确有相关事件时仍走整树回退（`recruitmentFallbackRuns`），保留全部原有保护。
- `pruneReceiptsInTransaction` 对收据集合仍是**无克隆的谓词遍历**（不复制，但仍逐条访问）；
  收据按设备索引尚未做。

### 大库档计时不可复现（新发现）

同一台机器、同一脚本，56,421 实体档的 `transactionServiceMs` 三次运行分别是
**3,735.31 / 3,731.61 / 6,820.81 ms**（后一次高 83%）。因此：

- **计数类结论是确定性的、可复现的**，是本次提交的验收依据；
- **计时类在大库档必须重复运行取分布后才能引用**，单次观测值不得换算成容量；
- 上表中响应阶段的量级变化（约 2.2 s → 亚毫秒级）方向明确，但具体数字须重测确认。

### 差额归因：`unattributedMs` 已闭合

上一版残留 168.42 ms 未解释。根因是残差公式**漏减了事务自身的排队与执行时间**
（它们位于 `preTransactionMs` 与 `drainMs` 之间），于是把事务时间错误地显示成"未归因"。
现由存储层提供 `lastTransactionQueueWaitMs` / `lastTransactionServiceMs` 后：

| 实体数 | opMs | preTx | queue | txService | drain | publish | response | **unattributed** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1,166 | 37.09 | 0.10 | 0.00 | 36.84 | 0.04 | 0.00 | 0.10 | **0.01** |
| 11,472 | 446.92 | 0.16 | 0.00 | 446.57 | 0.04 | 0.00 | 0.12 | **0.01** |
| 56,421 | 6,849.79 | 26.70 | 0.00 | 6,820.81 | 0.05 | 0.00 | 2.20 | **0.02** |

分段之和与完整方法一致（误差 < 0.02 ms），残留归零。
`presenceAccessLoadMs` 是 `responseMs` 的子阶段，**不重复计入总和**。

### 插桩自身成本（A/B 实测）

`SQLiteStateStore.transact()` 内加了开关，关闭时**不执行任何计时系统调用**。

**三种模式必须分清（本轮只实现了前两种）：**

| 模式 | 计时 | 循环内结构计数 | 本轮 |
| --- | --- | --- | --- |
| 结构诊断模式 | 开 | 开 | 已实现（结构门槛在此模式测） |
| 当前性能模式 | 关 | **仍开** | 已实现（吞吐测在此模式，**不等于"完全关闭插桩"**） |
| 无插桩基准 | 关 | 关 | **未实现**，本轮不重写指标系统 |

| 模式 | 中位（251 实体，数据变更事务） |
| --- | --- |
| 插桩 ON | 5.030 ms |
| 插桩 OFF | 4.740 ms |
| **开销** | **+0.290 ms / 事务（+6.12%）** |

**这是不可忽略的，因此：**
- **结构门槛（计数归零）必须在结构诊断模式下测**；
- **吞吐门槛在当前性能模式下测，或明确披露开销**；
- 报告必须注明插桩状态，改前/改后必须用**同一状态**对比；
- **不要把 0.290 ms 或 6.12% 统一套用到其他规模或路径**——这是 251 实体单点差分，
  外推到不同规模/不同代码路径没有依据。

> 未加开关的部分：`validate` / `flatten` / `history` 循环内的整数计数器。
> 为它们逐条加分支会比自增本身更贵，故保留。
> **"约 0.06 ms、可忽略"目前仍是未经测量的估算**，不能当作已确立结论，
> 也不能据此认为它在优化后的毫秒级路径中同样可以忽略。

---

## 5. Phase 1 → Phase 2 边界与等价性验证

### 5.1 切换点

| 阶段 | 等价性验证方式 |
| --- | --- |
| Phase 1 开发、测试路径 | 可临时构造全量候选状态，**提交前**运行完整结构校验 + 历史前后比较 |
| **进入 Phase 2 之前** | **隔离的新旧实现对照测试必须已可运行并通过**；不得先撤旧安全网、以后再补替代机制 |
| Phase 2 开始分层后 | 分层实现停止事务内全量物化，由隔离新旧对照承担等价性回归 |
| 长期保留 | 提交前增量校验、证据写入约束、幂等与故障恢复测试（**不被替换**） |

**具体切换点：第一个历史集合不再完整常驻内存之前。**
从这一刻起，分层实现的**开发构建也不得偷偷回退到 `materializeFullSnapshot()`**。

旧版校验代码保留在独立参考实现/测试工具中。**参考测试必须保留两套机制**：
结构检查（`validateState`）与历史不可改写检查（`assertAppendOnlyHistory`），不能只留前者。

### 5.2 两类测试必须分开

| 类别 | 规模 | 内容 |
| --- | --- | --- |
| **等价性测试** | 旧实现能承受的规模 | 固定时间/随机标识/外部输入，对比相同命令的返回结果、拒绝行为、业务状态与证据内容。**新旧存储结构不同后，比较规范化后的业务结果，不要求数据库表或 JSON 字节相同** |
| **大规模测试** | 7.2M 秒槽级 | **只运行分层后的实现**，验证内存边界、重启恢复、历史分页与业务不变量，不要求旧实现装下整个大库 |

> **限制**：隔离数据库不会自动让旧实现能承受 720 万条秒槽。

---

## 6. Phase 1.5 验收契约

### 6.1 结构性门槛

| 测试 | 门槛 |
| --- | --- |
| 单连接鉴权 | 不遍历其他连接，不重建全连接 Map |
| 固定目标设备的定向发送 | 访问范围只含目标设备对应连接；**无关连接访问数 = 0** |
| 会话撤销 / 设备失效 | 定位并处理受影响连接；撤销生效后新授权与发送检查拒绝该身份 |
| 设备、会话查询 | 高频定点路径不再扫描全集合；**索引维护也不得每次重建全集** |
| 正常业务路径 | 全量 `reconcile()` 重算次数 = 0；确有必要的全量修复另行隔离 |

### 6.2 性能门槛

固定目标连接数、请求率与数据条件，**增加无关连接数**，定向操作内部处理
**P95 变化 < 20%**，同时上述访问范围断言保持成立。
连接规模档位：**500 / 5,000 / 20,000**。

> 结构测试可先用**受控连接注册表**；**真实两万 Socket 压测是另一项测试**，前者不算后者。
> 真正向全部连接广播时，访问量随接收者数量增长是合理的；
> 要消除的是"发送给少数人却检查全站连接"。

另需**事件循环延迟**测量（`monitorEventLoopDelay()`），判断同步计算是否阻塞其他请求。
**函数耗时与事件循环延迟都不得冒充"该函数消耗的 CPU 时间"。**

### 6.3 `reconcile()` 插桩（Phase 1 就做，改前改后各测一次）

| 指标 | 用途 |
| --- | --- |
| 调用次数，按固定调用点分类 | 区分鉴权、定向发送、连接变化等来源 |
| 单次耗时 P50/P95/P99 及累计耗时 | 区分尾延迟与总开销 |
| 实际访问连接条目数 | 直接确认是否每次扫描全部连接 |
| 新建 Map 次数、插入条目数 | 区分容器分配与条目处理成本 |
| 发送操作数、目标连接数、实际消息数 | 测出发送调用与消息扇出的真实关系 |

**约束**：统计条目数**嵌入已有循环**，不得为插桩再调一次 `Object.values()`；
用聚合计数与直方图；**不按每个连接输出日志**；**不使用用户 ID 作为指标标签**。

> 必须改前改后各测一次：存储瓶颈缓解后，实时层实际收到的调用量可能改变，
> 不能只看旧版本低吞吐时的占比。

---

## 7. Phase 2.0（发布阻断项）

**目标命名**：正常启动、异常重启与迁移**均不要求构造全量历史状态树**。

正常启动只加载必要的当前态与索引，历史按需读取。
需要重建投影或迁移旧数据时采用**有界批次**处理，
**不得借"恢复模式"重新建立整棵历史树**。
分批扫描可能仍需处理全部历史，但**处理全部历史 ≠ 同时把全部历史放进内存**。

### 7.1 现状（已核对）

启动路径先后构造多套全量表示：

| 步骤 | 代码 | 产物 |
| --- | --- | --- |
| 1 | `stateFromItems`（`store.ts:1247`）逐行 `JSON.parse` 全部 payload | 全量对象树 |
| 2 | `validateState(raw)`（1268）→ `normalizeState` 内 `structuredClone`（243） | 第二套全量表示 |
| 3 | 构造函数 `cloneState(initialState)`（1298） | 第三套 |
| 4 | 构造函数 `flattenState(this.state)`（1299） | 全量序列化结果 |

> **表述收紧**：这是**先后构造多套全量表示**，
> 不能仅凭调用顺序认定"三棵对象树与一份字符串副本必然在峰值时同时存活"——
> 引用释放与 GC 时机影响实际峰值。但这不改变"存在严重全量内存依赖"的结论。

**不能只删除最后两步**：只要第一次 `JSON.parse` 仍把全部历史装进状态树，Phase 2 就没完成。
`flattenedState` 在旧实现中仍是**差异比较基准**，不能在使用方迁移前孤立删除——
它应**随 change-set 持久化一起退出**，而不是直接注释掉。

### 7.2 首个验收测试

固定用户、活跃事件与当前态规模，逐步扩大历史，最终使用 **720 万条秒槽对应的真实批次结构**。
**必须分别记录秒槽数、批次数与 payload 字节数，不得混用**（一个批次含多条秒槽）。

| 场景 | 必须证明 |
| --- | --- |
| 正常启动 | 不全量解析历史，不重建全历史字符串缓存 |
| 非正常退出后重启 | 已提交事实、当前态与待处理任务恢复正确，内存仍有界 |
| 启动后的首次历史查询 | 分页返回，不因首次访问触发全库加载 |
| 旧格式迁移 | 有界处理，可恢复或安全重试，不靠整库物化完成 |

**内存看启动到就绪全过程的峰值**，不只看启动完成后的 `heapUsed`。
记录 cgroup `memory.peak`、`memory.events`，辅以进程 RSS 与 V8 堆指标——
**它们反映不同范围的内存，不能相互替代**。

> **此项不通过，Phase 2 不得宣称完成。**

---

## 8. 尚待实测的项

| 项 | 状态 |
| --- | --- |
| Phase 1 后真实写吞吐 | **未验证。** 250–350/s 是预期，须在同一 Azure 环境、同一持久化配置下实测 |
| 248/s 是否可重复 | 单次测量；需重复确认，且**它是存储层微基准，不是接口基线** |
| `reconcile()` 真实调用率与耗时 | **未测。** 靠 Phase 1 插桩回答，不再靠推算争论 |
| 每条位置记录的实际内存占用 | 200–400 字节是**假设**；需测量（含共享与重复缓存） |
| 每用户内存"单价" | 20 KB/用户是 54→10,504 区间内的**增量斜率**，非固定单价；cgroup 内存含文件页缓存/内核/TCP 缓冲，需拆分 anon 与 file |
| `flattenedState` 实际占用 | 未单独测量 |
| group commit 收益 | **未验证。** 依据是"50 实体提交仅比 1 实体多 1.12 ms"，需实测 |

---

## 8bis. 招募链迁移：已完成的索引件与两个新发现

### 已完成

| 件 | 状态 |
| --- | --- |
| `deliveriesByEventId` 分组索引 | ✅ 已建，已消费（`acceptedDeviceIds`），有一致性网 |
| 设备地理索引 `DevicePositionIndex` | ✅ 已建（属性测试：索引结果 ⊇ 暴力扫描，零遗漏），已消费（`getNearbyVolunteerSummary`），有一致性网 |
| 招募链改走 `transactEntities` | ❌ **未做**，`recruitmentFallbackRuns` 仍计数 |

### 发现一：招募候选计算的真实复杂度是 O(设备 × (任务 + 投递))，不是 O(设备)

`eligibleResponderDevices()`（`service.ts`）逐台设备调用 `isEligibleNearbyResponder()`，而后者：

- 经 `isEligibleResponderDeviceBase()` → `Object.values(state.assignments).some(...)` —— **每台设备全扫一遍任务**
- 自身 `Object.values(state.deliveries).some(...)` —— **每台设备全扫一遍投递**

外层还有 `recruitmentPotentialDevices()` 的过滤器逐台调用 `deliveryForUser()`，
而 `deliveryForDevice` / `deliveryForUser` **各自都是全量投递扫描**。

P20 规模：`20,000 × (2,000 + 2,000) ≈ 8 × 10⁷` 次访问 / 每次刷新，
而每次命中相关事件的位置上传都会触发一次刷新。**这比先前估计的 `O(设备)` 严重两个数量级。**

需要三个索引：地理（已有）、投递按事件（已有）、**任务按事件（尚缺）**。

### 发现二（关键约束）：派生索引不能在"正在改这批数据的事务"内部读取

已尝试把地理索引接进 `eligibleResponderDevices`，**集成测试立刻失败**：
一个本应发出的 offer 数量为 0。

根因：**索引是在提交之后维护的**。事务内部读取索引时，它**不包含本事务刚写入的实体**——
刚上传位置的那台设备不在候选集里，于是永远收不到 offer。

**已还原**，并把该约束写进代码注释：

> 只有当事务能同时提供**自己的变更集**、由调用方与索引结果取并集之后，
> 这里才可以用索引。

这条约束同时决定了招募链迁移的正确形态：
**`transactEntities` 必须把 change set 暴露给调用方**（目前只在 seal 之后才产生），
否则任何"事务内 + 依赖索引"的读取都会静默漏数据。

### 8bis.1 该约束的第二次实测命中（2026-09-12，提交 1 迁移 `acceptedDeviceIds` 时）

上面那条约束不是理论风险，它在提交 1 里**又命中了一次**，而且这次是我自己引入的。

迁移 `acceptedDeviceIds` 到 `RecruitmentContext` 时，我把已有的投递索引缝
（`acceptedDeviceLookup()`）装进了**唯一的** `this.recruitmentContext(state)`，
理由是"让原本用索引的调用点保持不变"。看起来是保守做法，实际是**扩大**了索引读取面：
原本只有 `presenceView` / `pruneExpiredCurrentPositions` 两个只读点用它，
改完后 `replanAssignments` 等**写事务内**的调用点也拿到了它。

后果：ACCEPT 路径上，`replanAssignments` 用已提交索引去查**本事务刚创建**的投递，
查不到 → `acceptedDeviceIds` 返回空 → **响应者接受了 offer 却没有生成任何 assignment**。

实测征候：`npm test` 从 274 全绿变成 **33 项失败**（`simulation.test.ts:157`
`tasks.length` 期望 1 实得 0，以及全部协同/招募类用例）。
修复后重新全绿 274/274。

修法不是"把索引删掉"，而是**把两种语义拆成两个具名入口**，
让"提交态读"这个前提写在名字上、无法被顺手复用：

- `recruitmentContext(state)` —— 读**草稿**，无索引，写事务内唯一可用者；
- `committedRecruitmentContext(state)` —— 读**已提交索引**，只允许只读调用点使用。

**给提交 2 的结论**：`TxRecruitmentContext` 不能只是"把索引接上"，
它必须显式持有事务变更集并按 8ter 的并集规则合并；
任何"直接复用 committed 上下文"的写法都会重复本次事故。

### 8bis.2 上下文语义边界（已冻结，2026-09-12）

上面那节把事故讲清楚了，但"靠调用者记得什么时候不能用索引"不可靠。
所以边界**不是注释，而是类型 + 运行期断言 + 可执行的编译期锁**，均已落地：

| 模式 | 工厂 | 允许读 | 谁可以用 |
|---|---|---|---|
| `draft` | `draftRecruitmentContext(state)` | 传进来的对象本身（事务内即草稿） | **事务内唯一可用者** |
| `committed` | `committedRecruitmentContext(state, { deliveriesOfEvent })` | 已提交状态 + 已提交索引 | 只读调用点（presenceView、位置回收） |
| `transaction` | 提交 2 实现 | 已提交索引 ∪ 本事务 staged delta | 事务内（Phase 2） |

关键设计：**draft 工厂不接受任何索引参数**。
上一版是"一个工厂 + 可选索引"，于是一次善意的统一复用就把索引铺到了 ACCEPT 事务里。
现在这个错误**无法被表达**——没有参数可传——而不是"被劝阻"。
`committedRecruitmentContext` 的索引则是**必填**的：没有索引的 committed 上下文
只是换了个误导性名字的 draft 适配器。

三条防线，各自覆盖对方覆盖不到的地方：

1. **类型**：`DraftRecruitmentContext` / `CommittedRecruitmentContext` / `TxRecruitmentContext`
   带 `readonly mode` 品牌字段。事务内 helper 声明 `ctx: DraftRecruitmentContext`，
   把 committed 上下文传进去是**编译错误**。
2. **运行期**：`assertDraftContext(ctx, caller)` 用于那些必须同时服务只读调用点、
   因而无法在签名上收紧的共享 helper（如 `acceptedDeviceIds`）——
   类型系统在那里帮不上忙，只有调用方知道语义。
3. **可执行的编译期锁**：`test/recruitment-audience.test.ts` 使用
   `// @ts-expect-error a committed context is not draft-compatible`。
   已实测：把品牌字段放宽回 `RecruitmentMode`，`npm run check` 立刻报
   `TS2578: Unused '@ts-expect-error' directive`。
   这样"记得别在事务里用 committed"就变成**构建失败**，
   而不是代码评审时的注意力问题。

行为锁（`test/recruitment-audience.test.ts`，8 项）锁的是**可观测的 audience**，
不是内部实现：患者侧-only；accepted responder 加入且患者在前；
同一 identity 多设备仍按"先排序后去重、字典序最小者存活"；
事务内刚 ACCEPT 的 draft 必须立刻可见；
以及**把事故本身固化成测试**——committed 上下文读陈旧索引时，
accepted responder 会整个消失，这正是 33 项失败的同一条因果链。

已迁移（提交 1，叶子→根）：`acceptedDeviceIds`、`patientViewerDeviceIds`、
`coordinationAudienceDeviceIds`、`isEligibleResponderDeviceBase`。
DI 边界（`event-resolution`、`responder-exit`、`status-confirmation`，
以及 simulation / watch 的对象）一律保持 `(state, event) => …` 原签名，
由 service 内部包一层构造上下文——
**外部业务模块至今不知道 `RecruitmentContext` 存在**。

### 8bis.3 `isEligibleResponderDeviceBase` 迁移（2026-09-12）

**签名**：`(state, device, now, requireStableUser?, precomputedBusyIdentities?)`
→ `(ctx, device, now, …)`，其余逐字未动：条件顺序、`now` 的用法、
`precomputedBusyIdentities` 的短路语义全部保持。

**只换了两处访问入口**，都在 `if (!precomputedBusyIdentities)` 块内：

- `Object.values(state.assignments).some(...)` → `ctx.hasActiveAssignmentForDevice(device)`
- `this.deviceIsActivePatient(state, …)` → `ctx.isActivePatient(…)`

第二处是**超出字面指令的一步，理由需要记录**：不把 `isActivePatient` 提到上下文上，
就无法真正去掉 `state` 形参，只能写成 `(state, ctx, device, now, …)`——
那会让谓词持有两个真相来源，且事务适配器会拿到一个它不该读的 state 对象。
它和 `hasActiveAssignmentForDevice` 属于同一类问题（"这台设备是否已在别处承担角色"），
所以放在缝上而不是缝旁边。这符合"除非它是完成 context 抽取的必要条件"。

**类型没有收紧**：仍收公共 `RecruitmentContext`，不收 `DraftRecruitmentContext`。
理由与上一节一致——它同时服务事务内调用与只读决策调用；
"本次调用必须看见未提交状态"由**调用方**负责，事务路径传 draft，只读路径可传 committed。

**未顺手统一**：`isEligibleResponderDeviceBase` 内的小规则（`hasAllBootstrapAgreements`、
`currentResponderPosition`、`responderPositionSampleIsFresh`）一律不动。
提交 1 的差分会因此只剩"访问方式"这一个变量。

**行为锁**（`test/responder-eligibility.test.ts`，6 项）：

- 基准：完全合规设备 → `true`
- **truth table：14 行拒绝原因，每行只改动基准的一个条件**，逐行断言 `false`
- assignment 5 情况：无 assignment / 本设备有活跃 assignment /
  同 identity 另一设备有活跃 assignment / assignment 已退出 / 所属事件非 ACTIVE
- identity：未绑定设备与已绑定孪生设备分别判定，且活跃 assignment 不会
  从绑定设备波及未绑定设备
- 时间边界：`600000-1` → 新鲜，`600000` → **仍然新鲜**，`600000+1` → 过期；
  时钟偏移边界 `-120000` → 允许，`-120001` → 拒绝
- **提交 1 诊断**：1000 条无关 assignment + 无匹配设备时，
  `assignmentCandidatesVisited` 必须 **= 1000（全表）**。这条是"提交 1 禁止优化"
  在上层的对应物，提交 2 应当把它降到候选数。

**两点关于测试方法本身的记录**（都会被后人重踩）：

1. 谓词是 private，用括号访问直取。**不能**改走
   `getNearbyVolunteerSummary`——那条路径传了 `precomputedBusyIdentities`，
   会整段跳过 `if (!precomputedBusyIdentities)` 块，也就是本次唯一改动的代码。
   一个到不了改动点的测试，对改动点没有任何证明力。
2. truth table 需要逐行改 fixture，所以 fixture 里的 `agreements`
   **必须深拷贝**。共享字面量会让第一行的改动泄漏到之后所有测试——
   本文件首轮就因此假红了 4 项。

**已实测破坏性验证**：删掉 `!device.availableForResponse` 这一条，
truth table 精确地只红对应的那一行（`expected rejection when availableForResponse is false`），
其余 5 项仍绿。证明这张表真的在逐条件生效，而不是"碰巧全绿"。

### 8bis.4 `isEligibleNearbyResponder` 迁移（2026-09-12）

**边界规则（本轮冻结为项目级口径）**：

> `event` 参数保存"**这个事件自身的当前业务字段**"；
> context 回答**所有需要查看其他实体或派生关系**的问题。

据此分类：

| 留在 `event` | 进入 `ctx` |
|---|---|
| `state`、`recruitmentState`、`patientDeviceIds`、`patientUserId`、`exitedResponderUserIds`、`observation`、`id`、`currentRecruitmentRadiusMeters`、`patientPosition`、`createdAt` | assignment 归属、delivery 归属、跨事件患者身份、候选设备 |

理由：前者读取不需要访问其他实体，`event` 本身已是算法输入。
把 `event.state` 包成 `ctx.eventState(event.id)` 只会让 context 退化成属性访问的包装层，
不增加任何事务正确性。

**替换点**（只有两处）：

- `this.isEligibleResponderDeviceBase(recruitmentContextFor(state), …)` → `(ctx, …)`
- 内联的 `Object.values(state.deliveries).some(…)` → `ctx.hasAcceptedDeliveryFromIdentity(event.id, device)`

**第二个方法名字值得记一笔**：这段旧 predicate **不是** `deliveryForDevice`，
也**不是** `deliveryForUser`。它问的是"本事件里是否有**同 identity** 的已接受投递"——
是第三个问题，会额外覆盖"同一人另一台设备"。用前两者中任何一个替换都会**悄悄收窄** predicate，
那是行为变更而不是抽取。所以新增的是**同问题形态**的方法，不是"看起来更通用"的方法。

**本轮明确没有做**：

- 没有把 `event.state` 等改成 `ctx.getEvent(event.id)!.state`——那会改变数据来源语义，
  属于 Tx 接入提交（为 read-your-writes 而做），不是为了接口统一。
- 没有改距离算法、位置来源、freshness 规则。
- 没有把 `isEligibleResponderDeviceBase` 的类型收紧。

**提交 2 的硬约束（已冻结为 Tx adapter 前置不变量）**：

> **Tx 路径中 `event` / `device` 必须来自同一个事务视图。**
> 不能把 committed 的 event 对象和 `TxRecruitmentContext` 混用——
> 那会重现"ctx 看到事务新状态、event 参数还是旧状态"的静默错误决策。
> 推荐最终形态是 `const event = ctx.getEvent(eventId)`，
> 由 Tx context 提供当前视图，而不是让外部随手塞一个 `Event` 进来。

**行为锁**（`test/responder-nearby-eligibility.test.ts`，8 项）：

- 基准：基础合格 + 环内 → `true`
- **半径比较符号**：把半径设为 `distanceMeters` 实测值本身 → 必须 `true`，
  这直接锁死 `<=`（若是 `<` 则此处为 `false`）；再 `±1e-9` 与 `×0.5` 锁两侧。
  这个手法不需要任何浮点搜索，也不会因平台差异而脆弱。
- event 关系 5 行：非 ACTIVE / 非 RECRUITING / 本事件患者设备 / 本事件患者 user / 已退出
- `requireRecruiting=false` 忽略招募阶段（`presenceView` 依赖它）
- delivery 归属 6 情况：pending 不阻断、refused 不阻断、
  ACCEPT 但 status 非 ACCEPTED 不阻断、**其他事件**的接受不阻断、
  同 identity 另一设备阻断（双向）
- **事务语义**：持有同一个 draft context，写入 ACCEPTED 后**立即**变 `false`（read-your-writes）
- 患者位置缺失 / 精度超限 / 过旧 → `false`
- **提交 1 诊断**：1000 条无关 delivery + 无匹配 → `deliveryCandidatesVisited` 必须 **= 1000**

**已实测破坏性验证**（两项，各自只红对应测试）：

1. `<=` 改成 `<` → 精确红"radius 等于 distance 必须合格"这一条。
2. 把 identity 规则换成 exact-device 规则 → 精确红"同 identity 另一设备必须阻断"。

**测试方法记录**：`world()` 里候选设备必须与患者有**非零距离**。
第一版把两者放在同一坐标，距离为 0，于是 `measured/2` 仍等于 0，
"环外拒绝"一行**假通过**——边界测试在距离 0 处无法区分 `<=` 和 `<`。
现已加断言强制 fixture 距离 > 100 m。

### 8bis.5 `eligibleResponderDevices` 迁移：排序与 identity 选择语义（2026-09-12）

这是第一层把"候选集合"变成**有确定顺序和 identity 选择语义**的结果，
所以本轮的产出主要不是代码，而是把流水线**冻结成不变量**：

```
ctx.candidateDevices(event)
  → isEligibleNearbyResponder 过滤
  → deviceInstanceId 升序
  → identity 去重（首次出现者存活）
```

**为什么顺序是业务语义而不是风格**（两条都是静默失败）：

- **过滤必须先去重**：反过来会让一个**不合格的小 ID** 设备先占住该 identity 的名额，
  随后自己被过滤掉，于是同一 identity 的**合格大 ID 设备一起消失**——整个 identity 的
  响应者被静默丢失。
- **排序必须先去重**：反过来的话，存活的是哪台设备取决于 `candidateDevices()` 的
  **枚举顺序**，而不是原来的字典序最小设备。

**排序不交给 context**：没有 `candidateDevicesSortedByDeviceId`，
Tx 适配器也不为了省一次 `.sort()` 就返回已排序索引结果。
排序／去重属于**招募算法**，Legacy 与 Tx 共享同一段——
理由与 `survivingAssignmentForDevice` 的收敛一致：
提交 2 的差分必须保证唯一变量是"候选如何取得"，而不是"取得后如何选择"。

**`candidateDevices` 新增两条契约**（已写入接口文档）：

1. **同一 `deviceInstanceId` 最多返回一次。** Legacy 天然满足（对象键唯一），
   但 Tx 适配器要并
   `committed geo candidates ∪ tx.stagedKeys("devices")`，
   同一台设备**极可能两边都出现**。靠调用方的排序和 identity 去重"碰巧"吸收重复
   会：重复计算 eligibility、污染诊断计数，
   并且一旦调用方将来长出副作用就会变成真 bug。**唯一性是 context 的责任。**
2. **返回的每台 device 必须是该 context 当前视图中的对象。**
   索引只提供**候选键**，绝不提供业务真相对象：即便命中 committed 索引，
   适配器也要**用自己的视图回查**。把 committed `DeviceRecord`
   和事务状态混在一起，与"把 committed event 传给事务谓词"是同一类错误。

**行为锁**（`test/eligible-responders.test.ts`，7 项）：

- case 1 候选**故意倒序**插入 → 输出仍升序
- case 2 同 identity 两台都合格，**大 ID 先插入** → 保留小 ID
- **case 3 同 identity 小 ID 不合格、大 ID 合格 → 必须保留大 ID**
  （唯一差异是 `availableForResponse`；并做了反向对照，证明存活者跟随资格而非 ID 顺序）
- case 4 不同 identity 全保留且按 ID 排序
- case 5 混入 5 种不同原因不合格的设备 → 结果与基线**精确一致**
- 契约：`candidateDevices` 无重复 ID
- **提交 1 诊断**：`deviceCandidatesVisited` 必须 = 全部设备数（501）。

**已实测破坏性验证**（两项，各自只红对应测试）：

1. 去重提到过滤之前 → 精确红 case 3。
2. 去重提到排序之前 → 精确红 case 2。

**测试方法记录**：case 1 第一版给 4 台设备用了**同一个 user**，
于是 identity 去重正确地把它们收敛成 1 台，测试红。
修的是 fixture（改成不同 user），不是断言——
但这也顺带证明了去重确实在生效。

### 8bis.6 `recruitmentPotentialDevices`：delivery 语义冻结（2026-09-12）

流水线顺序保持不变，**本层消费上一层已经确定的列表**，
不重新解释 identity、不新增排序：

```
eligibleResponderDevices(ctx, event, now)
  → delivery 条件过滤
  → 返回
```

**这里有一个必须先读代码、不能靠状态名猜的语义反转**（我差点锁反）：

```ts
const delivery = device.userId
  ? ctx.deliveryForUser(event.id, device.userId)
  : ctx.deliveryForDevice(event.id, device.deviceInstanceId);
return delivery === undefined || deliveryIsLive(delivery, now);
```

即：**live 的 offer 反而保留 potential；dead 的 offer 才剔除**。
注释写得很清楚——"a refused or expired offer is a terminal identity for this event
and must not keep a narrow ring open"。挂着的 offer 正是"potential"的定义本身；
已拒绝／已过期／已接受的 offer 意味着这个 identity 在本事件上已经终结。

我第一版把三个测试写成了相反极性，全红——**修的是测试，不是实现**。

**`deliveryIsLive` 的真实状态集合**（从实现读出，非按名字推断）：

live ⟺ `status ∈ {SENT, DELIVERED, VIEWED}` **且** `expiresAt` 可解析 **且** `now <= expiresAt`。
`ACCEPTED` / `REFUSED` / `EXPIRED` 一律 not live。
边界：`expiresAt` 恰好等于 `now` 时**仍然 live**（比较是 `<=`）。
`expiresAt` 不可解析 → not live（这是回退，不是崩溃）。

**lookup 是"二选一"而不是 OR**，而且这一点**比看起来更难锁**：

对已绑定 user 的设备，`deliveryForUser` 在语义上是 `deliveryForDevice` 的**超集**
（它会扫到该 user 名下所有设备，含这台设备自己）。
所以"device-first OR"这种写法在**大多数**情况下给出相同答案——
我第一次的破坏性验证**没抓住它**（7 项全绿）。

真正的判别场景是**两个查询都能命中、但活性不同**：

| 枚举顺序 | `deliveryForUser` 命中 | 三元式 | `device ?? user` |
|---|---|---|---|
| 先 dead（另一设备） | dead → 剔除 | `[]` | live → 保留 `[bound]` |

于是新增了一条专门测试：同一 user 两条 delivery，一条 dead 一条 live，
**按 dead 在前插入**。此时三元式答 `[]`、OR 答 `[bound]`，两者分离。
随后把枚举顺序对调，答案随之翻转为 `[bound]`——
这个"依赖枚举顺序"本身也是旧行为，一起锁住，不做归一化。

**行为锁**（`test/recruitment-potential.test.ts`，8 项）：

- `deliveryIsLive` **全 6 个状态的穷举表** + 过期边界（`<=`、不可解析）
- 无 delivery → eligible 集合原样保留
- 已绑定设备被**同 user 另一设备**的 dead offer 剔除（证明用的是 user 查询）
- 未绑定设备被自己的 dead offer 剔除（证明用的是 device 查询）
- **两查询同时命中且活性不同 → 由 user 查询裁决**（上面那条判别测试）
- **过滤发生在 identity 去重之后，不补选**：`small` 被剔除后结果必须是 `[]`，
  **不得**回头补 `large`
- 事务语义：同事务写入的 delivery 立即被看到；状态改动立即生效（双向）
- **提交 1 诊断**：50 个候选 × 全表 500 条 = **25,000** 次 delivery 访问

**已实测破坏性验证**（三项）：

1. 三元式换成 `device ?? user` → 红了那条判别测试（**第一次验证时是绿的**，
   说明原测试不够强，已补强）。
2. 过滤后按 identity 补选 → 2 项红。
3. 完全忽略 user 查询 → 2 项红。

**测试方法记录**：本轮又出现两次"测试先错"——极性写反（3 项假红）、
以及**破坏性验证没抓住**（1 项假绿）。后者更值得记：
破坏性验证不只是"跑一遍确认绿"，而是**必须确认它在被破坏时会红**；
第一次的 A 破坏方案是绿的，说明测试本身没有判别力。

### 8bis.7 `advanceRecruitmentStage`：把**写入**也收进 context（2026-09-12）

前六个函数只处理**读**。这个是第一个有业务写入的，而写的问题比索引 stale 更危险：

```ts
event.currentRecruitmentRadiusMeters = nextRadius;
```

Legacy 下这直接改到 `state.events[id]`，工作正常。但 Tx 适配器交给算法的是
**它自己的当前视图对象**，于是同一行会变成：
"内存对象看起来改了，事务根本没登记这次变更"——**下游无法观测**。

所以本轮的要点不是读，而是**写入必须走 `ctx.updateEvent`**。

**`ctx.updateEvent` 现在返回更新后的当前视图**（`EventRecord | undefined`），
调用方必须**重新绑定**并把返回值用于后续所有读取：
否则下一次读取仍拿旧对象，而 Tx 下那就是旧值。

**`advanceRecruitmentStage` 的返回值从 `boolean` 变成 `{ changed, event }`**，
理由同上：调用方不能再假定它传入的那个 event 对象还是最新的。

**"静默回退"被改成"响亮失败"**：`updateEventOrThrow` 在 `updateEvent`
返回 `undefined` 时抛错。`undefined` 只意味着"该 context 的当前视图里没有这个事件"，
此时继续用手里那个对象就是在改一个事务永远不知道的副本——
正是本次重构要消灭的失败模式，不能再用 `?? current` 吸收掉。

**行为锁**（`test/recruitment-stage.test.ts`，13 项）：

- 无有效 P → 四个字段都不动，不写 timeline
- 首次有效 P → 起算 stage 时钟
- 半径不在阶段表内 → 归一到第一阶段并重置时钟
- 达到目标 + 时钟新鲜 → 不扩环
- 达到目标 + 时钟超时 → **恰好扩一环**并 reset 时钟
- 恰好等于超时阈值 → 不扩（比较是严格 `>`）
- 最宽环 → 不再扩，也不写 timeline
- read-your-writes：同 context 写入后立即可读
- `updateEvent` 对视图内不存在的事件返回 `undefined` 且不执行回调
- **staged 替身**：提交态未被写入 / staged 视图持有变更 / 返回值与 staged 一致
- **staged 替身**：第二次调用能看到第一次 staged 的时钟重置
- **契约违反**：staging 了却不返回当前视图的适配器 → **抛错**，不被吸收

**关键发现：Legacy 适配器在原理上无法测试写入抽象。**

我先对前 9 项跑了两个破坏方案，**两个都全绿**：

| 破坏方案 | 结果 | 原因 |
|---|---|---|
| `updateEvent` 返回 `undefined` | 全绿 | Legacy 是原地改，返回值无所谓 |
| 直接原地改 event，不走 `updateEvent` | 全绿 | Legacy 下两者是同一个对象 |

这不是测试写得不够多，而是**fixture 选错了**。于是新增
`stagedContext()` 替身：`updateEvent` stage 一份 detached 副本并返回副本，
`getEvent` 优先 staged，提交态永不写入——即 Phase 2 适配器被规定的行为。
换用该替身后：

- 原地改 event → **红**（"exactly one widening step was registered"）
- 契约违反型适配器 → **红**（抛错断言）

结论：**"算法已经是事务形态"这件事，必须在提交 2 存在之前就能被证明**，
而证明它需要一个按提交 2 契约行为的替身，不能靠 Legacy。

### 8bis.8 `createDeliveryIfEligible`：`createDelivery` 的三条事务语义（2026-09-12）

唯一写入点。三条 guard 顺序原样保留：**资格 → 本设备 → 本 user**。
它们与 `recruitmentPotentialDevices` 的 live-delivery predicate **不是同一套规则**
（那一个问"已有 offer 是否还活着"，这三个问"是否存在任何 offer"），
共用 helper 会同时改掉两边。

`ctx.createDelivery` 被规定为必须具备三条事务语义：

1. **insert-only**——调用方 mint 全新 `randomUUID`，所以从不是替换。
   Legacy 只能按键赋值，因此**碰撞被计数**（`deliveryCreateCollisions`）
   而不是被静默吸收：id 已存在意味着有调用方在复用 id，
   到了 Tx 适配器就是真正的丢失更新。
2. **对同一个 context 立即可见**——`deliveryForDevice` / `deliveryForUser`
   必须在提交前就能查到它。调用方的设备循环正是靠这条：
   同一 identity 的第二台设备被挡住，是因为第一台刚创建的 offer 已经可见。
3. **不污染 committed state**——Tx 适配器写入 staged delta，回滚即丢弃。

**写入顺序也一并锁住**：delivery → timeline → notification。
它们原子提交，但事务内的 helper 可能读前面步骤写下的东西，
所以"反正一起 commit"不足以成为重排的理由。

**`refreshRecruitmentForEvent` 里的 context 已上提**到操作顶部：
read-your-writes 是**单个 context 的属性**，设备循环里每次新建一个 context
就谈不上这条语义。这也是"一次事务 = 一个 context"的第一次落地。

**共享替身 `test/helpers/staged-recruitment-context.ts`**：

提交 1 里 Legacy 适配器**无法**测试这三条语义——它直接改提交态，
于是"立即可见"和"不污染"都是**因为错误的原因**而成立。
所以替身按 **Phase 2 契约**而非 Legacy 行为来定义：
写入 stage 一份 detached 副本；读取把 committed 与 staged 合并
（保留 committed 插入顺序、按键覆盖，即"把 change set 应用到有序集合"的语义）；
**同一实例**必须服务整个操作。

替身**只有一份**，被 `recruitment-stage.test.ts` 与 `delivery-creation.test.ts` 共用。
两份副本会各自漂移，那时测试检查的就是替身而不是算法。

替身还提供 `writeLog()`：**逐集合断言看不到跨集合的重排**，
而写入顺序是行为，所以需要一个统一的写入序列。

**行为锁**（`test/delivery-creation.test.ts`，10 项）：

- 合格设备拿到恰好一个 offer，字段逐个对齐（`messageId` 去重键不得漂移）
- guard 1 不合格 → 无 offer、无 timeline
- guard 2 本设备已有 offer → 拒绝（不论其状态）
- guard 3 本 user 的另一设备已有 offer → 拒绝
- guard 3 用的是 user 查询：未绑定设备不被他人 offer 影响
- read-your-writes：同 context 创建后，两个查询都能立刻查到
- staged：insert-only（碰撞为 0）、立即可见、**committed 未变**，
  且由此导致同 identity 第二台设备被挡
- staged：写入顺序 = `["delivery", "timeline", "notification"]`
- **回滚**：丢弃 staged context 后提交态干净，设备重新可被 offer
- insert-only 是**被测量的**：正常流程计数为 0，复用 id 计 1

**已实测破坏性验证**（四项，各自精确命中）：

| 破坏方案 | 结果 |
|---|---|
| `createDelivery` 直接写提交态 | 3 项红，含"不得写入 committed collection" |
| staged delta 对查询不可见 | 1 项红 |
| 去掉 user guard | 2 项红 |
| notification 移到 delivery/timeline 之前 | 1 项红（写入顺序） |

**测试方法记录**：`writeLog()` 是补强来的。
第一版的顺序测试**分别**断言三个集合，**重排不会红**——
逐集合断言在结构上就无法观测跨集合顺序。这是本阶段第三次
"测试看起来在测顺序，其实没有"。

### 8bis.9 `refreshRecruitmentForEvent`：组合操作（2026-09-12）

签名为 `(ctx, event, now, forceRevision)`，**不构造 context**。
返回值新增 `event` 字段——本操作内部有三类写入（delivery 过期、事件自身
stage/revision、新建 delivery），Tx 适配器每次都会产出新的当前视图对象。

**检查点 1：过期 sweep**

- `Object.values(state.deliveries)` → `ctx.deliveriesOfEvent(current.id)`。
  原来循环体内的 `delivery.eventId !== event.id` 判断由该方法承担（等价。
  注意：这要求 `deliveriesOfEvent` **必须是事件作用域**，已由
  "another event's offers are untouched" 锁住——把上下文改成返回全部
  delivery 会精确红这一条）。
- `delivery.status = "EXPIRED"` → `ctx.updateDelivery(id, draft => …)`。
- `enqueueNotification` / `appendTimeline` → `ctx.insertNotification` / `ctx.appendTimeline`。
- `state.devices[...]` → `ctx.getDevice(...)`。
- **`id` / `deviceInstanceId` / `expiresAt` 在更新之前先取到局部变量**。
  理由：`updateDelivery` 之后本地绑定是**更新前**的视图，
  Tx 适配器很可能已经把它换掉了。

**检查点 2：有副作用的 offer 循环**

```ts
const candidates = [...ctx.candidateDevices(current)].sort(byDeviceInstanceId);
for (const device of candidates) this.createDeliveryIfEligible(ctx, current, device, now);
```

这个排序**不是展示顺序，是业务选择顺序**：每次迭代都创建 offer，
所以同 identity 里**先被遍历到的设备拿到 delivery**，
其余随后被 user 级 guard 挡掉。候选源（Set / Map / geo index / stagedKeys）
的枚举顺序绝不可依赖，算法自己排。

**检查点 3：Legacy 差分**

`coordinationRevision += 1` 的三处写入（含两处早退分支）全部改走
`updateEventOrThrow`。

**行为锁**（`test/recruitment-refresh.test.ts`，12 项）：
窗口超时 → `OFFER_EXPIRED`；资格变化 → `OFFER_NO_LONGER_ELIGIBLE`；
他事件 offer 不动；活着的 offer 不动；staged 下过期不进提交态；
**字典序最小设备拿到 offer（反序枚举的适配器也改不了赢家）**；
offer 创建顺序跟随排序；revision 整操作只加一次；
非 ACTIVE 不写；非 RECRUITING 只在 force 时加 revision；
同 context 第二轮不再重复发 offer。

**已实测破坏性验证**（三项精确命中，一项确认为非缺陷）：

| 破坏方案 | 结果 |
|---|---|
| 原地改 delivery（不走 `updateDelivery`） | 1 项红 |
| 去掉 offer 循环的排序 | **3 项红** |
| `deliveriesOfEvent` 不再按事件过滤 | 1 项红 |
| 更新后复用 delivery 读**未变字段** | 绿——**确认为非缺陷**，读 `id`/`deviceInstanceId`/`expiresAt` 本就安全，属风格选择而非错误 |

**测试方法记录（第六次"fixture 替被测代码做决定"）**：delivery fixture 的
**map key 与 `id` 字段不一致**——我用 `uuid(500)` 作 key 却让对象内部是随机 id。
上下文按 `id` 查、按 `state.deliveries[id]` 写，于是 `updateDelivery` **静默不生效**，
而我的断言只查了状态字段，**假绿**。这也暴露了一个既有的真实脆弱点：
key 与 `id` 不一致的 delivery 行是**无法被更新**的。

### 8bis.12 进入提交 2 前必须收口（**本轮实测更新，仍未完成**）

审计中发现一项**比 context 构造层级更严重**的阻塞项：

> **本节 A 项的原始判断已被 §8bis.13 更正。** 下面这段把 12 处 revision 直写称为
> "提交 2 前必须处理的阻塞项"，但当时**没有核实每一处真实运行在哪种事务里**。
> 实测结论是 **12/12 全在全量草稿内，0 处缺陷**。保留原文以便追溯误判过程。

**A（已更正，见 §8bis.13）. 12 处 `event.coordinationRevision += 1` 直接写在 8 个模块里。**

```
aed-actions.ts:254,420   assignment-status.ts:141   event-lifecycle.ts:84
responder-exit.ts:345    response-decision.ts:218,277,329
service.ts:2647,3819,3871,6029
```

这是**绕过 context 的写入**：Legacy 下直接改到 state，Tx 下会改到一个事务永远不知道的副本，
正是 `advanceRecruitmentStage` 那一轮修掉的同一类缺陷，但范围更大、且跨模块。
**这必须在提交 2 之前处理**，否则招募链即使全部 ctx 化，revision 仍会在事务中静默丢失。

**B. `replanAssignments` 仍接收 `state`**（3 个调用点 + 1 处内部调用）。
它不在本轮 9 个函数清单内，且已被列为独立的 RISK / PRODUCT DECISION。

**C. context 构造层级未上提。** 当前 `recruitmentContextFor` 14 处 +
`this.recruitmentContext` 36 处 = **50 处**。提交 2 要求
**一次真实事务 = 一个 `TxRecruitmentContext` 实例 = 一个 staged delta 视图**；
且该实例**不得跨事务缓存**。逐个调用链新建实例虽然在 Legacy 下无害，
但 Tx 实例将来会持有候选缓存 / 索引 overlay / 诊断计数 / staged 关系缓存，
50 处会让这些局部状态分裂。

### 8bis.13 更正：12 处 revision 直写**不是**缺陷（按真实事务分类，2026-09-12）

§8bis.12 的 A 项判断错误，现按"**该写入实际由哪种事务承载**"重新分类。

**分类方法**：对每一处写入，定位承载它的真实事务原语，而不是看它"是否绕过 context"。

**证据一：`transactEntities` 在生产路径上只有 2 处调用点。**

| 位置 | 用途 |
|---|---|
| `service.ts:3518` | 位置上传的增量路径 |
| `service.ts:5139` | prune 路径 |

**两处都不含任何 `coordinationRevision` 写入。**

**证据二：其余 20 处 `store.transact(` 全部是全量树事务**，逐个映射到宿主方法。

| 写入点 | 承载事务 | 判定 |
|---|---|---|
| `service.ts:2647`（`tick`） | `store.transact` @2604 | 全量草稿 → **正确** |
| `service.ts:3819`、`3871`（`recordDeliveryReceipt`） | `store.transact` @3794 | **正确** |
| `service.ts:6029`（`enforcePatientPriority`） | 由 `watch-event-creation.ts:33` 的 `store.transact` 承载 | **正确** |
| `response-decision.ts:218`、`277`、`329` | 本模块 `store.transact` | **正确** |
| `assignment-status.ts:141` | 本模块 `store.transact` | **正确** |
| `aed-actions.ts:254`、`420` | 本模块 `store.transact` ×2 | **正确** |
| `responder-exit.ts:345` | 本模块 `store.transact` | **正确** |
| `event-lifecycle.ts:84` | 无自带事务；由 `event-resolution.ts:123/255`、`status-confirmation.ts` 的 `store.transact` 承载 | **正确** |

**结论：12/12 在全量草稿内，0 处缺陷。**

**理由**：全量 `transact` 的语义就是 clone 整树 → 回调在草稿上任意修改 →
`flattenState` diff → 持久化。回调内直接改 `event.coordinationRevision`
**会被 diff 捕获并持久化**，与 `ctx.updateEvent` 在 Legacy 下**行为等价**。
把它判为缺陷，等于把"Legacy 的写入方式"误当成"Tx 的写入方式"。

**它们真正的性质是"潜在迁移项"**：只有当承载它们的**那条路径本身**迁到
`transactEntities` 时，直写才会变成缺陷。而 §2 已明确
"其余索引迁移 / 实时层改造"**本批不做**；`tick()` 在本批
**保留 Legacy 上下文**（§8ter），Legacy fallback 边界照旧（§8bis.6/§8bis.10）。

→ **不新增"迁移全部模块"或"迁移 tick"的要求。**

### 8bis.16 调用点审计的第二轮：闭包捕获一致性（2026-09-12）

**上一轮的审计漏了三处** refresh 之后的旧引用，本轮全部收口：

| 位置 | 问题 | 处理 |
|---|---|---|
| `response-decision.ts` `participantDeviceIds(state, event)` | refresh 之后用旧 event 推导 `decisionAudience` | 改用 `refreshed.event` |
| `response-decision.ts` `finalize` 内的 `enqueueDecisionNotification` / `enqueueAssignmentEmissions` | **同一个闭包捕获问题**：`finalize` 用外层的 `event`，而三处调用都在各自 refresh 之后 | `finalize(candidate, currentEvent)`，三个调用点传 `refreshed.event` |
| `responder-exit.ts` `enqueueParticipantExitNotification(state, event, …)` | refresh 之后用旧 event | 改用 `refreshedRecruitment.event` |

`responder-exit.ts` 第 361 行的 `coordinationAudienceDeviceIds(state, event)` 在 refresh
**之前**，保持不变——顺序决定哪一处该改，不能一律替换。

**定向 DI 测试**（新增两个文件，各 2 项）：

- `test/response-decision-refresh-consumers.test.ts`
- `test/responder-exit-refresh-consumers.test.ts`

做法：用桩依赖调用真实 use case，其 `refreshRecruitmentForEvent` 返回一个
**detached 副本**，只改 `coordinationRevision`（`+7` / `+11`）。
**不改任何 id**——id 按契约不可变，改它等于让适配器做它不被允许做的事；
可变的 revision 才是诚实的判别量，也正是 Tx 适配器将来真正会不同的地方。

断言用**对象恒等**（`===`）而非数值：若断言写死绝对数值，测的会是
use case 内部那次 `coordinationRevision += 1`，而不是本测试要证明的性质。
两个文件各含一条"harness 自检"，确保 refresh 确实返回了不同的对象与不同的 revision，
否则下面的断言全部会空转通过。

**已实测破坏性验证**：逐个把三处改回旧引用，对应断言各自精确变红
（`participantDeviceIds` / `enqueueDecisionNotification` /
`enqueueParticipantExitNotification` 各一条）。

**`updateDelivery` 缺失时的副作用顺序**（`test/recruitment-refresh.test.ts` 第 18 项）：

用一个"读侧能看见、写侧找不到"的适配器，断言 `updateDelivery` 抛错
**发生在任何 notification 或 timeline 之前**：抛出后
notification 为空、timeline 为空、staged 写入序列为空、提交态与运行前逐字相同。
破坏性验证：把 notification 提到 delivery 写入之前 → 4 项红，含该条专门断言。

**一处必须记录的操作事故**：本轮我用正则在 `response-decision.ts` 里批量插入
`finalize` 的新参数，正则匹配层级出错，随后一次 `replace` 的第二个参数因
`X if False else s` 被求值成**整个文件内容**，把文件撑到 1109 行。
已从 `git show HEAD:backend/src/response-decision.ts`（348 行）恢复，
再逐条重放本会话对该文件的全部意图变更（`RecruitmentRefresh.event`、
三处 `recruitmentUpdate` 的 `refreshed.event`、`participantDeviceIds`、
`finalize` 签名与三个调用点），最终 367 行，`check` 干净、全套通过。
教训与前面几次一致：**批量文本改写必须逐条断言锚点，且不能用会求值成整个文档的表达式。**

### 8bis.15 两个测试缺陷的更正（2026-09-12）

**缺陷 1**：名为 "exact expiresAt" 的测试把 `expiresAt` 设为 `NOW + 30s` 却在 `NOW` 刷新——
**它根本没有测到期限**，也没有测"同一 context 内创建的 delivery"。

重写为 `offer deadline: staged create, live AT the deadline, expired one ms later`：

1. **真实 staged 创建**：调用 `createDeliveryIfEligible(ctx, …)`，
   从返回值取 `deadline = Date.parse(created.expiresAt)`——期限来自生产代码本身，
   不是手写常量。
2. **恰好到期时仍然 live**：`deliveryIsLive` 比较是 `now <= expiresAt`（取自原始实现），
   所以此刻断言 EXPIRED 会**编码相反规则**。此处断言仍为 `SENT`，两个查询一致。
3. **过期后一毫秒**：`expiredOffers` 恰 1 条、reason 为 `OFFER_EXPIRED`，
   **device 与 user 两个查询都返回 EXPIRED**。
4. **再次刷新**：dead offer 不再 pending，无重复副作用。
5. **整个提交态逐字不变**：`structuredClone` 前后 `deepEqual` 整个 state，
   不只比较 event 字段。

**fixture 条件从实际规则推导**：半径取
`RECRUITMENT_RADIUS_STAGES_METERS[length - 1]`（最宽环）。
依据是扩环规则——最宽阶段下 `nextRadius === undefined`，`advanceRecruitmentStage`
**第一次迭代就 break**，阶段因此完全惰性。这样"到期时仍 live"这一断言不会被
无关的阶段扩环写入掩盖。并加了一条**正面断言**证明该推导有效：
该次刷新 `changed === false` 且写入序列长度不变——若半径还能扩大，这里就不为零。

**缺陷 2**：`cumulative revision` 测试在构造 staged context **之后**
直接改 `state.events[EVENT_ID].recruitmentState`。staged context 的视图并未更新，
于是第三次刷新**根本没有走这条分支**，测试断言的是一个不存在的路径。

改为**通过 context 写入**：`ctx.updateEvent(EVENT_ID, draft => …)`，
并断言返回的 staged 视图确实变成 `SATURATED`，同时断言**提交态两个字段都没动**
（`coordinationRevision` 与 `recruitmentState`）。

**已实测破坏性验证（四项，全部命中）**：

| 破坏方案 | 结果 |
|---|---|
| `deliveryIsLive` 的 `<=` 改成 `<` | 1 项红："at exactly the deadline the offer has not expired" |
| staged 创建同时写穿到提交态 | 1 项红："the entire committed state must be unchanged…" |
| `updateEvent` 不登记 staged 变更 | 2 项红 |
| fixture 退回第一阶段（去掉最宽环推导） | 1 项红 |

**当前测试计数**：`test/recruitment-refresh.test.ts` 17 项；全套 **365/365**，
`npm run check` 干净。本轮只改测试与文档，**未改任何源码行为**。

### 8bis.14 Phase 1 状态对锚（§2 / §4 / §5，2026-09-12）

**范围提醒**：九函数抽取是 §2 第 6 项（本条路径的查询索引与收窄）在待命位置路径上的
**前置工作**，**不是 Phase 1 的验收标准**。验收标准是 §4.1 与 §4.2。

**§2 九项**：

| # | 项 | 状态 |
|---|---|---|
| 1 | `transactEntities` | 已实现；生产路径 **2 处**在用（位置上传增量、prune） |
| 2 | `tx` 契约 | 已完成并有专项测试（`entity-transaction.test.ts`） |
| 3 | 校验三拆 | `validateChangeSet` + 逐集合实体校验器已抽出；`validateState` 规则未删 |
| 4 | 增量持久化 | 已实现（`persistEntityChanges`），相同内容不产生 SQL 写入 |
| 5 | 空变更提前返回 | 已实现（`emptyChangeSetReturns`） |
| 6 | 本条路径索引与收窄 | **结构门槛已达成**（§4bis：56,421 实体下计数与耗时均不随无关历史增长） |
| 7 | `reconcile()` 插桩 | 指标位已存在（`realtimeMetrics`） |
| 8 | 开发/测试影子校验 | **两套机制齐备**：`store.ts:1316-1317` 与 `1347-1348` 同时执行 `validateState` + `assertAppendOnlyHistory`，满足 §5.1"不能只留前者" |
| 9 | 插桩 | 已完成（`runtime-metrics.ts`，三类模式已披露） |

**§4 验收**：

- **4.2 结构门槛：已达成**（计数归零，见 §4bis）。
- **4.1 容量门槛（≥200 次/秒真实位置变更）：尚未测量。**
  §4bis 只有"改前"基线；文档中 **248/s 是存储层微基准，不是本接口基线**，
  本接口真实基线是 **10.24 次/秒（线上实测，54 用户）**。
  **因此 Phase 1 验收目前未完成**，且这是唯一剩下的硬门槛。

**§5 替换边界**：

- §5.1 要求"进入 Phase 2 之前，隔离的新旧实现对照测试必须已可运行并通过"。
  `test/recruitment-differential.test.ts` 是**第一例**该类对照
  （字节级基线 + 生成 ID 归一化 + 跨集合写入序列），但它只覆盖招募刷新这一条命令。
- §5.2 要求的对照面是"相同命令的返回结果、拒绝行为、业务状态与证据内容"，
  且规模是"旧实现能承受的规模"。**当前覆盖是其中的一个组件，不是全部**；
  存储层的整体新旧对照（跨命令、含拒绝路径）**尚未建立**。

### 8bis.10 进入提交 2 前必须收口的两项（原始记录，见 8bis.12/8bis.13 的更新）

1. **`updateDelivery` / `updateEvent` 之后继续使用旧对象。**
   本轮已在本函数内把三个字段提前取出，但**全库范围的审计没有做**。
   `refreshRecruitmentForEvent` 的 14 个调用点中，只有捕获返回值的那些才有机会
   重新绑定；我尝试过用脚本批量插入 `event = refreshed.event;`，
   **已回滚**——正则会改到无关函数的 `const event` 声明，这类改动必须逐点核对，
   不能批处理。
2. **Tx context 构造层级尚未上提到事务入口。**
   目前 14 个调用点各自 `this.recruitmentContext(state)`；
   全库仍有 13 处模块级 `recruitmentContextFor` + 27 处 `this.recruitmentContext`。
   提交 2 要求"一次事务 = 一个 TxRecruitmentContext = 一个 staged delta 视图"，
   这一层必须先做，否则 42 处构造会各自持有分裂的局部状态。

这两项是 8bis.7 冻结的 `stagedContext` 替身能在提交 1 阶段就暴露问题的原因，
但**替身只覆盖被它驱动的调用路径**，不能替代上述两项收口。

### 8bis.11 调用点/DI 消费方收口 + `updateDelivery` 当前视图 + 独立差分（2026-09-12）

**1. `refreshRecruitmentForEvent` 全部 14 个调用点已审计并收口。**

先前的错误是：调用 refresh 之后继续用**传入的** `event` 对象。
共享 context **不会**刷新任何旧的 detached 引用，所以必须用返回的当前视图。逐类处理：

| 类别 | 处数 | 处理 |
|---|---|---|
| 可变局部绑定 | 7 | 插入 `event = refreshed.event;`（其中 1 处 `const` → `let`，逐点核对） |
| `for (const event of Object.values(state.events))` 循环变量 | 3 | **无法重绑定**，改用 `recruitment.event` / `refreshed.event` |
| DI 边界 | 3 | 保持外部签名，边界内部消费返回值 |

**DI 消费方原本是坏的**（不只是风格问题）：

- `response-decision.ts` 三处：refresh 之后把旧 `event` 传给 `recruitmentUpdate`。
  `RecruitmentRefresh` 已加 `event` 字段，三处改用 `refreshed.event`。
- `responder-exit.ts`：`enqueueAssignmentEmissions` 与 `recruitmentUpdate` 同样改用
  `refreshedRecruitment.event`。
- `watch-event-creation.ts`：`recruit` 钩子原本返回 `void`，
  消费方**拿不到**刷新后的事件，却在其后用了 `event` 三次
  （`patientViewers` / `enqueueCoordination` / `project`）。
  钩子签名改为返回 `EventRecord`，消费方改为 `event = hooks.recruit(...)`。

**2. `updateDelivery` 返回当前视图，缺失即抛错。**

与 `updateEvent` 返回 `undefined` 的不对称是**刻意的**：
delivery 的 id 来自**同一个 context**，查不到意味着 context 与调用方对"存在什么"判断不一致，
是缺陷；而 event 引用可能来自别处。静默 no-op 会让过期清扫**报告成功而 offer 仍然存活**。
sweep 中两个分支合并为 `expire()` 闭包，一切读取都用返回的当前视图。

**3. 新增行为锁**（`test/recruitment-refresh.test.ts` 17 项，`test/recruitment-differential.test.ts` 14 项）：
精确 `expiresAt` 原样保留；过期后 device/user 两个查询都看到 `EXPIRED`；
重复 refresh 不产生重复副作用；revision 累积且提交态不动；
**跨集合写入顺序**；候选选择顺序。

**跨集合顺序的真实结论（不是我以为的）**：sweep 是
`更新 → notification → timeline`，而 `createDeliveryIfEligible` 是
`delivery → timeline → notification`。**两条路径顺序本来就不同**，
所以这不是待归一化的不一致——按"看起来更整齐"统一任何一条都是行为变更。
（依据：`git show 64c4759:backend/src/service.ts` 的原始文本。）

**4. 独立新旧差分**（`test/recruitment-differential.test.ts`，13 个场景）

- **基线来源**：`test/baseline/recruitment-baseline.ts`，
  由**花括号配对提取器**从 `git show 64c4759:backend/src/service.ts`
  按符号名**逐字复制**，34 个块全部经重新提取并**逐字校验通过**。
  提取记录（commit / path / 每个符号的原始行号）写在 `BASELINE_PROVENANCE`。
  没有任何转写，因此不存在"抄错"引入的偏差。
- **对照面**：event 全字段、deliveries、notifications、timeline **顺序**、
  以及返回值四字段（`changed`/`requests`/`previousAudience`/`expiredOffers`）。
- **生成 ID 归一化**：按**插入顺序**分配 `generated-N` 别名，
  并做**子串替换**（生成的 id 会出现在 timeline 文案与 `messageId` 里）。
  插入顺序本身就是被测行为：两侧若以不同顺序创建 offer，别名就不同、比较就失败。
  第一版按 id 排序分配别名——那是按**随机 UUID** 排序，等于没测。
- **明确排除**：派生索引、缓存、指标计数、耗时；以及 current 额外返回的 `event` 字段
  （它等于 `state.events[id]`，已由 state 那一路单独比较）。

**差分的破坏性验证**（证明它真的会红，不是全绿的空转）：

| 破坏方案 | 结果 |
|---|---|
| offer 创建顺序反转 | 2 项红 |
| offer 路径写入顺序对调（delivery/timeline/notification） | 7 项红 |
| sweep 写入顺序对调（notification/timeline） | **第一次绿**，修探针后 2 项红 |
| sweep 窗口过期的 reason 改掉 | 1 项红 |

**差分的探针缺陷（必须记录）**：per-collection 比较**看不到跨集合的相对顺序**。
补了共享写探针后，sweep 顺序对调**依然全绿**——因为
`appendTimeline` 用 `??=` 首次创建数组，那次 `push` 走的是**未经代理的原始数组**，
于是**第一次 timeline 写入在两侧都没被记录**，而那次对调恰好发生在它旁边。
预置 `timelineByEventId[EVENT_ID] = []` 后盲点消失、破坏被红住。
这与 `delivery-creation.test.ts` 里 `writeLog()` 的教训是同一条：
**"看起来在测顺序"不等于在测顺序**。

**另一个必须记录的行为**（我第一版按"合理"猜错，5 项假红）：

扩环规则实际是

```
expand  <=>  accepted < 3  AND  (potential < 3  OR  (potential >= 3 AND timedOut))
```

即 **potential 不足 3 时立刻扩，且会一路扩到最宽环；超时门只在 potential 已达 3 时才起作用**。
所以"零候选 + 首次调用"的结果是**直接到最宽环 + 两条 timeline**，不是扩一环。
要测超时分支必须**先造出 ≥3 个 potential 设备**。这与 freshness、`deliveryIsLive`
是同一类教训：**规则从实现里读，不从名字或直觉推**。

## 8ter. 修正后的实施顺序与"事务内索引读"设计（2026-09-12）

### 顺序（用户修正，取代 §8bis 的旧顺序）

| # | 工作 | 状态 |
| --- | --- | --- |
| 1 | `transactEntities` 维护**实时 transaction delta** | ✅ `stagedKeys(collection)` 已实现 |
| 2 | 提供 **tx-aware index query（read-your-writes）** | ✅ 机制已实现并测试 |
| 3 | assignments 索引 | ⬜ 待做（形状已重新核对，见下） |
| 4 | `deliveryForDevice` / `deliveryForUser` 复合索引 | ⬜ 待做 |
| 5 | 招募链迁到 `transactEntities` | ⬜ 最后迁 |
| 6 | 删除旧 fallback | ⬜ 等行为对照全部通过 |

### 索引按**查询形状**设计，不按实体集合设计

**核对后的实际谓词**（`isEligibleResponderDeviceBase`）：

```ts
Object.values(state.assignments).some(assignment => {
  if (state.events[assignment.eventId]?.state !== "ACTIVE"
    || assignmentExitsParticipation(assignment.status)) return false;
  const assignedDevice = state.devices[assignment.deviceInstanceId];
  return assignment.deviceInstanceId === device.deviceInstanceId
    || (assignedDevice && deviceIdentityKey(assignedDevice) === identity);
})
```

**它不按 `event.id` 过滤**——问的是"这台设备（或其身份）是否在任何 ACTIVE 事件上持有未退出的任务"。
因此先前提议的 `assignmentsByEventId` **是错的索引形状**；
正确形状是**两个集合**：`activeAssignedDeviceIds` + `activeAssignedIdentities`，判断退化为 O(1)。

投递同理：`deliveryForDevice` / `deliveryForUser` 应按 **`(eventId, deviceId)`** 与 **`(eventId, userId)`** 建复合键，
而不是"先取该事件全部投递再线性查找"。

目标复杂度：地理索引给出候选 C 之后，逐台候选的每次查询都是 O(1)：

```
O(设备 × (任务 + 投递))  →  O(C)
```

### 全局索引**保持提交后更新**（不要把修 bug 变成更大的 bug）

发现二的正确修法**不是**"mutation 发生时立刻改全局索引"——那样一旦数据库提交失败，
就会出现**数据库已回滚、全局索引已变**的更严重不一致。正确结构：

```
Committed State + Committed Index      （不动）
        ↑
Transaction: staged entities + staged delta + transactional view
        ↓ SQLite 提交成功
   publish state changes
        ↓
   apply delta to committed indexes
```

事务失败：丢弃 staged entities 与 delta，全局索引**完全未被污染**。
已由测试 5 锁定。

### read-your-writes 的实现：**并集，不是改索引**

候选集 = `committed_index.query(...)` ∪ `tx.stagedKeys(collection)`，再由**精确谓词**过滤。
这永远是**超集**，因此：

- 本事务**新进入**范围的实体：不在索引结果里，由并集补上（**不漏**）；
- 本事务**新离开**范围的实体：仍在索引结果里，被精确谓词拒绝（**只多不少**）。

所以**不需要为每个索引写 read-your-writes 逻辑**，一个通用并集就够。

### 已加的回归测试（`test/transaction-index-overlay.test.ts`）

这组测试存在的原因是失败模式**是静默的**——没有它们，一个移动到患者旁边的响应者**永远不会收到 offer**，
而系统不会报任何错。

| # | 场景 | 断言 |
| --- | --- | --- |
| 1 | 事务内从 3 km 外移动到患者旁 | 必须进入候选 |
| 2 | 事务内从范围内移到范围外 | 索引旧条目仍返回（允许过选），但**读取必须看到暂存的新位置**，精确检查拒绝 |
| 3 | 同事务创建 delivery | 后续资格判断立即可见（`has` 为真） |
| 4 | 同事务创建 assignment | 同上 |
| 5 | 事务回滚 | 全局地理索引与已提交状态**逐字节未变** |

### 第 3 步：assignment 索引按你的修正实现

**没有采用** `activeAssignedDeviceIds` / `activeAssignedIdentities`（把 `ACTIVE` 固化进索引）。
改用**纯结构性**的两个映射：

```
assignmentIdsByDeviceId : Map<DeviceId, Set<AssignmentId>>   // 反向映射，删除 O(1)
deviceIdsByIdentity     : Map<IdentityKey, Set<DeviceId>>
```

查询变成：**候选索引 + 事务内精确状态**

```
候选设备 = {本设备} ∪ identity 下所有设备 ∪ tx.stagedKeys("devices")
候选任务 = ∪ 各候选设备的 assignmentIds ∪ tx.stagedKeys("assignments")
对每个候选：tx.get(assignment) → tx.get(event) → 精确谓词（ACTIVE、未退出、device/identity 匹配）
```

**为什么这比 `activeAssigned*` 安全**（你的反例，已写成测试 4）：

> 事务内 `event X: 非 ACTIVE → ACTIVE`，且该 event **已有** assignment。
> 固化索引里原本没有这些设备，而本事务**没改 assignment**（`stagedKeys("assignments")` 为空），
> 于是 `committed active index ∪ staged assignments` **仍然漏选**。
> 结构性索引不关心 event 是否 ACTIVE，该 assignment 始终在候选集中，
> 最终精确谓词 `tx.get("events", …)` 自然读到事务里的 ACTIVE。

**为什么必须是 `Set<assignmentId>` 而不是布尔/计数**（你的第二点，已写成测试 6）：
同一设备可同时关联多个有效 assignment，其中一个退出时若直接 `delete(deviceId)` 会误判为"无任务"。

**身份可变性已核实并处理**（测试 7）：`deviceIdentityKey()` 在绑定前后不同；
`bootstrap` 的 403 守卫只挡住**已绑定 → 改绑**，**未绑定 → 已绑定**是允许的。
所以查询必须并入 `tx.stagedKeys("devices")`，否则绑定发生在本事务内的设备会被漏掉。

### 通用"并集"规则已按你的要求收窄

> `committed index query ∪ tx.stagedKeys(collection)` 只在**索引 membership 仅取决于该集合自身字段**时成立。
> 地理索引成立（对象=device，来源=device.latestPosition）；
> assignment 资格**不成立**（membership 同时依赖 assignment、event.state、device identity），
> 所以那里必须用结构性索引 + 事务内精确谓词。

### 第 3 步验收（`test/assignment-index.test.ts`，9 项全绿）

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 同事务新建 assignment | 立即阻止再次招募 ✅ |
| 2 | assignment 同事务变为退出状态 | 立即不再阻止 ✅ |
| 3 | event 同事务 ACTIVE → 非 ACTIVE | 对应 assignment 立即失效 ✅ |
| 4 | **event 同事务 非 ACTIVE → ACTIVE** | 已有 assignment 立即可见 ✅ |
| 5 | 同 identity 两台设备，一台持有 assignment | 另一台也不得被招募 ✅ |
| 6 | 一台设备多条 assignment，一条退出 | 只要另一条有效就仍算有任务 ✅ |
| 7 | 未绑定设备在本事务内完成绑定 | 按新身份仍能找到 ✅ |
| 8 | **性能**：全库 100,001 条 assignment | 只访问 **≤4** 条 ✅ |
| 9 | 事务回滚 | 已提交索引完全不变 ✅ |

### 第 4 步：delivery 复合索引（唯一性已先核实）

**建索引前先钉死的问题**：`(eventId, deviceId)` / `(eventId, userId)` 是唯一一条还是可能多条？

核实结论：**严格唯一**，三条硬证据：

| 证据 | 内容 |
| --- | --- |
| 单一写入点 | 全局只有 `service.ts:5615` 一处 `state.deliveries[...] =` |
| 单一调用者 | `createDeliveryIfEligible` 只被 `service.ts:5293` 调用一处 |
| 创建前双重守卫 | `deliveryForDevice(...)` 挡设备键、`deliveryForUser(...)` 挡**同一用户任意设备** |
| 键字段不可变 | `eventId` / `deviceInstanceId` 创建后从未被赋值（grep 命中均为比较） |
| 设计已编码 | `messageId` 就是 `response-requested:${event.id}:${device.deviceInstanceId}` |

所以走**最理想分支：单值 Map**

```
deliveryIdByEventDevice : Map<EventDeviceKey, DeliveryId>
deliveryIdByEventUser   : Map<EventUserKey, DeliveryId>
```

并且**不变量本身变成测试**（第 6 项）。违反时**计数上报而非静默取一条**——
因为"随便取一条"会悄悄改变"判定某响应者是否已有 offer"的依据。

原 `.find()` 的选择语义 = 插入序第一条；不变量成立时只有一条，索引返回同一条。

### 第 4 步验收（`test/delivery-index.test.ts`，9 项全绿）

| # | 场景 | 结果 |
| --- | --- | --- |
| 1 | 已提交 delivery 按 (event,device) | 正确命中 ✅ |
| 2 | 已提交 delivery 按 (event,user) | 正确命中 ✅ |
| 3 | 同事务新建 delivery | 两种查询立即可见 ✅ |
| 4 | **本事务内设备完成绑定** | `(event,user)` 键立即可用 ✅ |
| 5 | 旧索引过选 | 事务谓词拒绝，staged key 按新设备找到 ✅ |
| 6 | 多条匹配/不变量被破坏 | 计数上报（两把键各计一次），首条保持权威 ✅ |
| 7 | 回滚 | 已提交索引不变 ✅ |
| 8 | **100,001 条 delivery** | 每次查询 = **单次复合键探测**（共 2 次） ✅ |
| 9 | **跨索引组合资格**（地理 + assignment + delivery + read-your-writes） | 同事务建 delivery / assignment 后立即变为不合格 ✅ |

第 9 项是你要的**跨索引真实业务测试**：一个地理合格、无任务、无投递的响应者 `eligible = true`；
同一事务内创建 delivery 后立即 `false`；同 identity 的另一台设备在同事务内被创建 assignment 后也立即 `false`。

**第 4 项实际暴露了 helper 的一个真实缺口**：设备在本事务内绑定后 `(event,user)` 键在已提交索引里不存在，
而投递本身没被 staged——所以查询必须并入**被 staged 的设备的投递**。已修正并测试锁定。

### 第 3、4 步之后的复杂度目标

```
单个候选设备的资格判断：
  assignment 候选  O(kA)   ← 结构索引
  delivery 设备键  O(kD1)  ← 复合键单次探测
  delivery 用户键  O(kD2)  ← 复合键单次探测
  精确谓词         O(kA+kD)
```

原先的三次全表扫描（assignments / deliveries / deliveries）已全部消除。
**但招募链尚未切到这些索引上** —— 那是第 5 步。

### 第 5 步前置：候选顺序已锁定（`test/recruitment-ordering.test.ts`）

你要求动手前先锁顺序。核实结果**比我预期的更有利**：

| 位置 | 顺序语义 |
| --- | --- |
| `service.ts:5291` 创建 offer 的循环 | `Object.values(state.devices).sort(by deviceInstanceId)` |
| `service.ts:5406` `eligibleResponderDevices` | filter → **sort(by deviceInstanceId)** → identity 去重 |

**两处排序都发生在候选收集之后**，所以结果只取决于"合格设备的**集合**"，
与枚举顺序无关。这意味着换成索引（Map/Set 插入序）**不会改变顺序——前提是排序被保留**。

两条测试锁定：

1. **offer 创建顺序 = `deviceInstanceId` 升序**：故意按**降序**发布三台响应者，
   结果仍是升序——任何依赖枚举序的实现都会不同。
2. **identity 去重保留字典序最小的设备**：一个账号两台设备，先发布**大 id**，
   最终收到 offer 的是**小 id**——因为排序在去重之前。

> **测试本身也抓到我一个错误**：第一版 helper 用 `sort(by delivery.id)` 取"创建顺序"，
> 而 `delivery.id` 是随机 UUID，等于在测随机序。投递以 UUID 为键存在对象里，
> `Object.values` **本身就是插入序**，不该再排。修正后才是真的在测创建顺序。

### 第 5 步结构决定：**一套算法 + 两个适配器**（不是两套算法）

用户修正了"tx 版 + state 版"的方案。采用：

```
RecruitmentContext（接口，按"算法问什么问题"设计，不按集合设计）
   ├── LegacyRecruitmentContext  ← 包装 PersistentState，逐方法等价于现有扫描
   └── TxRecruitmentContext      ← 包装 transactEntities + 三个索引 + 事务 delta
refreshRecruitmentForEvent / advanceRecruitmentStage / createDeliveryIfEligible
   → 只保留一份业务算法
```

**`candidateDevices(event)` 是承重方法**：legacy 返回"全部设备"（顺序与完整性完全不变），
indexed 版可返回"地理索引落在环内的设备 ∪ 本事务改动的设备"——一个由精确谓词再过滤的超集。

**接口必须一起收口 `enqueueNotification` / `appendTimeline`**：不复制 `…Tx()` / `…State()` 两套，
而是保留原有的记录构造逻辑，只把最终写入抽象成 `ctx.insertNotification` / `ctx.appendTimeline`，
以最大限度保证 **ID 生成规则 / payload / 时间戳 / timeline 顺序 / notification 状态初值** 不变。

**分两个提交**：

| 提交 | 内容 | 验收 |
| --- | --- | --- |
| **1（已开始）** | 抽 `RecruitmentContext` + `LegacyRecruitmentContext`，算法改为经 context 访问 | **输出与性能都不变**，现有 269 项测试全部继续通过 |
| 2 | 接 `TxRecruitmentContext`（复用三个索引与事务 delta） | 新旧差分测试全部一致 |

这样若 Tx 版出问题，可以明确区分是 **adapter/索引路径**的问题，而不是**抽象重构本身**的问题。

### 第 5 步本体：尚未开始，这是有意的

第 5 步要把整条招募链切到 `transactEntities`，涉及：

| 待转换 | 写点 |
| --- | --- |
| `refreshRecruitmentForEvent` | event 修订号、delivery 状态、通知、timeline |
| `advanceRecruitmentStage` | `currentRecruitmentRadiusMeters`、`recruitmentStageStartedAt`、`coordinationRevision` |
| `createDeliveryIfEligible` | 新建 delivery（+ 通知 + timeline） |
| `enqueueNotification` / `appendTimeline` | 跨模块自由函数，直接改全状态 |

**且 `tick()` 也在调用 `refreshRecruitmentForEvent`**（走全状态 transact），
所以必须同时提供 tx 版与 state 版，或抽出共同抽象——不是单点改动。

**我选择不在本轮硬推。** 理由是本轮已经出现过两次真实回归
（`acceptedResponder` 豁免被基线抓到、地理索引事务内读到过期数据），
都是"改得快、验证慢"造成的。这条链是整个系统最安全敏感的部分，
而你的验收标准本身要求"**行为完全一致，但全表扫描消失**"——这需要完整的行为对照，不是一次冲刺。

### 第 5 步的收尾门槛（沿用你的定义）

| 项目 | 要求 | 现状 |
| --- | --- | --- |
| 招募正常路径 | 完全使用 `transactEntities` | ⬜ |
| devices / assignments / deliveries 全扫描 | 各 0 | ⬜ |
| `recruitmentFallbackRuns` | 0 | 仍非 0（保留作回归信号） |
| read-your-writes | 位置/delivery/assignment/identity 四类 | ✅ 已测 |
| rollback | committed state/index 不污染 | ✅ 已测 |
| **候选顺序** | 与旧行为一致 | ✅ **本轮已锁** |
| 大规模无关数据 | 访问实体数基本不增长 | 索引层已测（10 万档），链路层待测 |
| 原 fallback | 保留，不删除 | ✅ 保留 |

### tick() 不并入第一批（用户要求）

`tick()` → full-state transaction → `refreshRecruitmentForEvent()`。
为了让它也走 Tx 上下文，会把整个 tick 状态机一起拖进增量事务，**范围会突然扩大**。

所以第一阶段：

```
updateResponderPosition 等已有 tx 上下文的入口  → TxRecruitmentContext
tick()                                          → LegacyRecruitmentContext
```

这意味着 `recruitmentFallbackRuns` 全局**暂时仍可能非 0**。因此指标要拆清：

| 指标 | 含义 |
| --- | --- |
| `indexedRecruitmentRuns` | 经 Tx 上下文执行的招募刷新次数 |
| `legacyRecruitmentRuns` | 经 Legacy 上下文执行的次数（含 `tick()`） |

**只有等 `tick()` 自己也迁到增量事务后，才要求 `legacyRecruitmentRuns = 0`。**
不要为了提前把计数归零而扩大重构范围。

### quota

`recruitmentFallbackRuns` **迁移期间保留**，不要现在删。
它从一个"待办标记"变成了**回归信号**：正常 indexed 模式下应为 0，一旦 > 0 就说明有路径退回了旧行为。

## 9. 一句话总结

> 定稿后的关键修正有三条：**①** 写吞吐预期改由真实变更事务测量（fsync 2.88 ms，
> 存储层 248/s），只作预期不作承诺；**②** "全库遍历已消除"必须由
> **结构门槛**（访问范围与处理成本不随无关历史增长、全库 clone/flatten/历史比较调用为 0）证明，
> **不能用两组耗时相减**；**③** 影子校验是临时机制，**切换点是第一个历史集合不再常驻内存之前**，
> 之后由隔离新旧对照替代。
> 另外待命位置上传在事务内仍有 `O(事件)×O(投递)` 扫描，
> **必须把索引与收窄一并放进 Phase 1**，否则第一个用例就是假优化。
