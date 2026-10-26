# 登录持久化修复：build 5

## 当前目标与策略边界

用户反馈：退出 App 一两个小时后需要重新登录，希望保持长期登录。

线上只读核查显示：访问令牌15分钟，refresh凭据从明确登录时起固定30天。2026-09-27用户已澄清“从用户最后一次登录开始计算30天”：以最近一次成功登录为起点，关闭App/重启/自动换访问令牌不重新计算30天，再次成功登录建立新的30天窗口。现有服务端规则符合此选择，因此没有改成滚动续期，没有修改收费或使用次数，也没有执行服务器部署。

## 已确认的代码缺口与修复

1. 旧 APIClient 刷新成功后仅发异步通知，AppStore 用**网络 connectionGeneration** 决定是否保存。网络重连可以丢弃服务端已经轮换成功的凭据，下一次启动可能重用旧 refresh token。现在使用共享 `AuthSessionRefreshCoordinator`，先条件原子保存、后完成刷新及通知界面；网络换代不再丢弃账号凭据。
2. 原 single-flight 只在一个 APIClient 内生效；重连新实例与尚未结束的旧实例可能重复刷新。现在同一 AppEnvironment 的账号/业务实例共用协调器，旧快照先取得已保存的新值，避免重用已消费凭据。
3. Keychain 读取将“锁定/读取失败”和“不存在”都返回 nil。新增抛错式 `loadRecoverable`，只有 item-not-found 代表没有登录；暂不可读时保持恢复状态自动重试，不直接落到登录页。
4. Keychain 保存失败曾清空凭据并要求重新登录。刷新协调器暂存已收到的新凭据并重试保存，不再次提交已轮换的旧值。UI投影失败只重试读取，不回写旧凭据。
5. 新增仅本机使用的 `loginID`，随一次明确登录建立、随自动轮换保留；不同登录（包括同用户重新登录）不可被迟到结果覆盖。Keychain 原子比较写入，主动退出先禁止未完成刷新写回，保留既有持久退出/服务端撤销约束。

这些是源码可确认的缺口；没有对应用户那一次掉登录的完整错误日志，不能把任意一条认定为该次故障的唯一原因。

## 修改文件

- `ios/AEDResponse/Application/AuthSessionRefreshCoordinator.swift`：跨APIClient实例刷新、先保存后返回、失败待提交值。
- `Application/AuthModels.swift`：本机登录标识、兼容解码、可恢复读取/条件写入端口。
- `Services/AuthSessionStore.swift`：Keychain 读取错误分类、锁内条件写入、退出写回隔离。
- `Services/ControlledTestAuthSessionStore.swift`：受控测试包装层转发相同语义，不改变生产身份入口。
- `Application/AppEnvironment.swift`、`Networking/APIClient.swift`、`App/AppStore.swift`：共享协调器接线、恢复/保存流程和UI更新隔离。
- `ios/AEDResponseTests/AuthSessionRefreshCoordinatorTests.swift`、`AuthenticationArchitectureTests.swift`：恢复、并发、暂时故障、主动退出与重登录回归。
- `backend/test/auth.test.ts`：两小时访问令牌过期后刷新成功，29天仍可刷新、30天硬截止，明确新登录才建立新的30天窗口。
- `scripts/ios-smoke.sh`：新测试类加入正式过滤列表；本轮没有运行该脚本的 Simulator/设备执行路径。
- `ios/project.yml` 与生成工程：生产 iPhone/Watch build 5；保留既有 Watch scheme 和其他脏改。

## 已执行验证

临时目录：`/tmp/aed-login-persistence-20260926.Uh04p7`。

| 验证 | 结果 |
| --- | --- |
| Foundation/SwiftPM 本机测试 | **12/12通过**；`swift-auth-tests.log` |
| 后端 auth + companion-link + watch-relay HTTP 定向测试 | **47/47通过**；`backend-auth-tests.log` |
| generic iOS + Watch SDK unsigned build | BUILD SUCCEEDED；`build-initial.log` |
| iPhone XCTest build-for-testing | TEST BUILD SUCCEEDED；`iphone-auth-test-build.log`；只编译，不是执行 |
| iPhone + Watch Debug build 5 签名构建 | BUILD SUCCEEDED；`build-signed5.log` |
| 手机、嵌入 Watch、独立 Watch `codesign --verify --deep --strict` | 三个 bundle 全部通过；CFBundleVersion=5 |
| `git diff --check`、`bash -n scripts/ios-smoke.sh` | 通过 |

SwiftPM直接复制并逐字比对本次真实 `AuthModels.swift`、`AuthSessionRefreshCoordinator.swift` 和12项测试。为独立编译AuthModels中无关的deleteAccount默认端口，仅提供未调用的APIClientError编译替身；没有模拟或运行完整AppStore/APIClient/Keychain。原生完整集成测试（含两个真实APIClient共享刷新、暂不可读Keychain恢复）本轮只编译通过。

后端“两小时/30天”是注入时钟的确定性验证，没有等待真实两小时或30天，也未修改Mac/设备系统时钟。线上只读元数据确认为固定30天，未读取/输出原始令牌、refresh凭据、Apple授权码或精确位置。

## 当前未完成与下一步

- 9月26日晚构建结束时USB未连接；9月27日用户授权实机测试后，已通过普通USB覆盖安装build 5，见下节。安装不代表登录恢复已验收。
- 下一步：验证旧凭据无重新Apple登录地迁移、退出进程后恢复、跨15分钟访问令牌自动轮换。真实长时间闲置仍需分别记录。
- 未触发Fall Detection/SOS/救助事件，没有服务器部署、数据库结构改动、自动提交或推送。
- 本次没有新增服务端刷新幂等重试协议。如果服务端已轮换，但网络响应未到达或进程在保存前被终止，旧refresh仍可能按既有重放策略被拒；本机共享协调器解决的是已收到结果后的并发、丢回调与暂时保存故障，不应声称覆盖任意断电/网络丢包窗口。

## 2026-09-27 实机安装与恢复验证（过期恢复、进程重启均通过）

- 用户明确允许实机测试。USB配对验证成功，iPhone系统报告27.2，安装前App build=4；没有启用DDI/镜像/Simulator。
- 00:09普通USB安装完成，installer报告100%及Complete；随即查询本机安装CFBundleVersion=5。未卸载或清理任何应用数据/钥匙串。
- 00:10:12–00:10:13 appconduitd确认Watch实际 `Finished install`、`installed` 和 `acknowledged`。00:09:39只是前面的占位符阶段，不以它作为手表实装证据。
- 安装前只读服务器基线（UTC 2026-09-26 16:09:10）：access issuedAt=14:54:13.162Z、expiresAt=15:09:13.162Z，已过期约一小时；该登录族始于12:09:31.685Z，refresh到期仍为2026-10-26 12:09:31.685Z，未撤销。共有4个历史事件、0个ACTIVE。
- 用户直接打开更新后的App后明确反馈“已经进入主页面了”，没有进行新的Apple登录操作。
- 手机进程18666在00:13:20启动前台，00:13:22请求HTTP200、00:13:23 bootstrap HTTP201。只读服务器00:13:57复核：账号access issuedAt=16:13:22.603Z、expiresAt=16:28:22.603Z；登录族起点仍12:09:31.685Z，refresh期限仍2026-10-26 12:09:31.685Z，未撤销，4个历史事件/0 ACTIVE不变。**旧access已过期约一小时仍自动恢复，且原30天期限不被重置，首轮通过。**这不是重新Apple登录或只看UI缓存。
- 同次启动的Watch持久队列ping先因手机尚在恢复而暂时unavailable，00:13:24开始status=ok，00:13:25记录后台回复OS传输成功；这是附带通信证据，不替代Watch长时双后台/独立直传验收。
- 第二轮用户按要求从多任务上划关闭App（不是退出账号），5秒后重新打开，明确确认仍直接进入主页面。新进程18675在00:14:32启动，随后刷新HTTP200、bootstrap201；与首轮PID18666不同，确认不是只切回原进程。
- 00:15:13服务器复核：新的access issuedAt=16:14:32.919Z、expiresAt=16:29:32.919Z，登录族起点及2026-10-26 12:09:31.685Z的refresh截止仍相同，无撤销，事件4条/0 ACTIVE保持。**首次刷新后的凭据跨进程恢复并继续成功轮换，第二轮通过。**若重用首次刷新前的旧refresh，现有服务端会拒绝并撤销该族；本次没有发生该结果。
- 本轮通过范围为：旧access实际过期约一小时后的升级/启动自动恢复，以及build 5进程关闭后的再次恢复。尚未单独执行build 5连续闲置两小时、运行跨下一次15分钟短期令牌轮换、30天真实长测或任意网络丢包/断电窗口。
- 本轮日志目录 `/tmp/aed-login-device-20260927.LRtKWJ`：`install-build5.log`、`device-login.log`。日志是普通USB目标App/安装进程采集，20分钟自动结束；不采集凭据正文或导出Keychain。
- 两轮核查完成后已主动停止本轮临时USB日志进程，未保留后台采集任务。没有服务器写操作、镜像/DDI、Simulator、账号退出/注销或救助事件操作。
