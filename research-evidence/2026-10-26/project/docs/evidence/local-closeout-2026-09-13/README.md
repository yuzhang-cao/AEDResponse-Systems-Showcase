# 本轮收尾验收（2026-09-13）

用户最新指示为“把你现在做的完成了的结束就行了”。本轮在已完成的修改上收尾，剩余未冻结项目不继续扩展，也不记为已完成。未提交、推送、部署或连接生产库；全部后端运行使用本地临时数据库和合成身份。

## 完成范围与证据

| 范围 | 已完成的部分 | 尚未完成的边界 |
| --- | --- | --- |
| G02/G05/G11 账户与救助退出 | 手机端阻止活动参与中的退出/注销；患者取消和响应者退出采用三次确认；本机退出立即停止业务并持久重试远端撤销；服务器逻辑关闭保留信息，账户 `ACTIVE/CLOSED` 与设备 `SIGNED_IN/SIGNED_OUT` 分离；关闭后拒绝旧凭据、刷新和自动重新登录；同一关闭请求可重放回执而不恢复业务权限 | 实际手机点击、完整协议状态 UI 验收、关闭后重新注册政策、备份恢复后的关闭状态重放 |
| Apple 登录客户端 | 补齐 `APIClient.requestAppleLoginChallenge()` 的真实请求，修复原来落入协议默认报错的缺口；验证异步登录结果不能覆盖退出后的新会话 | Apple 授权码交换、token 撤销及正式账户验收 |
| G11/G13 留存 | 有限到期查询、30 天逻辑封存、日历三年清除、legal hold；先授权后清除并可靠重试；SQLite 重开继续，清除完整事件证据和反向索引，保留运营资产占用 | 加密冷封存、历史不加载到主状态、生产恢复演练、本人查看申请 |
| G12 证据 | 事务内 Ed25519 签名链、终态签名头、历史 BASELINE、启动校验、签名清除授权、密钥文件 0600、信任集轮换验证；故障回滚不推进签名头 | 访问审计、媒体证据、独立备份锚点、运营权限和完整密钥运维。没有独立头时不声称能发现整库回退 |
| G06 资产 | 受控登记/核验/维护命令、版本冲突及幂等、核验到期过滤；预留与物理取得分离；取用后退出仍不可分配，确认归还才重新可用 | 在途任务因运营停用立即失效的完整边界、双人交接、媒体、真实库存 |
| G13-A 回归计量 | 保留原局部化实现；HTTP 操作窗口与真实 interval tick 分开采样，防止额外墙钟 tick 污染严格计数；路由内 tick 和真实 outbox 仍执行 | G13 的全库启动/历史分层不是该范围验收的完成结论 |
| 佛山 AED 搜索 | 4 个 OSM 标注及原始 node 已保存，均为未核验候选、不可派发 | 地图信息不是现场核验或完整城市库存，未导入业务数据库 |

## 验证

| 命令/范围 | 结果 | 日志 |
| --- | --- | --- |
| `cd backend && npm run check` | 退出 0 | [类型检查](closeout-check.log) |
| `cd backend && npm run build` | 退出 0 | [构建](closeout-build.log) |
| `cd backend && npm test` | **514/514**，失败/跳过均为 0 | [完整后端回归](closeout-tests.log) |
| `cd backend && npm run smoke` | 契约 **5/5**、后端 **18/18** | [smoke](closeout-smoke.log) |
| iOS 应用/身份/退出三个测试类 | Simulator **118/118** | [客户端定向回归](ios-application-regressions-3.log) |
| iPhone/Watch 无签名编译档 | 两者 `TEST BUILD SUCCEEDED` | [iPhone](ios-build-iphone.log)、[Watch](ios-build-watch.log) |

后端完整回归包含留存 9 项、证据完整性 7 项、Memory/SQLite 资产 HTTP 2 项，以及账户、跨事件、网格和真实 interval tick 等原有回归。这些专项数量属于 514 项的子集，不重复相加。

iOS 定向命令为 `xcodebuild -project ios/AEDResponse.xcodeproj -scheme AEDResponseUnitTests -configuration Debug -destination 'platform=iOS Simulator,id=REDACTED-ID-0022' -derivedDataPath /tmp/aedresponse-smoke/iphone -clonedSourcePackagesDirPath ios/.build/SourcePackages -parallel-testing-enabled NO -only-testing:AEDResponseTests/AppStoreArchitectureTests -only-testing:AEDResponseTests/AuthenticationArchitectureTests -only-testing:AEDResponseTests/ResponderExitTests test`。运行于 19:37–19:38；后续没有修改客户端源码。118 项是选定应用逻辑测试，不是全套 UI/真机验收。早先 service hub 卡住的退出 75 不算通过，恢复后该命令通过。

[源码摘要](source-sha256.json)记录本轮最终后端、客户端、契约和测试文件的 SHA-256。历史轮次的 498/501、133 项结果仍是历史证据，不能与本轮数量混合宣称新的全套结果。

## 未完成草稿与后续

新写但尚未接线、类型检查和测试的 `apple-app-attest.ts`、`apple-app-attest-roots.ts`、`attestation-codecs.ts` 已移出 `backend/src`，保存在当前任务目录的 `未接线草稿/Watch-App-Attest-2026-09-13/`。没有其他源码引用，项目继续保持缺少可信 Watch 验证器时拒绝的原行为；该项仍未完成。

收尾后用户明确安排：剩余未冻结项交给 DeepSeek 实施，完成后交回 cdx 审核。[全项目清单](../../全项目待办与验收清单-2026-09-13.md)保留完整状态，[DeepSeek 交接说明](../../DeepSeek-全项目交接-2026-09-13.md)列出接手和回交要求。本目录日志仍记录上述收尾运行，文档更新不是新的源码测试结果。

后续核对生成的 [change-associations.json](change-associations.json)记录本轮快照到收尾状态的 44 个源码/测试/契约文件变化及工作包归属；它与源码摘要共同用于后续回审，不代替包含原有未提交文件的完整工作树。
