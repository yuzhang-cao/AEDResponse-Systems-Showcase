# 待命位置 freshness 审计与安全迁移（Phase 1 item #10）

> 起因：把 `pruneExpiredCurrentPositions()` 的**全设备扫描**换成**到期索引**时，
> 必须先证明"延后/改变物理删除"不会变成隐蔽的业务行为变更。
> 本文记录审计结果、已确认的语义边界、已做的等价化动作，以及**尚未完成**的部分。

---

## 0. 过程中的一次错误（记录在案）

实现顺序被做反了：**先落了 ⑦（expiry heap），后补 ①–⑥ 的审计**。
更严重的是这确实**改变了删除时机**——原来的 `getPresence()` / `updatePresence()` 里也会 prune，
第一版改动只在 `tick()` 里 prune，这两个入口不再清理。
**已修正**：三个入口点全部恢复（见 §4）。

教训：**性能重构必须先把"当前语义"钉死，再动结构。** 差一个 `>`/`>=` 就是一个可观测的行为变更。

---

## 1. `latestPosition` 读取方全表

返回位置的 helper 只有两个，且都不含时间判断：

- `currentPatientPosition(event)`（`service.ts:538`）—— 从事件取，**不读设备**
- **`currentResponderPosition(device)`（`service.ts:541`）** —— `device.latestPosition?.position`，**纯取值**

因此业务层只要拿到位置，就得自己判时间。

| # | 读取方 | 用途 | 检查时间？ | 依赖 prune 的副作用？ |
| --- | --- | --- | --- | --- |
| 1 | `service.ts:2487-2488` | 资格判定 | ✅ `responderPositionSampleIsFresh` | 否 |
| 2 | `service.ts:2505-2507` | 资格判定 | ✅ | 否 |
| 3 | `service.ts:2726-2737` `getNearbyVolunteerSummary`（观看者） | 自身距离基准 | ✅ | 否 |
| 4 | `service.ts:2756` `getNearbyVolunteerSummary`（候选循环） | 距离排名 | ✅ 经 `isEligibleNearbyVolunteer` → `isEligibleResponderDeviceBase` | 否 |
| 5 | `service.ts:5318` `createDeliveryIfEligible` | 发 offer | ✅ 首行即 `isEligibleNearbyResponder` | 否 |
| 6 | `service.ts:5404-5407` `isEligibleResponderDeviceBase` | 资格 | ✅ 显式 | 否 |
| 7 | `service.ts:3330` / `3411` 写入路径 | 比 `observedAt` 判 stale/幂等 | 比较时间戳，**不做 maxAge** | 否（排序语义，非"当前位置"） |
| 8 | `service.ts:1780` / `1984` bootstrap | 字段搬运 | 不适用 | 否 |
| 9 | `service.ts:2081` 模拟事件创建 | 取患者位置 | ✅ 上方守卫含 freshness | 否 |
| 10 | **`service.ts:4837` `presenceView`** | **返回给客户端** | ❌ **不检查** | **⚠️ 是** |
| 11 | `service.ts:5662` `replanAssignments` | 任务改道出发位置 | ❌ 不显式检查 | 见 §2 |

**只有 #10 是真正会被"延后删除"改变输出的读取方。**

## 2. ACTIVE 参与者的 10 分钟语义（本次审计最重要的一项）

```ts
if (isActiveEventParticipant) continue;   // ACTIVE 参与者永不 prune
```

**结论：A（业务已按时间判新鲜度），而不是 B。** 理由不是"代码里有检查"，而是：

> **ACTIVE 参与者的位置今天就可能超过 10 分钟而仍然存在**，
> 而 `replanAssignments`（#11）这类读取方**今天就在消费这种陈旧位置**。

也就是说：

- 跨过 10 分钟的 ACTIVE 参与者位置**本来就存在**，系统**本来就容忍**；
- 因此"把读取统一改成 10 分钟失效"**会是业务规则变更**，不能塞进性能重构；
- 反过来，**凡读参与者位置的地方今天已容忍陈旧值**，延后删除对它们**没有新增风险**。

这条同时解释了为什么 #11 不是阻塞项。

## 3. 已钉死的边界语义（对应第三步）

原表达式，逐字保留为唯一真相源（`src/service.ts`，导出以便测试钉住）：

```ts
export function positionAgeMs(observedAt: string | undefined, now: Date): number | null {
  if (typeof observedAt !== "string") return null;
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now.getTime() - parsed);
}

export function isPositionExpired(observedAt, now, maxAgeSeconds): boolean {
  const age = positionAgeMs(observedAt, now);
  if (age === null) return false;          // 非法时间 = 不过期（与旧 guard 一致）
  return age > maxAgeSeconds * 1_000;      // 注意是 > 不是 >=
}
```

三个**极易被"顺手统一"改掉**的细节，全部保留并测试钉死：

| 细节 | 旧语义 | 后果 |
| --- | --- | --- |
| `>` 而非 `>=` | 恰好 600.000 s **仍有效**，600.001 s 才过期 | 写成 `>=` 就改了边界 |
| `Math.max(0, …)` | 未来时间戳 → age=0 → **永不过期** | 去掉 clamp 会让快钟设备立刻被判过期 |
| `Number.isFinite` guard | 非法/缺失时间 → **不删除** | 若新 helper 把非法当 stale，就改了行为 |

测试：`test/position-freshness.test.ts`
- 逐个覆盖 `T0+9:59 / T0+10:00 / T0+10:00.001 / T0+20:00`
- 未来时间戳、非法时间戳、缺失时间戳
- **与"原表达式的逐字副本"做 ≥100 组组合的等价性扫描**
- 不同 `maxAgeSeconds` 下边界一致

## 4. 已做的等价化动作

| 动作 | 目的 |
| --- | --- |
| 提取 `positionAgeMs` / `isPositionExpired`，**prune 与索引路径共用** | 唯一 freshness 定义，防止两处漂移 |
| **恢复三个 prune 入口点**：`tick()` / `getPresence()` / `updatePresence()` | 删除时机与改动前一致；**唯一变化是"找出到期设备的成本"** |
| 索引只在**到期集合**上做豁免判断 | 把 `O(设备 × 事件 × 投递)` 降为 `O(到期数 × 事件 × 投递)` |

## 4bis. ⑥ 行为冻结点已完成，并且**当场抓到一个真实回归**

`test/standby-freshness-baseline.test.ts` + 金文件
`test/fixtures/standby-freshness-baseline.json`。
覆盖 **2 种事件结局（ACTIVE / RESOLVED）× 4 个时点 × 4 种角色**，
用真实流程搭建（bootstrap → 上报位置 → 建事件 → 接受 → 退出 → 结束），
每个时点记录：`state` 里是否有位置、`presenceView` 是否返回位置、`positioningTier`、
`nearby` 结果（含被拒绝时的状态码）、事件视图（关系/tier/offer/任务状态/coordination）。

**它记录的是现状，不是我们以为合理的规则。** 重新生成需显式
`AED_RECORD_BASELINE=1`，并必须人工审阅 diff。

### 冻结的真实旧行为（ACTIVE 事件）

| 时点 | standby | patient | acceptedResponder | exitedResponder |
| --- | --- | --- | --- | --- |
| T0+9:59 | 有 | 有 | 有 | **无** |
| T0+10:00 | 有 | 有 | 有 | 无 |
| T0+10:00.001 | **无** | 有 | **有** | 无 |
| T0+20:00 | 无 | 有 | **有** | 无 |

三条被冻结的行为：

1. **待命超 10 分钟被回收**；**恰好 600.000 s 仍有效**，600.001 s 才回收（`>` 而非 `>=`）。
2. **ACTIVE 患者**与**已接受响应者**的位置**永不**被 TTL 回收；
   `presenceView` 会把这种超龄位置**照常返回给客户端**（当前语义，见 §5）。
3. **已退出响应者从一开始就没有位置**——不是 TTL 删的，而是
   `responder-exit.ts:340` 在退出流程里**主动 `delete participantDevice.latestPosition`**。

### 这一版基线抓到的真实回归

第一版索引路径的豁免判断只覆盖了**患者**，漏了**已接受响应者**
（我写成了 `deviceIsActivePatientInTransaction`）。基线显示
`acceptedResponder` 在 T0+10:00.001 被回收，与旧行为不符——**这正是"先冻结现状"的价值**。

已修正为 `deviceIsExemptFromPositionPrune`：患者 **或**「ACTIVE 事件中状态为 ACCEPTED
且其用户未被记入 `exitedResponderUserIds`」的响应者，与旧谓词逐条对应。
同时保留 `deviceIsActivePatientInTransaction` 用于**另一个**语义不同的判断
（"活跃患者不得发布 R 位置"——那里必须是患者专属，不能放宽）。

**验证方式**：先用临时开关强制走旧的全扫路径记录基线，移除开关后让索引路径
**对照同一份旧基线**运行——当前两边逐字段一致。

## 4ter. ⑤ 产品口径已冻结并落地为独立契约改动

**冻结的产品规则**（用户裁定）：

> ACTIVE 救助事件中的患者或响应者，如果最后一次定位超过 10 分钟，**不再把该坐标视为"当前位置"，
> 但保留并展示为"最后已知位置"**。

### 契约（三态，且不产生互相矛盾的重复字段）

```jsonc
// ACTIVE 参与者，超龄：坐标保留 + 明确标记
{ "position": { "coordinate": { "kind": "R", "latitude": …, "longitude": …, "accuracyMeters": … },
                "observedAt": "…" },
  "freshness": "STALE",
  "ageSeconds": 742 }

// 无定位；或时间戳无法解释
{ "position": null, "freshness": "UNAVAILABLE", "ageSeconds": null }
```

| 状态 | 含义 | 客户端可以 | 客户端不得 |
| --- | --- | --- | --- |
| `FRESH` | 有坐标且 `age <= 600 s` | 显示为当前位置、用实时样式 | — |
| `STALE` | 有坐标但 `age > 600 s` | 显示**最后已知位置**，必须标注"位置已过期/最后更新于 X 分钟前"，地图样式与实时区分 | 作为实时距离、候选排序、任务重规划依据 |
| `UNAVAILABLE` | 无坐标，**或时间戳无法解释** | 显示"暂无位置" | 伪装成 FRESH 或 STALE |

**边界沿用已冻结的旧语义**：`> 600 s` 才 STALE，**恰好 600.000 s 仍 FRESH**。

### 一个必须写进契约的细节（测试发现）

`ageSeconds` 是**向下取整的展示值**，**不足以反推 `freshness`**：
在 600.001 s 时它仍报 `600`，而判定已是 `STALE`（判定用毫秒）。
**客户端若自行算 `ageSeconds > 600 ? STALE : FRESH` 就会与服务端不一致**——
这正是 `freshness` 必须是**显式字段**而不是留给客户端推导的原因。
已有专门的测试锁定这一点。

### 范围纪律（严格遵守）

| 改了什么 | 没碰什么 |
| --- | --- |
| `DevicePresenceView` 展示契约（`latestPosition` → `position`/`freshness`/`ageSeconds`） | prune 时机 |
| `contracts/openapi.yaml`（新增 `PositionFreshness` / `LastKnownPosition`） | heap / `positionMaxAgeSeconds` |
| iOS `DevicePresence` Codable 模型 | 任务分配、`replanAssignments` |
| 契约测试 + 基线 | 附近响应者资格、招募圈、事件证据 |

### 差分证据

基线 diff：**32 处角色/时点全部是字段改名 + 三个新字段，`stateLatestPositionPresent` 一处未变**
——即**存储与回收行为完全没动，改的只是展示语义**。

### 单独记录的后续问题（本次**未**改）

> **任务重规划是否允许使用超过 10 分钟的最后已知参与者位置？**

`replanAssignments` 是审计中唯一既不显式判时间、又可能消费超龄参与者位置的路径。
**产品建议：不应把它当实时起点直接重规划**，但这是**另一项行为变更**，
需要单独测试与评审，本次不顺手改。

## 5. 尚未完成（不得声称已完成）

| 项 | 状态 |
| --- | --- |
| **⑤ `presenceView` 显式 freshness** | **已完成**（见 §4ter）：三态契约 + `>600s` 边界 + `ageSeconds` 不可反推 + 基线 diff 证据。**客户端"STALE 不得渲染成实时样式"的 UI 测试仍未做**——当前 iOS 无任何视图读取 `DevicePresence.position`，因此没有可渲染点；需在真正接入显示时一并补 |
| **⑥ 行为冻结点** | **已完成**（见 §4bis）。注意它是**特征化测试**（记录现状），不是"按规则写预期值"——因此后续 ⑤ 造成的每一处变化都会以显式 diff 呈现 |
| 把物理删除改为独立周期（30 min / 1 h / 批量） | **未做，且现在不应做。** 只有 ⑤⑥ 通过后才可独立调整删除时间 |
| tick 挂定时器（"没人访问就不删"） | **未做。** 是合规缺口，但属于删除*时机*变更，同样要等 ⑤⑥ |

## 6. 一句话

> **有效性由时间戳决定、物理删除只是回收**——这个判断是对的，但**必须先用差分测试证明**，
> 而不是先改结构再补证明。当前状态是：
> **成本已降（索引驱动），时机已复原（三个入口点），边界已钉死（`>` / clamp / 非法值）**；
> **`presenceView` 的显式 freshness 与完整差分测试仍未做，因此物理删除时间现在不能改。**


---

## 7. 本次变更说明（冻结）

### 完成

- ✓ `presenceView` 增加位置 freshness 语义（`position` / `freshness` / `ageSeconds`）
- ✓ ACTIVE 参与者保留 last-known position
- ✓ 超过 10 分钟标为 `STALE`（边界 `> 600 s`，恰好 600.000 s 仍 `FRESH`）
- ✓ **原 prune 时机保持不变**（三个入口点未动）
- ✓ 任务资格 / 排序等**已有的** freshness 判断不改
- ✓ 基线 diff 已验证：32 处变化全是字段改名 + 新字段，`stateLatestPositionPresent` 一处未变

### 明确不属于本次

- ○ `replanAssignments` 对 `STALE` 的处理
- ○ prune 延迟 / 批量化
- ○ 10 分钟产品阈值调整
- ○ iOS `STALE` 视觉表现

### 必须明确写出的一条边界（当前系统中存在的已知不一致）

> **`presenceView` 的 `STALE` 语义只改变"如何向客户端描述最后已知位置"，
> 不改变任务重规划的决策规则。**

因此当前确实可能出现下面这种**并存状态**：

```jsonc
// presenceView：明确告知客户端这不是当前位置
{ "position": { … }, "freshness": "STALE", "ageSeconds": 900 }
```
```
// 与此同时，replanAssignments 仍沿用原有行为，可能把同一坐标当作改道起点
```

**这是一个需要后续评审的规则缺口，但把它如实记录下来，
比在这次提交里悄悄改变任务逻辑要安全得多。**

### Deferred（明确延期，不声称已做）

```
Deferred: When DevicePresence.position becomes user-visible,
          STALE positions must not use the same visual treatment as FRESH positions.
```

当前 iOS **没有任何视图读取 `DevicePresence.position`**，因此不存在可渲染点，
也就**不能合理声称已测试"STALE 地图标记与实时位置视觉不同"**。
本次只验证到：后端契约、以及客户端模型能正确 decode 该状态。

---

## 8. RISK / PRODUCT DECISION — stale participant position in assignment replanning

**状态：未决，单独立项，不属于 Presence freshness 契约改动。**

需要回答的不是"超过 10 分钟还用不用位置"这一句，而是至少三种情况：

| 情况 | 建议 |
| --- | --- |
| 有新鲜位置 | 正常用于重规划 |
| 位置 `STALE`，但仍在 ACTIVE 事件中 | **不应直接当"当前起点"做精确距离/ETA 决策** |
| 完全没有位置 | 进入"无位置"情况下的 fallback |

**真正需要设计的是第二种。** 候选产品策略：

| 策略 | 含义 | 评价 |
| --- | --- | --- |
| **A. 严格禁止** | `STALE` → 不参与任何依赖位置的重新分配 | 最保守 |
| **B. 仅供参考，不参与自动决策** | UI / 日志可展示"最后已知位置：XX，12 分钟前"，但自动分配不基于该坐标 | 中等 |
| **C. 降级使用** | `FRESH` 正常计算；`STALE` 仅维持已有任务，**不基于旧位置发起新的自动改派** | **倾向此项** |

倾向 C 的理由：AED 场景下，旧位置可以作为"继续保持现有任务"的参考，
但**不应成为新的自动改派依据**——这与本次"信息不能假装实时"的原则一致。

**但这必须在完成 `replanAssignments` 完整业务路径审计之后再冻结**，
不能凭现在的局部理解定规则。

**本次不做任何相关改动。**
