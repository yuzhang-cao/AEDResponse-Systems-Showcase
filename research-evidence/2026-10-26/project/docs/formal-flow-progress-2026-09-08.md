# 正式流程恢复开发与验收清单

2026-09-08 用户授权：补齐所有正式流程，保留测试代码，用代码开关控制，当前开启；17 Pro 与 16 可用于验证。此授权恢复先前暂停的代码开发，不代表 Apple 能力已获批或真实外部服务已接通。

外部条件：短信服务尚未开通/未选定；用户随后说明会员已开通、相关注册申请等待审核。不得代付、代申请或把会员开通等同于 Fall Detection entitlement 获批。服务器发布、生产数据层或数据库结构变更另行说明并确认；本批先本地实现和验证。

## 已确认的实现方向

- 正式入口始终为手机号 / Apple 登录，不再由“等待受控测试账号”替代整页。
- `AED_ENABLE_TEST_FEATURES` 通过构建配置控制测试能力；当前两个测试 Debug 目标开启，正式目标和 Release 关闭。即使关闭也保留测试源码，不能通过运行时开关给 Release 注入假身份。
- 离线 TestHost 仍强制无业务联网。受控身份只在明确开启的联网测试构建中使用；不新增匿名公共测试登录接口，也不把测试身份伪装成 PHONE/APPLE。
- 正式身份和已签协议优先，残留测试凭据不得覆盖真实登录。关闭测试开关后不接受受控身份，但不删除事件证据。
- 核对仍以 `docs/requirements.md` 的 V2-A01–A28 为准；UI 设计、编译、合成测试、实机和真实供应商结果分开记录。

## 工作与缺口

| 范围 | 本批状态 | 仍需的验收/外部条件 |
| --- | --- | --- |
| 正式登录 UI 与测试开关 | 登录页和代码开关已实现，身份隔离真机单元测试通过 | 真正供应商登录后的完整 UI 验收 |
| Apple token 验证 | 已实现 RSA/JWKS 验签、一次性 nonce challenge 和原生客户端接入；6 项本地验证器测试通过 | 正式能力签名、Apple 配置、实际身份登录、授权码交换与撤销同步 |
| 手机验证码 | 原 challenge/会话业务已存在 | 真实短信供应商、验证码安全生成/校验适配、真实发送 |
| 协议与权限门禁 | 已有实现 | 正式身份首次安装与双机重测 |
| 普通待命/搜索圈上传频率 | 本地已加入120秒/100米、15秒/30米门控，回执返回当前分层；逻辑测试通过 | 尚未发布新版后端；需要公网真实移动、后台与锁屏重测 |
| Watch 触发与回退 | 已有 coordinator/客户端和业务模型 | 真实 App Attest 验证、Fall entitlement、物理 Watch 与系统行为 |
| 请求、接受、分配、结束 | 已有业务/本地测试 | 两台真实手机完整闭环，真实通知与后台恢复 |
| 步行路线与 AED 重派 | 现有参考计算 | 高德路线适配、坐标派生、失败降级及实际配置 |
| 当面/照片交接 | 合同与部分领域基础 | 照片采集、私有媒体上传/读取、交接完整流程 |
| APNs、后台播报和通信 | 部分客户端与 Socket 实现 | APNs 配置/发送、物理后台通知、App 内联系能力 |
| 留存、删除与限时查看 | 部分 append-only/TTL 基础 | 分层封存、完整性/访问审计、申请查看、备份恢复删除重放 |
| 境内生产与高并发 | 尚未完成 | 生产 PostgreSQL/PostGIS、缓存队列、境内部署及60分钟验收 |
| 只读管理后台 | 已生成4页候选效果图 | 仍待明确 UI 批准、独立只读鉴权及接口，未自动发布 |

## 当前证据

- 修改前后端基线：114/114，`/tmp/aedresponse-formal-baseline-20260908.log`。
- 新增 Apple 验证器：`npm run check`、`node --import tsx --test test/apple-auth.test.ts` 6/6。测试在内存中生成独立 RSA 密钥，使用合成身份和模拟 Apple 公钥响应，不是真实 Apple 登录。
- 2026-09-08 只读获取 Apple 公共 JWKS，当前返回 RSA/RS256。该读取不申请开发者能力、不验证真实用户身份。
- 加入位置分层后：`npm run check`、`npm test` 121/121，日志 `/tmp/aedresponse-formal-cadence-backend-20260908.log`。合成业务测试覆盖拒绝/过期后仍在圈内、离圈恢复待命、重放旧回执不恢复旧分层。
- iPhone 16 真机 `AEDResponseUnitTests`：221 项，205 通过、16 跳过、0 失败；日志 `/tmp/aedresponse-formal-regression-iphone16-20260908.log`，结果 `Test-AEDResponseUnitTests-2026.09.08_20-19-08-+0800.xcresult`。其中11项是仅可在源码环境执行的检查，5项是未开启的独立公网诊断；没有使用模拟器。
- 该真机测试运行的是离线 TestHost 中的可移植业务/契约逻辑，并非真实 Apple/SMS 登录、后台轨迹或 Watch 系统事件。上一轮导入测试因 ISO 时间小数精度断言失败，已统一测试样例精度并在本轮通过。
- 随后补充 AuthView 的测试地址总开关和异常回调重试；联网 Debug 真机签名构建、`codesign --verify --deep --strict`、正式 iOS + 内嵌 watchOS Release 未签名编译均通过。额外构建 `AED_ENABLE_TEST_FEATURES=NO` 的联网 Debug 也通过；最终产物实际值依次为 YES / NO / NO。开关关闭构建未安装，不将编译检查称作真机 UI 验收。
- 20:22:58 已将当前开关为 YES 的联网测试版重新安装并无调试器启动于 iPhone 16；随后进程列表仍有 PID 10822。证据 `/tmp/aedresponse-formal-install-iphone16-20260908.json`、`/tmp/aedresponse-formal-launch-iphone16-20260908.json`、`/tmp/aedresponse-formal-processes-iphone16-20260908.json`。未卸载 App、未签发新账号、未复制17的凭据、未部署服务器；本轮未更新17 Pro。
- 构建日志：`/tmp/aedresponse-formal-controlled-iphone16-20260908.log`、`/tmp/aedresponse-formal-release-20260908.log`、`/tmp/aedresponse-formal-controlled-off-20260908.log`；`git diff --check` 通过。

## 本批实现边界

- Apple challenge 暂存于当前单进程后端内存，有效5分钟、最多5000条、一次消费；重启后旧挑战失效。部署多实例前必须迁移到共享原子存储，不能宣称已满足生产并发目标。
- 位置分层 ACK 只是最新值上传调度信息，不授予事件位置权限；事件证据仍要求 REST 参与窗口。回执重放返回当前分层，不改写已存的历史回执。
- 分层调度基于实际定位回调和最近成功请求开始时刻；不重贴时间戳、不制造新 fix。移动距离由经纬度球面距离计算。后台系统不给执行时间时不能承诺准点发送，须独立实测。
- 新增 Apple challenge 路由和分层 ACK 尚未部署到 Azure；旧服务缺少挑战路由时，客户端提示暂不可用，不回退到伪造身份。会员开通不等于申请获批。

本清单不是完成声明。每项必须取得相应证据才可改为已验收。
