# 全量校验与存储架构说明（供外部评审）

> 目的：把 AEDResponse 后端存储层的架构、写路径、校验语义和实测成本讲清楚，
> 使不了解本代码库的人（或另一个模型）也能据此独立评审。
> 所有代码引用指向 `backend/src/store.ts`（1489 行）与 `backend/src/state-read.ts`（47 行）。
> 标注 **[实测]** 的数字来自 2026-09-11 在 Azure 联调机上跑的压测（`docs/load-test-2026-09-11.md`）；
> 标注 **[代码事实]** 的是直接读源码得出的结论，未经单独计时。

---

## 1. 系统定位：为什么这里会有"不可变证据"的需求

AEDResponse 是一个 iPhone + Apple Watch 的 AED（自动体外除颤器）志愿协同系统。
Watch 检测到跌倒 → 用户确认需要帮助 → 后端成立一个救助事件 → 招募附近志愿者 → 志愿者导航取 AED。

关键点：**事件期间产生的数据是救助过程的证据链**，包括

- 患者与响应者的事件级位置（严格每秒一个"秒槽"，`FIX` 或 `NO_NEW_FIX`）
- 响应请求的送达/查看/接受回执
- 任务分派（谁去哪、什么角色、第几版）
- 状态确认（"是否仍在进行"）的发送与回答
- 事件终态与结束归属

需求明确规定这些**只能追加、不能被普通业务删除或改写**（`docs/requirements.md:148`）。
这不是普通的 CRUD 应用，"证据不可被静默篡改"是产品的核心正确性属性。
**后面所有的架构选择，包括全量校验，都是为这个属性服务的。评审时请把这个前提放在最前面。**

---

## 2. 数据模型：一棵常驻内存的全量状态树

[代码事实] `PersistentState`（`backend/src/models.ts:554`）是**单一根对象**，包含：

```
schemaVersion: "2.0"
users, accounts, accountIdByProviderKey,
authChallengesById, companionLinkTicketsByHash,
devices, sessionsByTokenHash,
events, deliveries, assignments, timelineByEventId,
aedReceiptsById, aedReceiptIdByBusinessKey, aedReceiptIdByEventAed,
aedUnavailableByReportId, resolutionsById,
notificationOutboxById, participantExitsById, participantIntervalsById,
eventPositionBatchesById, quarantinedLegacyEventPositionBatchesById,
positionUpdateReceiptsById, presenceUpdateReceiptsById,
deletionRequestsById,
aeds: Aed[]
```

即 **24 个 `Record<string, T>` 集合 + 1 个 `aeds` 数组**。
除了 `aeds`（预置的 AED 清单，2 条），全部是**只增不减**或"只增 + 有限状态迁移"的集合。

整棵树**常驻进程内存**（`SQLiteStateStore.state`，`store.ts:1283`），SQLite 是它的**持久化物化视图**，不是查询引擎。
业务代码（`service.ts`，5496 行）**直接读写这棵树**——没有 ORM、没有 SQL 查询层、没有 repository 抽象。

---

## 3. 存储接口与三个实现

[代码事实] `StateStore`（`store.ts:23`）只有三个方法：

```ts
export interface StateStore {
  read<T>(reader: (state: Readonly<PersistentState>) => T): T;          // 全量读
  readEntities?<T>(reader: (view: StateReadView) => T): T;             // 可选：实体读
  transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T>;
  close?(): void | Promise<void>;
}
```

| 实现 | 用途 | 持久化 |
| --- | --- | --- |
| `MemoryStateStore`（`store.ts:1049`） | 单元/集成测试 | 无 |
| `JsonFileStateStore`（`store.ts:1080`） | 旧格式兼容 | JSON 文件 |
| `SQLiteStateStore`（`store.ts:1282`） | 线上 | SQLite（WAL） |

三者的 `transact` 结构相同，只在持久化步骤分叉。

---

## 4. 写路径：`transact` 的六步（核心）

[代码事实] `SQLiteStateStore.transact`（`store.ts:1399-1415`）逐字：

```ts
transact<T>(mutation: (draft: PersistentState) => T | Promise<T>): Promise<T> {
  if (this.closing || this.closed) { ... }
  const operation = this.queue.then(async () => {          // ① 单写者串行队列
    if (this.closed) throw new Error("SQLite state store is closed");
    const draft = cloneState(this.state);                  // ② 全树深拷贝
    const result = await mutation(draft);                  // ③ 业务只改几条记录
    const validated = validateState(draft);                // ④ 全树校验（520 行代码）
    assertAppendOnlyHistory(this.state, validated);        // ⑤ 全树不可变检查
    this.persistChanges(this.state, validated);            // ⑥ 全量 flatten + diff + 提交
    this.state = validated;                                // ⑦ 整根替换
    return result;
  });
  this.queue = operation.then(() => undefined, () => undefined);
  return operation;
}
```

`cloneState` 就是 `structuredClone`（`store.ts:77`）：

```ts
function cloneState(state: PersistentState): PersistentState {
  return structuredClone(state);
}
```

### 逐步说明

**① 单写者串行队列** — 所有事务排在一条 `Promise` 链上。这是**进程内**的串行化：没有锁、没有 MVCC、没有并发提交。这意味着**写吞吐量的上限 = 1 / 单次事务耗时**，与客户端并发数完全无关。
（跨进程更严格：SQLite 单写者 + 内存树各自一份副本，所以实现明确禁止多进程共享，见 `backend/deploy/azure/README.md:34`。）

**② 全树深拷贝** — 复制**整个数据库**，不是复制要改的记录。这是朴素 copy-on-write：为了保证事务失败时 `this.state` 不被污染，改的是副本。

**③ mutation** — 业务逻辑在 draft 上跑。典型的一次待命位置上传只改 `devices[某设备].latestPosition` 一个字段。

**④ `validateState(draft)`** — 见第 5 节。校验**整棵树**。

**⑤ `assertAppendOnlyHistory(previous, next)`** — 见第 6 节。对比**改前全量快照**与**改后全量快照**。

**⑥ `persistChanges`** — `store.ts:1448`：

```ts
private persistChanges(previous: PersistentState, next: PersistentState): void {
  void previous;                                    // 由缓存的 flattenedState 作为比较基准
  const before = this.flattenedState;
  const after = flattenState(next);                 // 全量 flatten 成 Map<identity, {collection,item_key,payload}>
  if (before.size === after.size) {                 // 快速判定 no-op
    let unchanged = true;
    for (const [identity, item] of before)
      if (after.get(identity)?.payload !== item.payload) { unchanged = false; break; }
    if (unchanged) return;
  }
  const upsert = ...;  const remove = ...;
  const write = this.database.transaction(() => {   // SQLite 事务
    for (const [identity, item] of after)
      if (before.get(identity)?.payload !== item.payload)
        upsert.run(item.collection, item.item_key, item.payload);
    for (const [identity, item] of before)
      if (!after.has(identity)) remove.run(item.collection, item.item_key);
    // revision += 1
  });
  write();
  this.flattenedState = after;                      // 提交后才推进缓存
}
```

存储布局是一张**键值表**（`state_items(collection, item_key, payload)`），
payload 是**把每个实体单独 `JSON.stringify` 后的字符串**。**diff 的单位是实体**，
比较方式是 **JSON 字符串相等**。所以一个实体内任何字段变了，整条实体重新序列化并 upsert。
`SQLiteStateStore` 的打开参数是 `journal_mode = WAL`、`synchronous = FULL`、`foreign_keys = ON`（`store.ts:1310-1312`）。

**⑦ 整根替换** — `this.state = validated`。

### 复杂度

设 `E` = 状态树中的实体总数，`Δ` = 本次事务实际改动的实体数。

| 步骤 | 复杂度 |
| --- | --- |
| ② 深拷贝 | **O(E)** |
| ④ 全量校验 | **O(E)** |
| ⑤ 不可变检查 | **O(E)**（含对历史记录的 `isDeepStrictEqual` 深比较） |
| ⑥ flatten + diff | **O(E)** |
| ③ 业务逻辑本身 | O(Δ) |
| SQLite 实际写入 | O(Δ) |

**单次事务成本 = O(E)，与 Δ 无关。** 改 1 个字段和改 1000 条记录一样贵。
这是整个容量问题的数学根源。

---

## 5. `validateState`：全量校验到底校验什么

[代码事实] `validateState`（`store.ts:528`）从第 528 行延伸到约第 1047 行，**约 520 行**。
它在**每次事务提交前**对**整棵树**执行以下四层检查：

### 第一层：`normalizeState` —— 规范化（内部又克隆一次）

```ts
function normalizeState(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = structuredClone(value) as Record<string, unknown>;   // ← 第二次全树深拷贝
  delete normalized.watchReachabilityReceiptsById;
  for (const key of ["users","accounts","accountIdByProviderKey", ...])
    if (!isRecord(normalized[key])) normalized[key] = {};
  for (const key of ["eventPositionBatchesById","quarantinedLegacy…", ...])
    if (normalized[key] === undefined) normalized[key] = {};
    else if (!isRecord(normalized[key]))
      throw new Error(`state.${key} must be an object; refusing to discard evidence`);
  if (isRecord(normalized.eventPositionBatchesById)) {
    for (const [batchId, rawBatch] of Object.entries(normalized.eventPositionBatchesById)) {
      // 对每个批次：判定是否为无法真值转换的历史格式，是则隔离进 quarantine
      const rawBatchForQuarantine = structuredClone(rawBatch);   // ← 每个批次再拷一次
      ...
    }
  }
  ...
}
```

两个要点：
- **它自己做一次全树 `structuredClone`**（第 243 行）。加上 ② 的那次，**一次事务至少发生 2 次全树深拷贝**，再加每个位置批次各一次（线上有 495 个批次）。
- 它同时承担**历史数据迁移**职责（把旧格式的位置批次隔离到 `quarantinedLegacyEventPositionBatchesById`，而不是猜一个不真实的秒槽或直接删除）。注释写着 `refusing to discard evidence`。
  **迁移逻辑本应只在启动加载时跑一次，现在每次写都跑。**

### 第二层：结构检查（约 30 行）

确认 `schemaVersion === "2.0"`，并逐一确认 24 个集合都存在且是对象（`store.ts:533-560`）。

### 第三层：逐条记录校验（约 490 行，成本主体）

通过 `validateRecordValues` 遍历**每个集合的每一条记录**：

```ts
function validateRecordValues(value, context, validator): void {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  for (const [key, item] of Object.entries(value)) {      // ← 遍历整个集合
    if (!isRecord(item)) throw new Error(`${context}.${key} must be an object`);
    validator(item, `${context}.${key}`);
  }
}
```

每个集合的 validator 做：必填字段存在性/类型（`requireString`）、枚举值合法、
**存储键与记录自身 ID 一致**（例如通知记录 `row.id !== id` 就抛错）、
以及跨字段一致性（例如 Watch 备用位置事实的 `fingerprint` 必须与其内容重算一致）。

其中 **7 处调用 Zod schema 的 `.parse()`**（`store.ts:569, 574, 579, 952, 958, 1003, 1022`），
分别校验：通知记录、Watch 备用位置事实、ISO 时间、模拟观测、Watch 紧急观测、患者位置、响应请求。
Zod 解析是这里最贵的单项操作。
最重的集合是 `eventPositionBatchesById`——线上 495 个批次、2379 条位置记录，
每个批次还要校验秒槽连续性、批内记录数上限、封口语义。

### 第四层：`validateState` 内的其他一致性约束

例如 `deletionRequestsById` 的键必须等于 `requestId` 且 `status === "REQUESTED"`；
`notificationOutboxById` 的键必须等于记录 `id`。

---

## 6. `assertAppendOnlyHistory`：全量不可变检查

[代码事实] `store.ts:91-175`。它拿**改前全量快照**和**改后全量快照**对比，
对每一类"证据"集合逐条验证不可变性：

| 集合 | 规则 |
| --- | --- |
| `positionUpdateReceiptsById` | 带 `watchFallbackFact` 的收据，其事实、设备、事件、指纹、记录时间**必须完全不变**（`isDeepStrictEqual`） |
| `notificationOutboxById` | 记录**不可删除**；除 `status/attempts/nextAttemptAt/completedAt` 外的消息体**不可变**；已完成的记录**整体不可变**；`attempts` 只能 `+0` 或 `+1` |
| `deletionRequestsById` | **不可添加后修改、不可删除**（注释：这样后来的事务无法掩盖"曾经请求过删除"这一事实） |
| `events`（`triggerSource === "SIMULATED_TEST"`） | 观测内容、患者设备范围、患者用户**不可变** |
| `eventPositionBatchesById`、`quarantinedLegacyEventPositionBatchesById` | **纯 append-only**：不可删除、不可修改（逐条 `isDeepStrictEqual`） |
| `participantIntervalsById` | 开放区间不可变；只能被"结束"一次，且结束只能填 `endedAt`/`endReason` |

**注意成本特征**：这些检查全部遍历**改前的整个集合**，并对每条记录做**深比较**。
线上光是 `eventPositionBatchesById` 就有 495 个批次（每个含最多 5 条位置记录），
`notificationOutboxById` 112 条，`positionUpdateReceiptsById` 161 条。
**即使本次事务只改了一个设备的 `latestPosition`，这些深比较也全都要跑一遍。**

---

## 7. 读路径

[代码事实] 两条读路径：

```ts
read<T>(reader: (state: Readonly<PersistentState>) => T): T {
  if (this.closed) throw new Error("SQLite state store is closed");
  return reader(cloneState(this.state));        // ← 全树深拷贝，然后交给业务读
}

readEntities<T>(reader: (view: StateReadView) => T): T {
  if (this.closed) throw new Error("SQLite state store is closed");
  return reader(createStateReadView(this.state));   // 视图，按需克隆单条实体
}
```

`readEntities` 是为降低读成本引入的优化（`state-read.ts`）：
`select(collection, predicate, limit)` 与 `get(collection, key)`。
**但它仍在内部对每条被取出的实体做 `structuredClone`**：

```ts
for (const value of Object.values(entries)) {
  const detached = structuredClone(value) as StateEntity<C>;
  if (predicate(detached)) selected.push(detached);
  if (selected.length === limit) break;
}
```

所以它是 **O(取出的实体数)** 而不是 **O(全树)**——对"按 key 取一条"是真正的优化，
但对"遍历整个集合"仍然要克隆整个集合。
另外 `readEntities` 在 `StateStore` 接口里是**可选**的，`state-read.ts:44` 提供兜底：

```ts
export function readEntities<T>(store: StateStore, reader: (view: StateReadView) => T): T {
  if (store.readEntities) return store.readEntities(reader);
  return store.read(state => reader(createStateReadView(state)));   // 退化为全树克隆
}
```

**这一条很重要**：任何仍调用 `store.read(...)` 的业务路径每次请求都克隆整棵树。
[实测] 线上 `GET /api/v2/aeds` 与 `GET /api/v2/me/nearby-volunteers`
（两者都用 `store.read`，`service.ts:4025` / `service.ts:2621`）只有 **65–86 请求/秒**，
而完全不碰状态的 `GET /healthz` 有 **6,800 请求/秒**。

---

## 8. 启动加载路径

[代码事实] `stateFromItems`（`store.ts:1247`）：从 `state_items` 表把每个 payload `JSON.parse`
回填进 `emptyState()`，然后**调用同一个 `validateState(raw)`**（第 1268 行）。
`SQLiteStateStore` 构造函数再 `cloneState` + `flattenState` 一次（第 1298-1299 行）。

即：**全量校验在启动时跑一次（这次是合理的），又在每次写事务里重复跑（这次是不合理的）。**

---

## 9. 实测成本

### 9.1 单次写的分相成本 [实测]

对**线上库的副本**（955 实体 / 1.42 MB payload）测 no-op 事务（即不含任何业务逻辑的纯存储开销）：

| 阶段 | 中位耗时 |
| --- | --- |
| `cloneState`（step ②） | 6.06 ms |
| `validateState` + `assertAppendOnlyHistory`（step ④⑤，**含 `normalizeState` 里的第二次全树 clone**） | **40.15 ms** |
| flatten + diff + SQLite 提交（step ⑥，no-op 时无实际写入） | ~0 ms |
| **合计** | **45–59 ms** |

**校验占了一次写事务约 90% 的成本。**

### 9.2 端到端：吞吐量与并发无关 [实测]

线上 `GET /api/v2/events`（该接口在 `service.ts` 里会调用 `tick()`，而 `tick()` 内含 `store.transact`）：

| 并发 C | 吞吐 | p50 | p95 |
| --- | --- | --- | --- |
| 1 | 9.72 /s | 93 ms | 180 ms |
| 2 | 9.78 /s | 187 ms | 364 ms |
| 4 | 9.73 /s | 372 ms | 741 ms |
| 8 | 10.03 /s | 743 ms | 1478 ms |
| 16 | 9.90 /s | 1584 ms | 1794 ms |
| 32 | 10.27 /s | 3088 ms | 3166 ms |
| 64 | 9.96 /s | 1590 ms | 25088 ms |

**吞吐恒定 ~10/s，延迟随并发线性增长。** 这就是 step ① 单写者队列 + O(E) 事务的直接后果。
增加客户端并发不会提高吞吐。

### 9.3 成本随数据量线性增长 [实测]

隔离库上测纯存储层 no-op 事务：

| 用户数 | 实体数 | no-op 事务 | 事务/秒 |
| --- | --- | --- | --- |
| 50 | 251 | 2.1 ms | 481 |
| 200 | 1,001 | 4.6 ms | 218 |
| 500 | 2,501 | 12.5 ms | 80 |
| 1,000 | 5,001 | 23.1 ms | 43 |
| 2,000 | 10,001 | 77.4 ms | 13 |
| 4,000 | 20,001 | 159.8 ms | 6.3 |
| 8,000 | 40,001 | 369.4 ms | 2.7 |

线上端到端同样下降（含 `tick()` 业务逻辑）：
54 用户 **9.90 tx/s** → 504 用户 6.51 → 2,504 用户 1.86 → 5,004 用户 1.01 → 10,504 用户 **0.41**（单事务 p50 26 秒）。

### 9.4 其他被同一机制拖累的路径 [实测]

- **每次 Socket 连接**都会经 `touchDevice` 开一次事务（`service.ts:2695`），
  所以**新建连接上限 = 写事务上限 ≈ 10 条/秒**。实测 500 条并发连接失败 291 条。
- **每次连接还会调 `replayPendingResponses`**（`service.ts:2502`），其中 `listEvents` 遍历所有事件。

---

## 10. 架构评价：意图成立，成本模型不成立

**这套设计要保证的不变量本身是合理且值得保留的：**

1. **提交前全量结构校验** → 任何代码 bug 都无法把结构非法的状态写进库。
   对一个急救系统，"库里绝不会出现半截或畸形的证据记录"是正当要求。
2. **提交前后全量对比的 append-only 检查** → 没有任何代码路径能删除或改写证据，
   包括未来的重构、迁移脚本、运维误操作。这是**结构性保证**，不依赖开发者自觉。
3. **单写者** → 免除了并发写冲突的整类问题，在单机参考实现里是合理取舍。

**问题在于实现这些不变量的成本模型：**

> 它用「每次写都重新校验整个数据库」来实现「只增不改」，
> 于是**保证强度与数据总量成正比，写吞吐与数据总量成反比**。

正确的做法是让**保证强度与数据总量无关**：

| 不变量 | 当前实现 O(E) | 可行替代 |
| --- | --- | --- |
| 结构合法 | 每次校验全部实体 | 只校验本次脏实体；启动时 + 周期性全量兜底 |
| 历史只增 | 全量深比较改前改后快照 | 每个只增集合维护单调水位线（条数 + 最大记录时间戳），只有"减少"才报错 |
| 证据不可篡改 | 全量 `isDeepStrictEqual` | 内容哈希链（每条记录存 `prevHash`），写时只算新增记录的哈希 |
| 事务隔离 | 深拷贝整棵树 | 脏实体级 copy-on-write，或迁移到真正的事务型 DB |

另外两处独立于校验的浪费：
- `normalizeState` 在每次事务里重复执行**只应在启动时跑一次**的遗留数据迁移，并因此多做一次全树深拷贝。
- `read()` 的全树克隆仍在多数读接口上；`readEntities` 只覆盖了一部分。

---

## 11. 给外部评审的问题清单

如果你要请另一个模型/同事评审，建议直接问这几个问题：

1. **成本模型能不能改对？** 在上面的四条替代方案里，哪一条能以最小改动
   既保住"证据绝不丢失/篡改"的强保证，又把单次写从 O(E) 降到 O(Δ)？
   是否存在"既全量校验又不 O(E)"的已知模式（例如增量校验 + Merkle/哈希链）？
2. **append-only 的水位线方案是否足够强？** 用"条数 + 最大时间戳不减少"替代
   逐条深比较，会漏掉哪些真实攻击/故障场景（例如同 ID 不同内容的替换、
   时间戳回退、并发写入交错）？哈希链是否能补上？
3. **单写者队列该不该保留？** 在迁移到 PostgreSQL 的前提下，
   把它换成数据库事务 + 行级锁，会引入哪些当前被"进程内串行"免费挡掉的竞态？
   （业务里有大量"读-判断-写"逻辑，例如接受响应时检查是否已被别人接受。）
4. **`tick()` 放在读接口里是否是必须的？** `GET /events` 和 `GET /me/presence`
   依赖 `tick()` 推进超时/状态机。改成定时器驱动后，
   客户端读到的状态是否会出现"该超时的还没超时"的可见性差异？这个差异业务上能否接受？
5. **数据量与保证强度的取舍**：如果全量校验保留、但改成"每 N 次事务或每 T 秒一次"，
   在崩溃时最坏会丢掉多少窗口内的完整性保证？对"证据"类数据这个窗口能否为零？
6. **分层是否更合理？** 把"证据类"集合（位置批次、回执、通知、时间线）
   与"当前态投影"集合（设备最新位置、可参与状态、会话）分开：
   前者强不可变 + 哈希链 + 追加写，后者允许覆盖 + 轻量校验。
   这样分层是否能让热路径只付 O(Δ)？

---

## 附：一句话总结

> **数据模型**是"一棵常驻内存的全量状态树 + SQLite 物化视图"；
> **写路径**是"单写者队列 → 深拷贝整棵树 → 改几条 → 校验整棵树 → 对比整棵树 → 全量 flatten/diff → 整根替换"；
> **不变量的意图**（证据不可删改、状态结构永远合法）是对的，且是产品核心属性；
> **不变量的实现**把成本钉成了 O(总数据量)/次写，导致写吞吐上限约 10 次/秒
> 且随数据增长反比下降，与客户端并发无关。
