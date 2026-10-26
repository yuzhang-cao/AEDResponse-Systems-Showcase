# 发给 GPT-6 的消息（直接复制下面分隔线之间的内容）

---

接续上一轮。两件事：**你指出的两个口径缺口已修复，结果如下；另外你给的 `positioningTier` 最小改法经代码核对不成立，需要你重新裁定。**

## 一、两个口径缺口已修复

### 1. 全量克隆改为按调用点分类的完整计数 —— 你是对的，实际是 3 次不是 2 次

| 克隆入口 | 上一版 | 现在 |
| --- | --- | --- |
| `transactionDraft`（`store.ts` transact 内） | 计入 | 1 |
| `normalization`（`normalizeState` 内裸 `structuredClone`） | **漏计** | 1 |
| `storeRead`（`service.ts` 事务后为 positioningTier 调用） | 计入 | 1 |
| **总计** | ~~2~~ | **3** |

另外发现**一类此前完全未计的克隆**：`normalizeState` 对每个位置批次各做一次 `structuredClone(rawBatch)`（`store.ts:292`）。命名为 `batchLevelClones`，单列：

| 库中实体 | batchLevelClones |
| --- | --- |
| 1,166 | 330 |
| 11,472 | 3,274 |
| 56,421 | **16,116** |

### 2. 计时范围拆开 —— 这一项让先前的数字少了 63%

`serviceMs` 原来只包住 `store.transact()`，事务后的 `positioningTier` 全树读取**被计数却未被计时**。现已拆成四个互不重叠的口径：

| 实体数 | `operationElapsedMs`（完整方法） | `queueWaitMs` | `transactionServiceMs` | **`postTransactionMs`** |
| --- | --- | --- | --- | --- |
| 1,166 | 59.92 | 0.00 | 52.31 | 7.38 |
| 11,472 | 511.29 | 0.01 | 434.85 | 76.24 |
| 56,421 | **6,078.84** | 0.01 | 3,731.61 | **2,178.80** |

**完整耗时是 6,078.84 ms，不是上一轮报告的 3,735.31 ms。** 上一张表把 2,178.80 ms 排除在计时外、却把它的克隆算进了计数，正是你说的那种错位。

### 3. SQL 口径拆成四个不同数字

`businessEntityUpserts=2`（业务实体行）· `businessEntityDeletes=0` · `revisionMetadataUpdates=1`（`state_metadata` revision bump）· `commitCalls=1`（执行的写事务数）。不再把实体行数、语句数、提交数混为一个。

### 4. 修正后的完整改前基线

写集合只有 **2 行业务数据**，却发生：**3 次全树克隆 + 16,116 次批次克隆 + 48,357 次记录校验 + 56,423 次序列化 + 16,121 次历史比较**。

### 5. 插桩自身开销（你要求的 A/B）

`transact` 内加了开关，关闭时不执行任何计时系统调用。251 实体、数据变更事务：**ON 5.030 ms vs OFF 4.740 ms → +0.290 ms/事务（+6.12%）**。

**这个量级不可忽略。** 我暂定：结构门槛在插桩 ON 下测，吞吐门槛在插桩 OFF 下测或明确披露，改前/改后必须同一状态。请确认这个纪律，并回答下面的 Q3。

（未加开关的是 validate/flatten/history 循环内的整数自增——逐条加分支比自增本身更贵。按 56k 实体约 0.06 ms 估算，占 3,731 ms 的 0.002%。）

## 二、`positioningTier`：你的最小改法不成立

你建议："保持原时点，只改变取数范围——将 `store.read()` 替换为按设备 ID 取单条的实体读取。"

**这条做不到，而且会算错结果。** `presenceView`（`service.ts:4437`）需要的不只是一台设备：

```ts
// service.ts:4448
const isActivePatient = Object.values(state.events).some((event) => event.state === "ACTIVE"
  && (event.patientUserId === userId || event.patientDeviceIds.some(sameUser)));
// service.ts:4450
const isAcceptedParticipant = Object.values(state.events).some((event) => event.state === "ACTIVE"
  && acceptedDeviceIds(state, event.id).some(sameUser));
// service.ts:4454
const insideSearchRing = Object.values(state.events).some((event) =>
  this.isEligibleNearbyResponder(state, event, device, now, false));
```

而 `isEligibleNearbyResponder` 内部还有（`service.ts:5103`）：

```ts
if (Object.values(state.deliveries).some((delivery) => { ... })) return false;
```

所以 `positioningTier` 本身就是 **O(事件 × 投递)**，和招募刷新是同一个模式。按设备 ID 取单条拿不到 events/deliveries，**算不出正确结果**。我先前说的"零风险可删"错得更彻底——不只是时点问题，是它根本不是一次设备读取。

### 我的替代方案（待你裁定）

让 `presenceView` 接受一个**窄访问器**（只暴露 `devices.get(id)` / `events` / `deliveries`），由 `readEntities` 视图适配。保持**同一时点、同一计算函数**，只把"克隆 56,423 个实体"降为"克隆 ~100 事件 + ~2,000 投递"。

测试将断言：响应内容逐字段不变（正常更新、重复/拒绝分支、影响 tier 的时间边界），且 SQLite 路径**未回退**到 `state-read.ts:44` 的全树兜底。

## 三、需要你裁定/回答的问题

**Q1.** `presenceTier` 的替代方案（窄访问器 + 视图适配）是否可接受？还是应当把 tier 计算**移进事务**用 draft 计算？若移进事务，你之前提醒的"draft ≠ 最终已规范化提交对象"这一风险如何界定——具体要核对哪些规范化步骤可能改写字段？

**Q2.** 你要求"`historyCompared = 0` 不能实现成历史约束全部不检查，受影响记录的不可变规则仍须执行"。那么**"受影响记录"的集合由谁定义**——需要业务显式声明受影响集合，还是由 change-set 自动推导？自动推导是否能覆盖"通知的有限状态迁移""参与区间只能结束一次"这类跨记录规则？

**Q3.** 插桩 **+6.12%** 的开销：接受它长期留在正常路径，还是要求 Phase 1 结束后把计数器改为启动/编译期开关？注意结构门槛本身依赖这些计数，所以它不能完全移除，只能分模式。

**Q4.** `batchLevelClones = 0` 是否也作为硬门槛？它属于规范化范畴——若 `normalizeState` 只在启动时运行，正常路径自然为 0；但需确认没有其他路径依赖它在事务内运行（我们已知它承担旧批次隔离与 `userId` 回填，见 `store.ts:273-320`）。

## 四、当前状态

`npm run check` 干净，`npm test` **203/203** 通过，线上部署**未改动**（线上 `dist/src/store.js` 中计数器引用为 0）。方案文档 `docs/storage-refactor-plan-final.md` 的 4bis（基线）与 4.2（结构门槛）已按你上一轮要求更新。未开始增量事务改造，等你对上述四问的答复。

---
