# 交接：位置上传路径切到实体事务（4b-2.2）

> 本文档是给接手 agent 的**自包含**交接。它不假设你读过任何对话历史。
> 所有事实都在本仓库中可验证；每条断言都注明了验证方式。
> 交接基线：修改前工作区 `service.ts` md5 = `745043d20d55ae09c0a9019c17b825ba`。

---

## 0. 一句话任务

把 `AEDResponseService.updateResponderPosition` 中
「有活跃招募事件 → 退回全量 `store.transact`」这条分叉**删掉**，收敛成一次
`store.transactEntities`：位置 + 回执 + 招募副作用属于同一个增量事务。
**保持业务输出与拒绝语义逐字不变。**

这是 Phase 1 从 O(全库) 切到 O(Δ+相关集) 的关键开关。

**当前状态（2026-09-12）：已接通。** 位置、回执与招募副作用统一进入一次实体事务。
切换前的诊断历史保留于 §4；本轮实证修正、463 项验证与未完成边界见 **§11**。

---

## 1. 不可协商的约束（违反任何一条都算做错）

### 1.1 业务语义不得改变

- 资格判断谓词、`deliveryIsLive` 的 `<=` 边界、identity 去重、副作用顺序**全部不得改动**。
- **招募范围**：旧代码两条路由的范围**本来就不同**——
  - 有相关事件 → 全量路径 → 刷新**所有** ACTIVE+RECRUITING 事件
  - 无相关事件 → 增量路径 → **完全不跑招募**
  这是既有行为，必须保留（见 §4.2 的 `relevantEventIds` gate）。
- 用户明确点名**不要改**：10 分钟位置阈值、ACTIVE-participant 豁免、prune 调用时机、
  `presenceView` 语义、排序规则、`deliveryIsLive` 状态集。

### 1.2 已冻结的架构规则

| 规则 | 内容 |
|---|---|
| 上下文三态 | `draft`（读传进来的对象，事务内唯一可用）／`committed`（读已提交索引，只读调用点）／`transaction`（已提交索引 ∪ 本事务 staged delta）。**draft 工厂不接受索引参数**——让错误不可表达 |
| 索引只给候选**键** | 业务实体一律从**当前视图**回读。committed 索引命中**不得**返回旧对象 |
| 并集原则 | committed 索引 ∪ `tx.stagedKeys(...)`。过选安全，**漏选才是 bug** |
| 去重归适配器，排序归算法 | |
| 一次真实事务 = 一个 Tx 上下文 | 不得每个 helper/每个 event 重建；**不得跨事务缓存** |
| 只允许能力检测式 fallback | `!store.transactEntities` → 退 Legacy。**禁止**「Tx 抛错后 catch 再跑 Legacy」——Tx 可能已产生 staged 副作用 |

### 1.3 操作纪律（用户强制要求）

- **禁止跨层级正则批量替换。** 本会话已因此损坏过文件两次。
- 修改前**保留快照**；**每处替换都要断言锚点**（`assert s.count(old) == n`）。
- **恢复依据必须是修改前状态**，不能用「恢复后的 git status」反推此前无修改。
- 生产路径改动前先取全文件 md5。
- **不提交、不推送、不建 PR、不部署、不动生产数据。**

---

## 2. 如何验证（先跑这两条）

```bash
cd backend
npm run check     # 必须 0 error
npm test          # 当前 463 pass / 0 fail（切换前基线 404）
```

测试计数演进：269 → … → 402 → 404 → **463**。任何一轮结束时必须全绿。

**注意**：`npm test` 跑全套约 1–2 分钟，输出很长。只跑单个文件：
`npx tsx --test --test-concurrency=1 test/<file>.test.ts`

### 2.1 严禁「假绿」——本会话已抓到 5 次

这些是本会话真实踩过的坑，请主动防范：

1. **计数从未自增**：Tx 适配器一度完全不计数，导致「结构：访问计数不随无关历史增长」三项断言全是 `0 == 0`，**空转通过**。→ 新路径上线前先确认计数确实会动。
2. **fixture 替被测代码做决定**：把 500 台「无关历史」设备放在环内坐标，它们本就是合法候选，计数**应该**增长。
3. **逐集合断言测不到跨集合顺序**：分别断言 notifications 与 timeline 的内容，**重排不会红**。需要统一的 `writeLog()` 序列。
4. **`.some()` 短路**：用「跑满全表」的断言去量一个会短路的扫描，数字对不上。
5. **测试名与被测内容不符**：一条叫「capability fallback」的测试实际只断言了 `tick()` 的 legacy 计数，**根本没碰 fallback 计数器**。已删除。

**每一轮新增的行为锁，都要做破坏性验证：故意改坏实现，确认对应测试真的变红。** 本会话多次出现「破坏了但测试仍绿」= 测试没有判别力。

---

## 3. 已完成且已验证的部分（不要重做）

### 3.1 招募链已全部 ctx 化（9 个函数）

`acceptedDeviceIds`、`patientViewerDeviceIds`、`coordinationAudienceDeviceIds`、
`isEligibleResponderDeviceBase`、`isEligibleNearbyResponder`、`eligibleResponderDevices`、
`recruitmentPotentialDevices`、`createDeliveryIfEligible`、`advanceRecruitmentStage`、
`refreshRecruitmentForEvent`。

外部业务模块（`event-resolution` / `responder-exit` / `status-confirmation`）的 DI 边界
**仍保持 `(state, event) => …` 原签名**，不知道 `RecruitmentContext` 存在。

### 3.2 四把索引 + 一个投影

| 件 | 文件 | 说明 |
|---|---|---|
| 地理索引 | `src/device-position-index.ts` | 网格，`query(lat,lon,radius)` |
| assignment 索引 | `src/assignment-index.ts` | `assignmentIdsForDevice` / `deviceIdsForIdentity` |
| delivery 索引 | `src/delivery-index.ts` | 复合键 + **`deliveryIdsForEvent`**（本轮新增，按创建顺序） |
| 位置过期索引 | `src/position-expiry-index.ts` | 最小堆 |
| 投影 | `src/state-projections.ts` | 含分组投影 `deliveriesByEventId`、`activeRecruitingEvents`、**`aedReceiptsByEventId`** |

### 3.3 Tx 适配器（已接入位置业务事务）

- `src/tx-recruitment-context.ts` — `txRecruitmentContext(tx, indexes)`，`mode: "transaction"`
- `src/coordination-aed-reader.ts` — 窄接口 `acquiredAedCount(eventId): number`，
  含 `legacyCoordinationAedReader` 与 `txCoordinationAedReader`

**验证方式**：`rg -n "txRecruitmentContext" backend/src/`，`service.ts` 有一处导入、一处工厂调用；每次真实位置事务仅创建一个上下文。

### 3.4 指标语义（4b-2.1 已完成）

`src/runtime-metrics.ts`：

| 字段 | 含义 | 计数口径 |
|---|---|---|
| `indexedRecruitmentRuns` | 真正跑 `transactEntities` + Tx 上下文 | **一次外部 operation 计一次，不按 event 数** |
| `legacyRecruitmentRuns` | 设计上仍 Legacy（`tick()`） | 同上 |
| `recruitmentFallbackRuns` | 本该 indexed，**能力缺失**被迫退回 | 同上，**唯一告警数** |

`tick()` 的 `+= 1` 在循环**之外**，且**不计 fallback**。

### 3.5 本轮修复：delivery 索引陈旧（**已保留，重要**）

`MemoryStateStore.transact`（全量路由）提交后重建了 expiry / position / assignment，
**漏了 delivery**：

```ts
this.expiryIndex.rebuild(this.state.devices as never);
this.positionIndex.rebuild(this.state.devices as never);
this.assignments.rebuild(this.state as never);
this.deliveries.rebuild(this.state as never);   // ← 本次补上
```

**为什么以前没暴露**：Legacy 招募适配器直接扫 `state.deliveries`，从不读索引；
Tx 适配器是第一个索引化的 delivery 读者。

**已加回归守卫**：`test/delivery-index-route-consistency.test.ts`。
该文件最初是**记录缺陷**的（断言索引确实陈旧），修复后改为断言正确行为。

---

## 4. 切换前阻塞记录（历史诊断；本轮修正见 §11）

### 4.1 现象与证据

应用切换后 `npm test` = **402/404**。两个失败：

**(a) `test/presence-access.test.ts` → "response stage performs no whole-state read…"**

```
assert.equal(storage.fullStateClones.transactionDraft, 1);  // actual: 0
```

**这是好消息，不是缺陷。** 测试写死了切换前的基线（注释原文：
"Remaining whole-state clones belong to the not-yet-migrated write path"）。
切换后位置上传不再克隆整树，所以期望值应改为 **0**。这正是切换要交付的结构收益。

**(b) `test/api.integration.test.ts` → "an R update after activation creates and expires an offer as radius eligibility changes"**

```
Error: Socket.IO event:coordination-updated timeout
```

插桩结果：

```
DBG-PROJ {"has":true,"size":1}   ← 首次探针：事件在投影里（按距离正确拒绝，响应者在 11km 外）
DBG-PROJ {"has":true,"size":0}   ← 之后恒为 0
DBG-GATE {"applied":true,"relevant":0}   ×N
DBG-UPDATES {"updates":0,"ran":false}
```

**根因方向**：`ACTIVE_RECRUITING_EVENTS` 投影在一次**只写 devices 与回执**的实体事务提交后，
从 size 1 变成 **0**。于是 `relevantEventIds` 恒空 → 招募不运行 → 无 `coordination-updated` → 超时。

### 4.2 已排除的假设（都有证据，别重复查）

| 假设 | 结论 | 证据 |
|---|---|---|
| store 索引在实体事务提交后未维护 | **不成立** | `store.ts` 的 `transactEntities` 提交尾段确实调用 `projectionRegistry.applyChanges` 与三个索引的 `applyChanges`/`applyDeviceChanges` |
| `state-projections.applyChanges` 分桶逻辑错误 | **不成立** | 它按 `change.collection` 分桶，只处理变更集里出现的集合；设备变更不应触碰 events 组 |
| `createDeliveryIfEligible` 的 guard 被绕过 | **不成立**（对本失败） | 双重 guard 完好；该测试的失败发生在招募根本不运行之后 |
| delivery 索引陈旧导致重复发单 | **成立且已修** | 见 §3.5 |

### 4.3 下一步诊断（建议，未做）

在测试驱动下复现，**不要动生产路径**：

1. 插桩 `SQLiteStateStore.transactEntities` 的提交尾段：
   - `changes` 里各 collection 的计数
   - `projectionRegistry.applyChanges(changes)` 前后，`activeRecruitingEvents` 的
     `stale` 标记与 `entries.size`
2. 插桩投影**重建源**：`activeRecruitingEvents` 的 `derive` / `groupKey` 是在哪个集合上定义的，
   重建时读到的 `this.state.events` 里该事件的 `state` 与 `recruitmentState` 是什么。
3. 关键问题：**一次 devices-only 提交为何会让 events 组消失**——
   是 `invalidateAll()` 被调用且重建得空，还是 `applyChanges` 误删了成员。

一旦定位，`presence-access` 那条期望值改 0，切换即可完成。

---

## 5. 4b-2.2 的切换前目标草图（已落地，以源码和 §11 为准）

`updateResponderPosition` 中：

```ts
if (!transactEntities) {
  operationMetrics.recruitmentFallbackRuns += 1;   // 唯一允许的 fallback 理由
  ... 保留现有全量路径作为能力回退 ...
}

operationMetrics.incrementalPathRuns += 1;
let recruitmentRan = false;
const incremental = await transactEntities(tx => {
  // 1. 从 tx 视图读设备 + 原有三项校验（协议/定位能力/活跃患者）
  // 2. tx.update 位置
  // 3. recordPositionReceiptInTransaction
  // 4. 招募（见下）
  return { position, updates };
});
if (recruitmentRan) operationMetrics.indexedRecruitmentRuns += 1;
```

招募块：

```ts
const updates: RecruitmentUpdate[] = [];
if (position.applied && relevantEventIds.length > 0) {   // ← 范围与旧行为一致，见 §1.1
  recruitmentRan = true;
  const ctx = txRecruitmentContext(tx, {
    devicePositions: { query: (lat, lon, r) => this.store.devicePositions?.()?.query(lat, lon, r) ?? [] },
    deliveryIdsForEvent: id => [...(this.store.deliveryIndex?.()?.deliveryIdsForEvent(id) ?? [])],
    assignmentIdsForDevice: id => [...(this.store.assignmentIndex?.()?.assignmentIdsForDevice(id) ?? [])],
    deviceIdsForIdentity: key => [...(this.store.assignmentIndex?.()?.deviceIdsForIdentity(key) ?? [])]
  });
  const aed = txCoordinationAedReader(tx, { receiptIdsForEvent: receiptIdsForEventFrom(this.store) });

  const candidateEventIds = new Set<string>();
  for (const [eventId] of this.store.projections?.()?.read(ACTIVE_RECRUITING_EVENTS) ?? []) {
    candidateEventIds.add(eventId);
  }
  for (const key of tx.stagedKeys("events")) candidateEventIds.add(key);

  for (const eventId of candidateEventIds) {
    const event = tx.get("events", eventId);     // 实体必须来自事务视图
    if (!event) continue;
    if (event.state !== "ACTIVE" || event.recruitmentState !== "RECRUITING") continue;
    const refreshed = this.refreshRecruitmentForEvent(ctx, event, this.now());
    if (refreshed.changed) {
      updates.push(this.recruitmentUpdate(ctx, aed, refreshed.event,
        refreshed.requests, refreshed.previousAudience, refreshed.expiredOffers));
    }
  }
}
```

**注意 `relevantEventIds` 的语义**：它是「**是否至少有一个**相关事件」的探针
（`limit: 1` + 首个命中即 break），**不是**刷新清单。用它的单 id 当工作清单会静默漏掉
第二个及以后受影响的事件。已有测试锁住这一点：
`test/relevant-event-probe.test.ts`。

---

## 6. 切换验证清单（已补测试，成本范围与结果见 §11）

按顺序，**全绿才叫完成**：

1. **原子性**：位置 / 回执 / event / delivery / timeline / notification 任一步失败 →
   全部回滚，且 committed 索引不变。证明位置与招募属于同一增量事务。
2. **完整 `updateResponderPosition` Legacy↔Tx 差分**（不再只测招募 helper）：
   比较 response body、`latestPosition`、回执、event、deliveries+顺序、
   notifications+顺序、timeline+顺序、`recruitmentUpdate`、coordination summary、revisions。
   重点场景：同 identity、刚进圈、刚出圈、刚绑定 user、已有 active assignment、
   staged receipt、**多个 ACTIVE+RECRUITING 事件**。
3. **结构指标**（固定相关数据，扩大无关历史）：
   `fullStateClones = 0`、`fullStateFlattens = 0`、`unrelatedHistoryCompared = 0`、
   `deviceCandidatesVisited` / `deliveryCandidatesVisited` / `assignmentCandidatesVisited` /
   `aedReceiptCandidatesVisited` **只随相关集增长**。
4. **`recruitmentFallbackRuns` 端到端覆盖**（4b-2.1 明确留下的未覆盖项）：
   能力缺失 → fallback +1；`tick()` → legacy +1 且 fallback 不动；
   正常 Tx 招募 → indexed +1。
5. 更新 `test/presence-access.test.ts` 的 `transactionDraft` 期望值为 0。

**完成定义**：有活跃招募事件的位置上传，只处理本次设备、相关事件与相关派生实体，
**不再因为「有事件」退回全量状态事务**。

---

## 7. 之后仍未完成的 Phase 1 验收（不属于本轮）

| 项 | 状态 |
|---|---|
| §4.1 容量门槛 **≥200 次/秒**真实位置变更 | **未测**。文档中的 248/s 是存储层微基准，**不是**本接口基线；本接口真实基线是 **10.24 次/秒**（线上实测，54 用户） |
| §5.2 存储层整体新旧对照（跨命令、含拒绝路径与证据内容） | 组件已有（招募差分、Legacy↔Tx），整体未建立 |
| 增量校验规则覆盖审计 | 未做 |
| 正常路径全量操作计数 | 未做 |
| `replanAssignments` 的 STALE 处理 | 独立 RISK/PRODUCT DECISION，需先做全路径审计 |
| `deliveryForUser` 对 JS 对象枚举顺序的隐式依赖 | 已登记。索引侧已按创建顺序维护，但**重启后 SQLite 加载顺序**仍可能不等于业务创建顺序。Phase 1 保持 Legacy runtime 语义，不在此轮解决 |
| assignment 在 Tx 适配器中的扫描 | **已解决**（4b-1.1 接入索引） |

---

## 8. 文件清单

**核心实现（新增，未跟踪）**
```
backend/src/entity-transaction.ts        实体事务
backend/src/tx-recruitment-context.ts    Tx 招募适配器（已接入位置事务）
backend/src/recruitment-context.ts       招募访问契约 + draft/committed 两态
backend/src/coordination-aed-reader.ts   窄 AED reader（Legacy + Tx）
backend/src/state-projections.ts         投影注册表
backend/src/device-position-index.ts     地理索引
backend/src/assignment-index.ts          assignment 索引
backend/src/delivery-index.ts            delivery 索引（含 deliveryIdsForEvent）
backend/src/position-expiry-index.ts     过期索引
backend/src/presence-access.ts           presence 视图访问
backend/src/runtime-metrics.ts           指标
```

**修改**
```
backend/src/service.ts                  ← 位置主路径切换；实际修复文件见 §11
backend/src/store.ts                    ← 已含 delivery 索引修复（§3.5）
backend/src/notification-outbox.ts      ← 抽出 notificationRowFor（Legacy/Tx 共用）
backend/src/event-audit.ts              ← 抽出 timelineEntryFor（Legacy/Tx 共用）
backend/src/response-decision.ts        ← 闭包捕获修复
backend/src/responder-exit.ts           ← 闭包捕获修复
backend/src/watch-event-creation.ts     ← recruit 钩子返回当前 event
```

**关键测试**
```
test/recruitment-differential.test.ts       冻结基线差分（字节级提取自 HEAD）
test/baseline/recruitment-baseline.ts       逐字复制的重构前实现
test/tx-recruitment-context.test.ts         Legacy↔Tx 行为 + 事务 + 结构
test/relevant-event-probe.test.ts           探针 ≠ 刷新清单（4b-2.2 的前提）
test/delivery-index-route-consistency.test.ts  两条路由索引一致性（回归守卫）
test/recruitment-run-metrics.test.ts        三指标语义
test/tx-coordination-aed-reader.test.ts     Tx AED reader
test/helpers/staged-recruitment-context.ts  共享 staged 替身（唯一一份）
```

**文档**：`docs/storage-refactor-plan-final.md`（§0–§9，含 8bis.1–8bis.16 各轮记录）

---

## 9. 已经付出代价才拿到的教训（请勿重蹈）

1. **规则从实现里读，不从名字或直觉推。** 本会话 6 次因此猜错：
   扩环规则、`deliveryIsLive` 状态集、招募范围随路由变化、AED reader 的读集等。
2. **`aeds` 运行期从不写入**（`Aed[]`，fixture 注入，全库无赋值），
   `aedReceiptsById` **会**被写（`aed-actions.ts`）。
3. **索引只给候选键，实体回读当前视图。** 混淆会静默出错。
4. **破坏性验证 ≠ 跑一遍确认绿**，而是**确认被破坏时会红**。
   本会话有多次「破坏了但测试仍绿」，那些测试当时没有判别力。
5. **不要为了对称建索引**，只在存在真实扫描时按实际查询形状补。
6. 正则批量替换在本会话造成过两次文件损坏，其中一次是 Python 里
   `X if False else s` 被求值成整个文件内容。**逐处断言锚点。**

---

## 10. 立即行动项

1. 本轮切换与回归已完成，**不要重做** §4 的已被本轮证据修正的诊断。
2. 先读 §11，再按授权范围推进 §7；完整接口成本仍有实测残留，不能跳过。


## 11. 2026-09-12 接通结果与证据边界

### 11.1 实际实现

- `updateResponderPosition` 仅在 `!transactEntities` 时能力回退；相关事件不再触发全量业务事务。
- 位置 + 位置回执 + event/delivery/timeline/notification 入列属于同一次真实实体事务；提交成功后才 drain / publish。Tx 失败直接抛出，绝不 catch 后重跑 Legacy。
- 保留原范围：`position.applied && relevantEventIds.length > 0` 才招募；命中后遍历全部 ACTIVE+RECRUITING 候选键与 staged event 键的并集，并从 tx 回读。
- 一次事务一个 Tx 招募上下文和一个 AED reader；缺投影/索引时保持实体事务，使用现有窄扫描能力回退，不用空数组冒充完整候选集。
- 实测还原了患者受众：Tx 地理候选必须并入 `event.patientDeviceIds` 和患者 identity 对应设备，再并入 staged devices。没有 R 位置的患者与同用户其他 iPhone 也必须通过原谓词被保留。
- 患者通知顺序也有业务可见性：`AssignmentIndex.deviceOrdinal` 保留设备集合枚举顺序，合并候选后按该元数据恢复顺序。已有键更新/绑定不移位，新建键按 mutationOrdinal；响应者选择的原有业务 sort 不变。这是恢复旧枚举顺序，不是新增选择规则。
- SQLite constructor 补建 assignment/delivery 索引；关闭 instrumentation 的全量提交分支也维护投影与四索引，防新路径在重启或关闭计时时漏读既有实体。

### 11.2 对 §4 历史诊断的实证修正

当前源码在仓库外副本按草图切换后，可复现 `event:coordination-updated timeout`，但 devices/回执-only 事务前后投影 **size 均为 1**，源事件持续 ACTIVE/RECRUITING。本轮没有复现“投影被清空”，也没有据此改写 `ProjectionRegistry.applyChanges`。

实际根因是 `patientViewerDeviceIds` 共用 `ctx.candidateDevices`，地理候选漏了没有 R 位置的患者，因此没有患者协调通知。只补患者候选并集即可使原 API 测试通过。随后完整差分又检出了多个患者设备的通知顺序变化，已通过集合顺序元数据修复。

两种真实 store 的 devices/回执-only 投影保留测试现为回归守卫；在隔离副本故意清空投影时两条均失败。

### 11.3 验证

- 修改前：`npm run check` 0 error；`npm test` **404/404**。
- 修改后：`npm run check` 0 error；`npm test` **463/463**；`npm run build` 通过；`git diff --check` 通过。
- 新增 **59** 项：完整位置差分 33、事务/结构/运行计数 19、SQLite 生命周期 3、真实投影保留 2、设备 ordinal 生命周期 2。
- 原子性：Memory/SQLite 各六类写入后注入异常，所有业务实体、四索引、三个投影不变；SQLite 重开后也不变。成功路径实际包含六类 staged 写入且仅一次业务实体事务，真实 outbox 继续执行。
- 差分覆盖返回体、拒绝 JSON、latestPosition、64 条回执留存、event/revisions、delivery/notification/timeline 与跨集合 writeLog 顺序、recruitmentUpdate、coordination、实际通知发送；含同 identity、进圈/出圈、staged user/receipt、active assignment、多个事件、无 R 位置患者、患者副设备、缺索引能力与 expiry 等号边界。
- `presence-access` 的 transactionDraft 期望已改为 0；其 normalization=1 明确来自测试中启用的 shadow validation，不冒称该配置零全量克隆。
- 能力缺失→fallback+1；正常 Tx 招募→indexed+1；tick→legacy+1、fallback 不动。
- 破坏性验证在仓库外副本执行，包含恢复 Legacy 分叉、删 staged 并集、错读旧设备、漏 assignment/AED、只刷新探针首事件、删 gate、改回放/回执留存/expiry 边界/拒绝文本、调换跨集合顺序、清空投影、打乱 ordinal；另有错误提交前缀和全库地理候选的负控制。对应守卫均能变红，正式代码保留正确实现。

### 11.4 成本结果：必须区分业务事务与完整接口

测试使用合成状态、真实 Memory/SQLite，instrumentation 开启、shadow validation 关闭。固定相关集、无关历史 **0→250**：

| 范围 | devices | deliveries | assignments | AED receipts |
|---|---:|---:|---:|---:|
| 业务事务候选访问 | 14→14 | 16→16 | 4→4 | 1→1 |
| 无待发送通知的完整 operation | 14→14 | 17→267 | 5→255 | 1→1 |

业务事务的 fullStateClones / fullStateFlattens / historyComparedEntities 均为 **0**；上述四类候选计数真实非零。

**不能把这一结果表述成完整接口已达到 O(Δ+相关集)**：

- 完整 operation 的 `presenceView` 尾段仍使 delivery/assignment 访问随无关历史增加。
- 新建通知时真实 `NotificationOutbox.drain` 的 attempts/dispatch/completion 仍做全量事务/读取；测试没有 stub 掉它，也明确断言有额外全量成本。
- 现存 `tx.keysWhere`（活跃患者、位置回执留存等）、presence collection materialization 及分组投影维护仍需整体访问审计；候选计数不是所有扫描的总工作量。
- **≥200 次/秒的真实位置接口容量未测**，也未做生产/真机/部署验证。§7 仍未验收。

### 11.5 文件、快照与续做约束

本轮实现：`src/service.ts`、`src/tx-recruitment-context.ts`、`src/assignment-index.ts`、`src/store.ts`；接口契约说明同步于 `src/recruitment-context.ts`。测试新增 `test/responder-position-differential.test.ts`、`test/responder-position-transaction.test.ts`、`test/sqlite-index-lifecycle.test.ts`，并修改 `test/state-projections.test.ts`、`test/assignment-index.test.ts`、`test/presence-access.test.ts`；`package.json` 已加入全套清单。

- service.ts 当前 md5：`3e51f1da6e4ffa42eec3d4c5f0cac663`。
- 主修改前快照与完整初始 diff/status：`/var/folders/39/811t3lrx5779_h84h35lmxvr0000gn/T/aed-position-path-fgv7nkfo`。
- 投影/API/ordinal 隔离证据：`/var/folders/39/811t3lrx5779_h84h35lmxvr0000gn/T/aed-projection-diagnosis-acd20ltk`。
- 差分变异记录：`/var/folders/39/811t3lrx5779_h84h35lmxvr0000gn/T/aed-position-differential-mutants-fkj1qfro/mutation-results.json`。
- 本轮基线/最终测试日志：`/tmp/aed-position-baseline-{check,test}.log`、`/tmp/aed-position-final-{check,test,build}.log`。

既有 dirty 内容完整保留；不提交、不推送、不建 PR、不部署、不动生产数据。后续先针对 §11.4 的全路径成本制定独立验收，再做 §7 的接口容量验证；继续冻结资格、位置阈值、ACTIVE 豁免、prune 时机、受众谓词与业务排序。
