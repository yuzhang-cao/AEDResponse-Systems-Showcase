# 事故处置手册（G15）

本手册对应清单 G15「形成断网、供应商故障、磁盘满、数据库损坏、服务重启和发布回退的处置手册」。
每条都写明**先看什么**、**系统本身已经怎么处理**、**人该做什么**，以及**哪一步不能做**。
所有命令都在仓库根目录或 `backend/` 下可执行；生产路径以 `/var/lib/aedresponse` 为例。

统一入口：

```sh
# 业务探针（G15）：读运维状态，degraded/action_required 时非零退出
node backend/deploy/azure/ops-probe.mjs --url http://127.0.0.1:8787 \
  --operator-token-file /etc/aedresponse/operator-token

# 副本内容核验（G15）：不解密业务数据，只证明副本能否恢复
node backend/deploy/azure/verify-backup.mjs --backup <file.sqlite> \
  --sealed-dir <file.sqlite.sealed> --seal-key <file.sqlite.seal-key> \
  --key /var/lib/aedresponse/state.sqlite.evidence-key.pem

# 本机恢复演练（G15）：把副本还原到临时目录并真的启动一次
node backend/deploy/azure/restore-drill.mjs --backup <file.sqlite> \
  --sealed-dir <file.sqlite.sealed> --seal-key <file.sqlite.seal-key> \
  --ledger /var/lib/aedresponse/identity/state.identity-ledger.jsonl \
  --watermark /var/lib/aedresponse/identity/state.sqlite.restore-watermark.json
```

`GET /api/v2/ops/status`（operator 凭据）给出每条关注项的判定：`ok` / `degraded` / `action_required`。
`/healthz` **只**表示进程活着，不能用来判断业务是否正常——这正是本手册存在的原因。

---

## 1. 断网 / 供应商不可达（APNs、Apple、高德）

**先看**：`ops-probe` 输出的 `notification_outbox`（`outboxOverdue`、`oldestOutboxOverdueSeconds`）、
`appleRevocationsRetried`；日志中的 `Push dispatch incomplete; durable records retained for retry`。

**系统已经怎么处理**
- 通知进持久 outbox：`PENDING` 行按 `nextAttemptAt` 重试，socket 与 APNs 是两条独立通道，一条失败不影响另一条；
- 路线：`AED_AMAP_WEB_KEY` 缺失或供应商超时不会退回参考几何——生产启动即拒绝缺 key 的配置，
  运行期供应商失败返回错误而不是编造路线；
- Apple code 兑换失败视为登录失败（不会留下无法撤销的账号）；token 撤销进 `appleRevocationsById`
  重试队列，`invalid_grant` 视为已达终态。

**人该做什么**：确认是本机出口还是供应商侧（`curl -sS https://api.push.apple.com` 等）；
网络恢复后无需人工重放——下一个 tick 会继续。overdue 持续增长说明进程内的 drain 没有推进，
重启服务是安全的（outbox 是持久的，重启不会丢事实）。

**不能做**：不要手工删除 outbox 行来"清空积压"，那会丢掉未发出的业务通知；
不要把 `AED_AMAP_WEB_KEY` 换成演示数据源。

## 2. 磁盘满 / 写入失败

**先看**：`ops-probe` 的 `retention_purges`（deferred）、`cold_copies`、`sealing`、`media_erasure`；
日志中的 `Cold sealing skipped:` / `Media deletion skipped:` / `Retention sweep failed`。

**系统已经怎么处理**
- 写封存容器失败 ⇒ tier 仍推进（30 天到期是事实）但**清除被拒绝**并计入 `purgesWithheldNoColdCopy`，
  下次扫描重新尝试写副本（计划器把"已封存但无副本"的到期事件判为需要再次封存）；
- 对象存储删字节失败 ⇒ **整个清除被扣留**，引用行保留，重试仍知道要删什么；
- 清除阶段 SQL 失败 ⇒ 授权已提交、事件仍在 `SEALED`，下个 tick 重试（不会重复授权）；
- 提交失败不会污染持久状态（R01 回归：SQLite 回调内不再改内存镜像）。

**人该做什么**：清理空间后确认 `purgesWithheldNoColdCopy` 与 `retentionDeferredPurges` 回到 0；
若 `sealedContainerFailures` 非零而 `sealedContainersWritten` 为 0，先修好封存目标路径的权限。

**不能做**：不要为了"让指标好看"手工写 `retention.sealedContainer`——那是伪造冷副本存在，
会让清除删掉唯一一份证据。

## 3. 数据库损坏 / 启动校验拒绝

**先看**：启动日志（`SQLite quick_check failed` / `Unsupported SQLite storage format` /
`state_schema_version ... this build loads only 2.0` / `Refusing to start: the identity ledger is older
than its watermark`）。

**系统已经怎么处理**：损坏或不兼容时**拒绝加载**而不是静默重置；证据签名缺密钥时拒绝启动；
账本回滚时拒绝启动并要求显式承认。

**人该做什么**：按第 5 节恢复；账本回滚的显式承认
（`AED_ALLOW_STALE_IDENTITY_LEDGER=1`）只用于"确实要把旧库盖回来"的场景，承认会写入账本与水位，
之后必须人工补做两次备份之间发生的关闭与撤销。

**不能做**：不要删除 `state.sqlite.evidence-key.pem`、不要重建签名 baseline、
不要跳过启动校验来"先让它起来"——那会把不可检测的篡改当成正常运行。

## 4. 服务重启 / 发布回退

**先看**：`ops-probe` 的 `uptimeSeconds`（是否刚重启）、`database_commits`、`retention_sweeps`。

**系统已经怎么处理**：状态全在 SQLite，重启后调度器从持久阶段时间戳继续；
留存清除的失败会跨重启重试（`test/retention.test.ts` 的进程重开用例）；
会话与设备绑定的重放检测在重启后仍然生效。

**发布回退**（另见 `docs/release-runbook-2026-09-13.md` 第 4 节）：
保留上一版 `dist/` 与匹配的 state 备份 → 停服 → 换回代码 → 重启 → 用 `ops-probe` 与只读业务端点核对。
**若新版写入的状态格式旧版无法加载，启动会被校验拦住**：这是刻意选择（拒绝启动优于静默丢事实），
此时必须恢复与旧版匹配的备份，而不是绕过校验。

## 5. 从备份恢复（含身份重放）

1. 用 `verify-backup.mjs` 核验副本集（数据库 + 容器 + 封存密钥 + 证据签名密钥）；
2. 停机，把副本还原到目标路径；
3. 把**当前**（非备份中的）`AED_IDENTITY_LEDGER` 与 `<dataFile>.restore-watermark.json` 放到
   `AED_IDENTITY_LEDGER` 指向的位置——账本必须在数据库备份集之外，见 `docs/backup-recovery-2026-09-13.md`；
4. 启动前可先做本机演练：`restore-drill.mjs` 会在临时目录启动一次真实实例，验证
   `/healthz`、`/api/v2/ops/status` 为 `ok`，并核对账本里的关闭/撤销确实已重放；
5. 启动后读 `ops-probe`：`identity_ledger` 必须为 `ok`，日志会打印
   `Identity ledger ...: N closure(s) and M revocation(s) replayed`；
6. 用只读业务端点抽查事件/任务可见性，确认已关闭账号仍然关闭、被撤销会话无法再认证。

**不能做**：不要把账本与水位一起从备份还原（整机回滚无法本地检测，属已知边界）；
不要在未核验副本的情况下直接覆盖生产库。

## 6. 证书与备份时效

- 证书到期：`ops-probe` 不检查 TLS 证书（入口由 Caddy 负责），到期前用 `caddy validate` 与
  `openssl s_client -connect <host>:443` 核对；证书续期由部署侧完成。
- 备份时效：`backup-sqlite.sh` 每日本机备份并保留 14 天；异机/异故障域加密备份与定期校验
  仍需第二台主机（**待外部条件**），在此之前不得声称已有异地恢复能力。

## 7. 安全事件（凭据/审计）

- 怀疑 operator 凭据泄露：换 `AED_OPERATOR_TOKEN`（无状态，换值即轮换），旧值立即失效；
  `GET /api/v2/ops/access-audit` 只记录 `OPERATOR` 类别与原因，不含凭据本身。
- 怀疑封存密钥泄露：按发布手册 4.1 节轮换；容器头记录 `keyFingerprint`，
  用错密钥读取报 `WRONG_KEY`（不是 `CORRUPT_CHUNK`），据此区分"取旧密钥"与"从备份恢复"。
- 需要看"谁在什么时候读了什么"：`accessAuditById` 保留 3 年，`securityLogById` 保留 6 个月；
  两者都不含 token、body 或坐标。
