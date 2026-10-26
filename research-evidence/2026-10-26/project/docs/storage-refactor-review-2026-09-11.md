# 对 GPT-6 存储层重构方案的评审与高容量路径

> 评审对象：GPT-6 提出的"第一阶段只改存储层、保留单写者与 SQLite"的实施方案。
> 评审依据：本仓库源码 + 2026-09-11 在 Azure 联调机上的实测数据（`docs/load-test-2026-09-11.md`、
> `docs/store-full-validation-architecture.md`）。
> 标注 **[实测]** 的数字为真实测量；**[代码事实]** 为读源码得出；**[推算]** 为基于前两者的估算并给出依据。

---

## 0. 总体判断

**方案方向正确，工程判断成熟，可以照着做。** 它准确抓住了主瓶颈（每次写全库遍历），
提出的 `transactEntities` 受控事务、校验三拆、change-set 持久化、迁移移出热路径、
读路径去全量克隆、`tick()` 两步走、触发器兜底、影子对照测试，基本都是对的。

**但它只解决了三层瓶颈中的第一层。** 按实测，这台机器的容量由三个**互相独立**的约束共同决定，
只做存储层增量化的结果是：**写路径不再是瓶颈，瓶颈平移到内存**，而 P20 目标仍然不可达。
下面是三层约束的实测证据，以及第一阶段的真实收益上限。

---

## 1. 三层瓶颈（实测）

### 第 1 层：存储层全量遍历 —— GPT-6 覆盖了这一层

| 事实 | 数值 |
| --- | --- |
| 单次 no-op 事务（955 实体 / 1.42 MB） | 45–59 ms，其中校验+历史检查 40 ms |
| 线上写吞吐（并发 1→64） | **恒定 ~10 次/秒**，与并发无关 |
| 数据量增长后 | 8,000 用户 → 369 ms/次（2.7/s）；线上 10,504 用户 → 0.41/s |
| 对照：不碰状态的 `/healthz` | **6,800 请求/秒** |

### 第 2 层：实时层 `reconcile()` 是 O(连接数) —— **方案完全没覆盖**

[代码事实] `backend/src/realtime-access.ts:25-47`：

```ts
reconcile(): void {
  if (this.connections.size === 0) return;
  authorized = this.access.currentDeviceConnectionIds(new Map(     // ← 重建全部连接的 Map
    [...this.connections].map(([id, c]) => [id, c.principal])
  ));
  for (const [id, connection] of this.connections) { ... }         // ← 遍历全部连接
}
isAuthorized(id) { this.reconcile(); return this.connections.has(id); }   // ← 每次连接都调
sendToDevices(deviceIds, send) { this.reconcile(); ... }                  // ← 每次广播都调
```

触发点：`server.ts` 里 **3 处 `isAuthorized`**（每次 Socket 连接至少走一遍）
+ `service.ts` 里 **5 处 `emitToDevices`**（每次通知广播走一遍）。
每一次都 **O(连接数) 分配一个新 Map 并全量重算授权**。

按 P20 的 4,000 socket msg/s、2 万连接估算：**每秒 4,000 × 20,000 = 8×10⁷ 次迭代 + 同样量级的 Map 分配**。
这是**结构性不可达**，和存储层无关，改 `store.ts` 不会改善一个字节。

[实测] 佐证：Socket 建连被钉在 **~10 条/秒**（因为 `touchDevice` 每次连接开一次事务），
500 条并发连接**失败 291 条**。建连速率能被存储层修好，但**广播成本不会**。

### 第 3 层：全量历史常驻内存 —— 方案只在最末尾一句带过，实际是硬墙

[实测] 内存随用户数增长（cgroup `MemoryCurrent`，静止态）：

| 库中用户 | MemoryCurrent |
| --- | --- |
| 54 | 95 MB |
| 5,004 | 227 MB |
| 10,504 | 300 MB |

**≈ 20 KB/用户** [推算]。当前 systemd 限制是 `MemoryHigh=384M`、`MemoryMax=512M`。

[推算] 2 万在线待命用户 ≈ 95 MB + 20,000 × 20 KB = **495 MB**，
**恰好顶到 512 MB 硬上限**，且远超 384 MB 的软上限。**这还没算事件证据。**

而 P20 的事件证据量是：2,000 参与者 × 1 Hz × 60 分钟 = **720 万条秒槽记录**
（评审稿 `docs/reviews/AED业务逻辑与架构设计评审稿:853` 已算过这个数）。
按每条记录在 JS 堆里 200–400 字节（对象头 + 字段 + 字符串）算 = **1.4–2.9 GB**。

> **结论：即使把校验成本降到零，这台 892 MB 的 VM 也装不下 P20 的工作集。**
> 这不是优化问题，是数据放置问题。

---

## 2. 逐条评价 GPT-6 的方案

### 2.1 同意的部分（且我建议原样执行）

| 建议 | 评价 |
| --- | --- |
| `transactEntities(tx)` 受控事务，禁止业务直接改整棵树 | **对，且是唯一可靠的方案。** `markDirty()` 靠自觉、提交前扫描全库靠成本，都被正确否掉了 |
| `tx` 契约六条（按键读、自动登记前后值、追加证据查重、完成后封闭、失败丢弃、不泄露内部引用） | **对。** 特别是"不能把内部可变引用泄露出去"——当前 `store.read` 返回 `Readonly<>` 但运行时是活引用，`readonly` 只是编译期约束 |
| 校验三拆（`migrateLegacyState` / `validateSnapshot` / `validateChangeSet`） | **对，且必须保留 `validateSnapshot`。** 它同时是启动加载校验和**新实现的对照基准** |
| 不可变规则**逐条搬到操作合法性检查**，而不是简化为"都能改/都不能改" | **对。** 这是最容易做错的地方，方案明确要求逐集合核对源码，态度正确 |
| change-set 持久化替代 `flattenState(next)` | **对，且有一个方案没提到的额外收益，见 2.3** |
| `normalizeState` 的迁移逻辑移出热路径 | **对。** 但有一个前置检查项，见 2.2 |
| `readEntities` 转正、去掉隐式退化、索引化候选查询 | **对。** 这是独立工作流，见 2.2 |
| `tick()` 不直接删除、两步走 | **对，且第 1 步做完后第 2 步可能没那么急，见 2.3** |
| 触发器兜底 + 禁止 `INSERT OR REPLACE` 用于证据 | **方向对，但有一个交互陷阱，见 2.4** |
| 保留 WAL + `synchronous=FULL` | **同意。** 但要知道新的天花板变成 fsync，见第 3 节 |
| 三阶段推进、先迁移一条完整路径、新旧入口共用同一队列与状态 | **对。** 而且实际工作量比方案暗示的小，见 2.5 |

### 2.2 需要补强的地方

**(a) 索引是独立工作流，方案低估了它。**

[代码事实] `service.ts` 里有 **48 处 `Object.values(state.X)` 全集合扫描**：

| 集合 | 扫描处数 | P20 规模 | 每次操作代价 |
| --- | --- | --- | --- |
| `events` | 15 | 100 | 便宜 |
| `devices` | **8** | **20,000** | **16 万次迭代/操作** |
| `deliveries` | 8 | 2,000 | 1.6 万 |
| `sessionsByTokenHash` | **5** | **20,000** | **10 万次** |
| `assignments` | 5 | 2,000 | 1 万 |

**真正致命的是 `devices` 和 `sessionsByTokenHash` 的扫描**——它们随在线用户数线性增长。
而且这些扫描发生在**写事务内部**（为了决定写什么），会占满单写者队列。

增量事务让"写"变成 O(Δ)，但**"为了决定写什么而扫描全部设备"仍然是 O(N)**。
第一阶段必须同时识别并索引化这些扫描点，否则收益会被它们吃掉。
需要的索引至少包括：`deviceInstanceId → userId/accountId`、`eventId → participantDeviceIds`、
`eventId → deliveries`、地理候选索引（用于招募圈）。

**(b) `normalizeState` 移出热路径前，必须先确认它是否承担了业务依赖的规范化。**

方案已经提到这一点（"要先检查 normalizeState 是否还承担了当前业务依赖的默认值填充"），
我补充具体位置：`store.ts:273-320` 那段会给旧批次补 `userId`
（从 `devices[batch.deviceInstanceId].userId` 推断）。**如果线上还有依赖这个补全的读路径，
把它从热路径移除会改变行为。** 建议先写一个只读探针统计"当前库里有多少记录会被这段逻辑改动"，
为零才可安全移除。

**(c) `readEntities` 的 `select()` 仍然先克隆再判断。**

[代码事实] `state-read.ts:25-29`：

```ts
for (const value of Object.values(entries)) {
  const detached = structuredClone(value) as StateEntity<C>;   // ← 先克隆
  if (predicate(detached)) selected.push(detached);            // ← 再判断
  if (selected.length === limit) break;
}
```

方案正确指出了这一点。补充一个好消息：**代码库里已经有正确的模式，只是没接到业务层。**
[代码事实] `identity-access.ts:116-140` 的 `principalForHash` 用
`state.get("sessionsByTokenHash", hash)` 做 **O(1) 按键取单条**，只克隆它真正需要的那几条实体。

也就是说：**认证路径已经是增量的**，每次 REST 请求的鉴权成本已经很低；
**`service.ts` 里 `readEntities` 的使用次数是 0，12 处读全部走 `store.read` 全树克隆。**
所以这一项不是"发明新能力"，而是"把已有的正确模式铺到业务层"。

### 2.3 change-set 带来的一个方案没提到的额外收益：空变更 = 零 fsync

当前 `persistChanges` 为了判断"是不是 no-op"，**仍然要先 `flattenState(next)` 整个状态**
（`store.ts:1453`）——它只是避免了 SQLite 写入，没有避免全量序列化。

改成 change-set 后，**没有任何改动的 `tick()` 产生的变更集为空 → 不序列化、不开 SQLite 事务、不 fsync。**

这一点的意义：方案建议 `tick()` 分两步走（先缩小推进范围、再建可恢复调度）。
**第 1 步做完后，"每次读都 tick" 的成本已经接近零**——因为它绝大多数时候什么都不改。
所以：
- 第 1 步（配合 change-set）就能解决大部分问题，**第 2 步（定时器 + 可恢复到期调度）可以推迟**；
- 但要保留方案强调的那条正确性要求：**关键命令（接受响应、更新任务、结束事件）
  仍必须在事务内重新检查状态与时间条件**，不能因为调度晚了就放行过期操作。

### 2.4 触发器方案有一个交互陷阱

方案的意图（用 SQLite 逐行触发器 + `RAISE()` 给证据加第二层保护）是对的，
但在**当前的表结构**下要注意一点：所有实体都存在**同一张表**里。

```sql
CREATE TABLE state_items(collection TEXT, item_key TEXT, payload TEXT, ...);
```

所以触发器必须**按 collection 条件化**：

```sql
CREATE TRIGGER state_items_evidence_no_update
BEFORE UPDATE ON state_items
WHEN OLD.collection IN ('eventPositionBatchesById',
                        'quarantinedLegacyEventPositionBatchesById')
  AND OLD.payload IS NOT NEW.payload          -- ← 这一条是关键
BEGIN
  SELECT RAISE(ABORT, 'append-only evidence cannot be modified');
END;
```

**为什么 `AND OLD.payload IS NOT NEW.payload` 不能省：**
当前 `persistChanges` 用 `INSERT ... ON CONFLICT DO UPDATE SET payload = excluded.payload`
（`store.ts:1464-1468`）。SQLite 的 upsert 在走 `DO UPDATE` 分支时**会触发 UPDATE 触发器**。
而**幂等重放**（同一个位置批次被客户端重发）正是走这条路。
现在的代码靠 `if (before.get(identity)?.payload !== item.payload)`（`store.ts:1474`）
跳过内容相同的行，所以不会发 UPDATE。

也就是说：**触发器的正确性依赖"内容相同则不写"这条规则被 change-set 实现保留下来。**
必须为此写一条明确的回归测试（同 ID 同内容重发 → 返回既有结果、不报错、不产生 UPDATE），
否则一个"顺手把写改成无条件 upsert"的改动就会让幂等重放全线失败。

另外，方案对 `INSERT OR REPLACE` 的警告是对的：SQLite 的 REPLACE 在唯一键冲突时
**先 DELETE 旧行再 INSERT 新行**。当前代码用的是 upsert 不是 REPLACE，属于预防性建议，值得写进约束。

### 2.5 实际迁移量比方案暗示的小

[代码事实] `service.ts`（5,496 行）里的调用点：

| 调用 | 处数 |
| --- | --- |
| `store.transact(` | **20** |
| `store.read(` | **12** |
| `store.readEntities(` | **0** |

**总共 32 个调用点。** 方案说"不要让开发模型一次重写整个 service.ts"——这个谨慎是对的，
但 32 个点是可以按业务域分批迁移的规模，不需要把它当成一个巨大的重写工程。
按域分组大致是：设备/连接（`touchDevice`、presence）、位置（待命 R、事件批次）、
事件生命周期（创建/接受/退出/结束）、任务与 AED、通知 outbox。**建议每批 ≤ 5 个调用点。**

---

## 3. 第一阶段做完之后，容量到底变成多少

### 3.1 新的写上限：fsync 主导，约 250–350 次/秒

> **⚠️ 本节已在 2026-09-11 修订。** 初版用"251 实体 no-op 事务 2.1 ms"推断 fsync 成本，
> **该推断是错的** —— `persistChanges()` 在 `store.ts:1462` 的 `if (unchanged) return;`
> **发生在 `this.database.transaction()`（1472）与 `write()`（1486）之前**，
> 所以 no-op 根本不执行 SQLite 提交，也就没有 fsync。初版同一份文档里
> "旧实现的 no-op 已经省掉 SQLite 写入"与"2.1 ms 就是 fsync"两句自相矛盾。
> 下面的数字改为**直接测量真实变更事务**得到。

[实测] 两种测法（2026-09-11，Azure 联调机，`probe-commit.mjs`）：

**A. 裸 SQLite 提交成本**（WAL，每次提交 1 行 upsert，n=200）：

| `synchronous` | 中位 | p95 | 提交/秒 |
| --- | --- | --- | --- |
| **FULL** | **2.88 ms** | 4.60 ms | **347** |
| NORMAL | 0.02 ms | 0.03 ms | 66,410 |
| OFF | 0.02 ms | 0.03 ms | 66,454 |

→ **同步成本（FULL − OFF）≈ 2.87 ms/commit**，这就是真正的 fsync 成本。
→ NORMAL ≈ OFF，证实 WAL 下 NORMAL 不在提交时 fsync。

**B. 存储层真实事务**（251 实体 / 0.08 MB）：

| 操作 | 中位 | 吞吐 |
| --- | --- | --- |
| no-op（无 SQLite 提交） | 0.92 ms | 1,087/s |
| **1 个实体变更（真实提交）** | **4.04 ms** | **248/s** |
| 50 个实体变更（真实提交） | 5.16 ms | 194/s |
| 差值（= 真实提交成本） | **3.12 ms** | — |

| 阶段 | 写吞吐 | 说明 |
| --- | --- | --- |
| 现在 | ~10 次/秒 | 全量校验 CPU 主导 |
| **Phase 1 后** | **~250–350 次/秒** | **fsync 主导** |

**GPT-6 的批评成立：原推导无效。** 修正后的数字与初版接近纯属巧合，
但依据完全不同——现在是真实变更事务的测量值，且明确了它由存储设备的 fsync 决定，
不由代码决定。**因此不能承诺这个数字，只能把它当作预期，并用同一环境实测确认。**

**新的实测发现（对 group commit 是决定性的）**：1 个实体变更 4.04 ms，
**50 个实体变更只要 5.16 ms**——写入量增加 50 倍只多 1.12 ms。
**说明提交成本由 fsync 主导、几乎与行数无关，批量提交的余量很大。**
保住 `synchronous=FULL` 拿到高吞吐的正解就是 group commit：
把队列里已排队的多个业务事务合并成**一次** SQLite 提交（提交完成后才 resolve 全部 promise，
因此客户端仍只在持久化后才收到成功）。这应当从 Phase 3 提前到 Phase 1 完成后立即评估。

### 3.2 待命用户上限：从 ~600 提到 ~10,000，瓶颈变成内存

待命用户流量模型（`docs/requirements.md:45`）：每 120 秒 1 次位置写 = **0.00833 事务/秒/人**。

| 约束 | Phase 1 后的上限 |
| --- | --- |
| 写路径 | 400 ÷ 0.00833 = **~48,000 人** ← 不再是瓶颈 |
| 内存（512 MB 硬上限） | (512 − 120) ÷ 20 KB = **~19,600 人**（无余量） |
| 内存（384 MB 软上限 `MemoryHigh`） | (384 − 120) ÷ 20 KB = **~13,200 人** |
| 留出事件证据 + Socket + GC 余量 | **~5,000–8,000 人 舒适** |

**所以第一阶段的真实收益是：待命上限 ~600 → ~10,000（硬顶）/ ~5,000–8,000（舒适），
瓶颈从 CPU 平移到内存，而不是直达 2 万。**

### 3.3 Socket 仍然到不了 4,000 msg/s

`reconcile()` 的 O(连接数) 不修，广播吞吐与连接数成反比。
[推算] 即使按乐观的 10⁷ 次简单迭代/秒估算，2 万连接下每次广播要 2 ms，
**最多 500 次广播/秒**，离 4,000 msg/s 差 8 倍；再加上每连接 ~30–65 KB 的内存
（[实测] 209 条连接 ≈ +13 MB），2 万连接本身就要 600 MB–1.3 GB。

---

## 4. 怎么实现"高容量"：完整路径

GPT-6 的方案是正确的**第一步**，但要达到 P20 那个量级，需要按下面的顺序补齐。

| 阶段 | 内容 | 解除的约束 | 待命上限（本 VM） |
| --- | --- | --- | --- |
| **Phase 1** | 受控实体事务 + change-set 持久化 + 校验三拆 + 迁移出热路径 | 存储层 O(E) 校验 | ~10,000（内存受限） |
| **Phase 1.5** | 修 `reconcile()`（`deviceInstanceId → connectionIds` 索引 + 撤销事件驱动替代全量重算）；业务层索引化 `devices`/`sessions` 扫描 | 实时层 O(连接数) | 同上，但 Socket 可用 |
| **Phase 2** | **证据分层出内存**：位置批次/回执/通知/时间线改为追加写 + 按需分页读；内存只保留"当前态投影 + 活跃事件 + 索引" | 内存 O(历史) | **2 万+（取决于 VM 内存）** |
| **Phase 3** | group commit（可选）；再评估 PostgreSQL / 多实例 | fsync；横向扩展 | 目标规模 |

**关键判断：Phase 2（证据分层）不是"可选的长期优化"，它是达到 P20 的必要条件**，
而且**它可以在 SQLite 上做**——追加行、建索引、按 eventId 分页查，
完全不需要先迁 PostgreSQL。这正好回应了"不急着换 PostgreSQL"的诉求：
**用 SQLite 也能做到高容量，前提是内存里不再放全量历史。**

GPT-6 把这一点放在最后一段作为"边界说明"，我认为它应该被提升为 Phase 2 的正式内容，
因为它是决定"能不能到 2 万"的那一项。

---

## 5. 建议的第一项任务与验收门槛

**同意 GPT-6 的选择：先完整迁移"待命位置上传"（`PUT /api/v2/me/responder-position`）。**
理由：它是**量最大**的路径；它的 Δ 最小（1 台设备 + 1 个幂等收据）；
它的关联数据最少（不涉及招募圈）——所以它能最干净地验证新机制。

但**验收不能只看"接口改完了"，必须有可测的数字门槛**。现有工具
（`backend/scripts/loadtest/`）已经能测这些，Phase 1 完成标准建议定为：

| 门槛 | 方法 | 通过标准 |
| --- | --- | --- |
| 单次位置上传处理的实体数是常数 | 在事务里插桩统计"复制/校验/序列化的实体数" | **≤ 10，且不随历史增长** |
| 历史增长不影响热路径 | 固定并发与频率，历史从 1k 增到 100k 实体 | 位置上传 **P95 变化 < 20%** |
| 写吞吐量级提升 | `loadgen.mjs sat putposition` | **≥ 200 次/秒**（当前 10.24） |
| 空操作的 `tick()` 不产生写入 | 统计 SQLite 提交次数 | 无到期项时**提交数 = 0** |
| 证据保护行为不变 | 旧规则对照 + 影子 `validateSnapshot` | 全绿，差异零 |
| 幂等重放仍安全 | 同 ID 同内容重发（配合触发器） | 返回既有结果、不报错、无 UPDATE |

**强烈建议加一条开发期策略：在测试/开发构建里，每次增量事务提交后
额外跑一次 `validateSnapshot` 做影子对照**，不一致就 fail。
这是用很低成本获得"新实现等价于旧实现"高置信度的方法，上线时关闭。
这也正好解释了为什么 `validateSnapshot` 绝对不能删。

---

## 6. 一句话总结

> GPT-6 的方案是对的，照着做能把写吞吐从 **~10 次/秒 提到 ~300–500 次/秒（30–50×）**，
> 把待命在线上限从 **~600 提到 ~10,000**。
> 但它只覆盖了三层瓶颈里的存储层：**实时层 `reconcile()` 的 O(连接数)** 和
> **全量历史常驻内存**都不在其中，而后者才是 P20（2 万在线 / 720 万条证据/小时）的真正硬墙。
> 要真正高容量，Phase 1 之后必须做 **Phase 1.5（实时层索引）** 和
> **Phase 2（证据分层出内存）**——而 Phase 2 在 SQLite 上就能做，不必先迁 PostgreSQL。
