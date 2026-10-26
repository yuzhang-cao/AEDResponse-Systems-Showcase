# Watch 认证部署：已暂停，实际绑定仍为 401

用户明确授权部署，随后于 2026-09-22 01:04 左右要求暂停休息。不要自动继续设备操作或监控。控制台日志采集已停止；未触发 Fall、SOS 或救助事件。

## 部署与回退位置

- 旧线上版本 `/opt/aedresponse/releases/phase1-tx-20260912-124300`。
- 当前 `/opt/aedresponse/current` 指向 `/opt/aedresponse/releases/watch-attest-20260922-r3`。
- 这是旧线上基线的定向 Watch 修复，不是最新 backend 全量部署。新增 App Attest 验证器、证书根、解析器及 auth/config/main 接线；service/store/models/server 保持旧基线，数据库 schema 不变。
- 完整备份 `/var/backups/aedresponse/watch-attest-20260922/`：旧 release 压缩包、原配置/systemd、一致性 before.sqlite、at-switch.sqlite、at-switch-2.sqlite、SHA-256 与测试日志。哈希和数据库完整性通过。
- 原 `/etc/aedresponse/backend.env` 逐字保留。新增 `/etc/aedresponse/watch-attest.env`，由 `aedresponse.service.d/95-watch-attest.conf` 最后载入：`AED_WATCH_ATTEST_ENVIRONMENT=production`、`AED_WATCH_VALIDATION_CATEGORIES=3`。App ID 仍为 `[TEAM].dev.codex.aedresponse.watchkitapp`，版本白名单 `2`。
- 本机准备目录 `/tmp/aed-watch-deploy-20260922.GhZJeT/` 含远端源码快照、最终候选源码、脚本与本地日志；远端脚本 `/home/REDACTED/aed-watch-deploy-20260922/`。
- 远端 SSH：`azureuser@[REDACTED-HOST]`，使用已有 `/Users/REDACTED/Downloads/aedresponse-server-key.pem`；不要打印或复制私钥。
- 回退先核对 current，将本次新增的 Watch env/drop-in 移到备份目录保留，再原子切回旧 release、daemon-reload、reset-failed、重启和检查。无需恢复旧数据库，不得覆盖新证据。

首次候选构建继承 umask 077，root 编译的 dist 为目录 0700/文件 0600，服务账号无法读取，造成约一分钟 502。已回旧版本恢复，修正候选权限，并在实际 aedresponse 账号、18787 端口和独立数据库副本上预启动通过后重新切换。最终服务 active/running，NRestarts=0，health=200，SQLite integrity_check=ok。

## 实测失败点

1. 503 根因：旧 main 没有注入验证器，配置虽然存在也无效。部署后无效票据返回预期 401，HTTPS/WSS 检查通过。
2. 首次真实验证拒绝于 `attestation-environment(expected=development,observed=production)`；按真实证明调整环境后继续。
3. 最新真实拒绝：`build-extensions(flags=64,trailingBytes=0)`。Apple 证书链、nonce、公钥/App ID、production AAGUID、credential ID 和 COSE key 均已通过，但手表证明完全没有尾部版本/签名类别字段。配置类别 3、版本 2 不代表它们已被证明验证。服务器 Watch 设备记录仍为 0，实际业务未通过。

Watch 构建使用 Xcode 26.6 / watchOS 26.5 SDK，设备系统 watchOS 27。扩展缺失的具体原因尚未确定，不得声称升级 SDK 一定解决。

已提出“仅当前账号和 Watch 的受控兼容”选择，用户未批准而要求暂停。兼容策略未实现、未启用；缺失 build metadata 继续拒绝。下次用户恢复后，先确认这一实际准入选择，或寻找能提供可验证元数据的构建。不得全局放行缺失证明或伪造版本。

## canonical 代码与验证

- apple-app-attest.ts：固定拒绝阶段日志（无凭据）；App Attest 环境与签名类别分离；解析真实存在的扩展而不错误要求 ED 位；CMS 同时验证直接签名与 signed attributes，保留签名、证书、时效、App ID、公钥检查。
- config.ts/main.ts：受限 `AED_WATCH_VALIDATION_CATEGORIES` 配置；README/env example 更新。
- 测试使用 Apple 官方公开签名样例验证 ED 与 CMS 兼容，并拒绝篡改、过期、错误 App ID/版本/类别及缺失扩展。公开样例不是用户的设备证明或凭据。
- canonical check、完整测试 **692/692** 通过；远端候选 check/build、旧基线 **463/463**、Watch/配置/companion **18/18** 通过。
- 最终公网 verify-public.mjs 通过：health 200、匿名 REST 401、schema 400、16 KiB 400/413、WSS 匿名拒绝。
- 最后数据库：4 事件、495 历史位置批次、4 组 timeline 均保留；0 Watch。无救助事件新增。
- 本轮未改客户端；原有 UI 未提交修改保留。未提交或 push。

## 协议依据

[Apple 验证步骤](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)、[官方签名样例](https://developer.apple.com/documentation/devicecheck/attestation-object-validation-guide)、[回执验证](https://developer.apple.com/documentation/devicecheck/assessing-fraud-risk)。样例存于 backend/test/fixtures/apple-app-attest-official.json；样例具有扩展，不能用来证明本机缺失扩展可直接放行。
