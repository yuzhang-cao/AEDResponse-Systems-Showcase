# 备份、恢复与业务探针（G15）

本文把「同机每日备份」提升为可执行的恢复能力清单，并明确 **本机可验证** 与 **待外部条件** 的界线。
当前仓库只有同机备份脚本（`backend/deploy/azure/backup-sqlite.sh`）；异机/异故障域与恢复演练需要第二台主机。

## 已具备

- 每日一致性备份：`sqlite3 .backup` + `integrity_check`，保留约 14 天，脚本刻意放在发布树之外。
  同一次运行还会一并复制 **加密封存容器目录**（`${dataFile}.sealed/`，密文）与 **封存密钥**
  （`${dataFile}.seal-key`，0600），并让三者按同一时间戳一同过期：满 3 年清除在线证据的前提
  是冷副本存在，副本集缺容器或缺密钥就等于恢复出一个无法兑现留存承诺的服务。
- 证据签名密钥：`${dataFile}.evidence-key.pem`（0600）。**缺密钥时服务拒绝启动**，因此备份必须
  同时包含数据库与密钥，否则恢复出来的库无法校验签名。
- **身份账本（G11 恢复重放）**：`${AED_IDENTITY_LEDGER}`（默认 `${dataFile}.identity-ledger.jsonl`）
  逐行记录账户关闭与全会话撤销；服务启动时把账本重放进刚加载的状态，并写一份水位文件
  `${dataFile}.restore-watermark.json`。账本与水位**必须放在数据库备份集之外**（独立卷/异机），
  否则整机回滚会连账本一起回滚，本地机制无法察觉。
- `/healthz` 只证明进程活着，不作为业务探针。

## 本机可验证的恢复检查（已实现为脚本）

```sh
node backend/deploy/azure/verify-backup.mjs \
  --database backend/.data/state.sqlite \
  --backup   /var/lib/aedresponse/backups/<file>.sqlite \
  --key      /var/lib/aedresponse/state.sqlite.evidence-key.pem \
  --sealed-dir /var/lib/aedresponse/backups/<file>.sqlite.sealed \
  --seal-key   /var/lib/aedresponse/backups/<file>.sqlite.seal-key
```

脚本逐项检查并输出结论：

1. 备份文件存在、大小非 0、`PRAGMA integrity_check` 为 `ok`；
2. 备份内的 `state_metadata.state_schema_version` 与当前代码支持的版本一致；
3. 备份包含 `eventEvidenceLogById` / `eventEvidenceHeadsById` 时，必须同时提供对应密钥文件，
   否则报告「恢复后无法验证证据链」并失败；
4. 关闭状态与删除标记可读：统计 `users.lifecycleState='CLOSED'` 与 `deletionRequestsById`，
   输出数量，供人工核对「旧备份不能复活已关闭用户」；
5. **冷封存容器**：备份里出现 `retention.sealedContainer` 时，逐个检查容器是否存在、大小与记录
   一致，并用服务自身的读取器（`src/sealed-store.ts`，Node 24 直接运行 TypeScript）解密校验
   分块 GCM 标签与顺序摘要；缺容器、缺 `--seal-key`、密钥权限过宽、密钥不对、容器被截断
   全部判失败；
6. 输出 RPO/RTO 提示行：脚本记录备份时间戳与检查耗时，实际 RPO/RTO 由运营按下表填写。

上述 1–5 项由 `backend/test/backup-verification.test.ts`（7 项）以真实 SQLite 文件与真实密文容器
回归：通过路径、缺密钥、密钥 0644、错误密钥、截断容器、缺容器、空/非 SQLite 文件各一例。

## RPO / RTO（需要运营确认后填写）

| 项目 | 目标值 | 依据 | 当前状态 |
| --- | --- | --- | --- |
| RPO（最多可接受丢失多久的数据） | 待运营确认 | 每日备份 ⇒ 最坏丢失接近 24h；若不可接受需加密增量/异机复制 | **待外部条件** |
| RTO（恢复服务允许耗时） | 待运营确认 | 取决于实例重建与数据量；本机演练只能给出检查耗时 | **待外部条件** |

## 恢复时的身份重放（本机已实现，演练待外部条件）

恢复步骤里 **必须** 包含「账本在位」这一条：

1. 用备份集里的数据库、封存容器与两把密钥还原到目标路径；
2. 把**当前**（非备份中的）`${AED_IDENTITY_LEDGER}` 与 `${dataFile}.restore-watermark.json`
   放到 `AED_IDENTITY_LEDGER` 指向的位置；
3. 启动服务：启动阶段会重放账本（重新关闭账户、重新撤销会话并重排 Apple 撤销），
   日志与 `identityLedgerStatus()` 给出 `accountsClosed` / `sessionsRevoked` / `entriesAppended`；
4. 若账本比水位旧（说明账本也被回滚），服务**拒绝启动**并说明原因；确认是本人操作时用
   `AED_ALLOW_STALE_IDENTITY_LEDGER=1` 显式承认，承认会写入账本与水位，运营必须自行补做
   两次备份之间发生的关闭/撤销。

回归证据：`backend/test/restore-guard.test.ts`（4 项）——真实关闭后把旧库盖回、账本重放使账号
仍为 CLOSED 且旧会话无法认证（正向）；删除账本后同一份旧库恢复出可用的 ACTIVE 账号（负向对照，
证明机制不可省）；账本回滚被拒并记录承认；账本幂等且拒绝损坏行。

## 待外部条件（不伪造）

- **异机/异故障域加密备份**：需要第二台主机或对象存储、加密密钥托管与失败告警通道；
  账本与水位也必须落在数据库备份集之外，否则整机回滚无法检测。
- **新实例恢复演练**：需要一台可丢弃的隔离实例；演练内容为「从备份启动 → 事件/任务可读 →
  会话撤销仍生效 → 已关闭账号不复活 → 继续写入」。
- **告警通道**：需要邮件/短信/webhook 凭据。

在上述条件具备之前，这一项保持「待外部条件」，不得用同机拷贝或本地检查代替异机恢复证据。

## 业务探针

`verify-backup.mjs` 之外，服务端已有可判定的业务计数器（留存、outbox、推送、Apple 撤销等），
运营探针应读取这些计数器而不是只看 `/healthz`：outbox 积压、`retentionDeferredPurges`、
`purgesWithheldNoColdCopy`（有到期事件但没有冷副本，清除被拒）、`sealedContainerFailures`、
`identityLedgerFailures`、`appleRevocationsRetried`、`retentionSweepFailures` 长期非零都表示
业务或合规承诺在退化。`retentionStatus()` 另外给出最近一次留存扫描的
`sealed / repaired / purged / deferred / withheldNoColdCopy` 明细。

