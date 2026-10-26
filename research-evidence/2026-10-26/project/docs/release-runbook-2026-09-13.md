# 发布前检查与回退手册（G14/G15）

本文件是发布链路的手工入口：CI（`.github/workflows/verify.yml`）能跑的后端/契约/配置检查在 CI 里跑，
需要 macOS、Apple 账户、真机或异机主机的部分在这里逐条列出命令、判定标准和回退方式。
**未执行的项目不勾选**，需要什么条件写清楚。

## 1. 本机即可完成的发布前检查

```sh
cd backend && npm run check && npm run build
cd backend && npm test          # 必须 0 失败
cd backend && npm run smoke     # 契约 5/5、后端 18/18
node scripts/check-legal-readiness.mjs   # 未补齐真实政策地址/邮箱时以退出码 1 阻断
bash scripts/ios-smoke.sh       # iPhone/Watch 编译
IOS_SMOKE_SIMULATOR=1 IOS_SMOKE_CACHE_ROOT=/tmp/aed-ios-cache bash scripts/ios-smoke.sh
```

判定：任一条失败即停止发布。`check-legal-readiness.mjs` 退出码 1 表示法律信息未就绪
（当前 `contracts/agreements.json` 的 `privacyPolicyURL`/`contactEmail` 仍为空，属运营填写项）。

## 2. Caddy 配置（结构断言 + 真实解析）

仓库内 `backend/test/release-gates.test.ts` 只断言 `header_up` 的**层级**；真正的解析在 CI 里：

```sh
cd backend/deploy/azure
AED_PUBLIC_HOST=<真实域名> caddy validate --config Caddyfile --adapter caddyfile
sudo diff /etc/caddy/Caddyfile backend/deploy/azure/Caddyfile && echo "等于基线"
sudo systemctl reload caddy
```

判定：`validate` 退出 0；`/healthz=200`、未认证 `/api/v2/*=401`、已删除的临时路径 `=404`。
回退：`cp /etc/caddy/Caddyfile.before-aedresponse /etc/caddy/Caddyfile && systemctl reload caddy`。

## 3. 环境隔离

| 环境 | 服务地址 | 数据库 | fixture | 测试功能 |
| --- | --- | --- | --- | --- |
| 开发 | 本机 loopback | 本地 `.data/state.sqlite` | 仓库 demo 目录 | 可开（Debug） |
| 联调 | Azure 开发 VM | 独立测试库 | 显式 `AED_FIXTURE_FILE` | 受控账号开关 |
| 正式 | 生产入口（TLS/访问控制） | 生产库 | 真实库存文件 | 必须关闭（`AED_SHOW_TEST_TOOLS=NO`、`AED_ENABLE_TEST_FEATURES=NO`） |

`npm run check` 会在 production 缺 `AED_AMAP_WEB_KEY`/`AED_FIXTURE_FILE` 时拒绝启动；
`createBackend` 在 production 拒绝参考几何路线 provider。

## 4. 版本兼容与回退

- 持久化状态带 `schemaVersion`；不兼容时 `store.ts` 明确拒绝加载，而不是静默重置。
- 客户端与服务端错配：客户端按 `contracts/openapi.yaml` 生成/校验，新增端点是向后兼容的加法；
  证据签名密钥文件 `${dataFile}.evidence-key.pem` 必须随备份一起保存，缺密钥时服务拒绝启动。
- 回退步骤：保留上一版 `dist/` 与匹配的 state 备份 → 停服 → 换回代码 → 重启 → 验证
  `/healthz` 与业务只读端点 → 确认事件/会话/删除标记仍按预期可见。
  **不要通过删除签名或重建 baseline 绕过启动校验。**

## 4.1 密钥运维（G12）

四类密钥/凭据，各自的生命周期与轮换方式：

| 密钥 | 位置 | 用途 | 轮换 |
| --- | --- | --- | --- |
| 证据签名密钥 | `${dataFile}.evidence-key.pem`（0600） | 事件证据 Ed25519 事务签名 | 启动时 `EvidenceSigner.open` 读同一文件；信任集轮换由 `test/evidence-integrity.test.ts` 覆盖（旧签名在新信任集下仍可验证）。**禁止**删除密钥或重建 baseline 来绕过校验 |
| 封存密钥 | `${dataFile}.seal-key`（0600，拒绝组/其他可读） | 解密满 30 天的加密冷封存容器 | 容器头记录 `keyFingerprint`（`sha256(key)` 前 16 位十六进制）；用错密钥读取报 **`WRONG_KEY`** 而不是 `CORRUPT_CHUNK`，运维据此判断「取旧密钥」还是「从备份恢复」。轮换步骤：旧密钥改名保留 → 生成新密钥 → 对仍报 `WRONG_KEY` 的容器用旧密钥解密并以新密钥重写（`readSealedContainer` + `writeSealedContainer`）→ 确认全部容器可读后才可归档旧密钥 |
| 封存密钥（备份副本） | 备份集内 `<backup>.seal-key` | 恢复时解密副本中的容器 | 与数据库副本同批复制、同批过期；`verify-backup.mjs --seal-key` 会校验权限与真实解密 |
| operator 凭据 | `AED_OPERATOR_TOKEN`（环境变量，不入库） | legal hold、break-glass、本人查看审批、访问审计读取 | 换值即轮换（无状态）；轮换后旧值立即失效，审计条目只记 `OPERATOR` 类别而不记凭据本身 |
| Apple 相关（客户端密钥 `.p8`、Services ID） | 部署密钥文件 + 环境变量 | authorization code 兑换与 token 撤销 | 轮换由 Apple 侧控制；撤销队列按账户重试，`invalid_grant` 视为已达终态 |

安全日志保留 6 个月（`securityLogById`，按截止时间索引清扫），业务数据访问审计保留 3 年；
两者都不含 token、body 或坐标，且写入时按白名单字段校验（见 `test/security-log.test.ts`）。

## 5. 需要 macOS / Apple / 真机（待外部条件）

```sh
cd ios && xcodebuild -project AEDResponse.xcodeproj -scheme AEDResponse -configuration Release \
  -destination "generic/platform=iOS" archive -archivePath /tmp/AEDResponse.xcarchive
```

需要：Apple Developer Program 会员资格、正式 Bundle ID 与分发 profile、Fall Detection 能力授权、
一台物理 iPhone 与一台配对 Watch。缺这些条件时**不得**用无签名构建或模拟器结果代替，
应记录为“待外部条件：<缺少的具体项>”。

### 最终实机测试的安全与责任前置条件

执行第 5 节关联的真人实机流程前，先完成[总验收清单 G16-S](全项目待办与验收清单-2026-09-13.md#g16-s最终实机测试受控测试与中国境内责任边界)中适用于当前阶段的前置事项。纯合成、真人数据测试和真实对公众运营分别记录；测试方案、单独同意和独立影响评估不得事后补办，真实紧急呼叫不得作为普通测试手段。缺少安全条件或实际协议文本时如实记缺项，不自动签署或对外发送材料。

验收同时核对 UI 的救助状态、120 提示、志愿协同边界及异常/隐私行为；正式运营前另核对实际运营主体、责任分工、培训和保险。各项保留证据与残余问题，不能将签名安装、技术测试或 entitlement 授权等同于运营合规。本轮仅排入计划，年龄问题暂不处理。

## 6. 备份与恢复（G15）

异机/异故障域加密备份与恢复演练需要第二台主机与密钥托管，属待外部条件；脚本与步骤见
`backend/deploy/azure/backup-sqlite.sh` 与 `docs/backup-recovery-2026-09-13.md`。
