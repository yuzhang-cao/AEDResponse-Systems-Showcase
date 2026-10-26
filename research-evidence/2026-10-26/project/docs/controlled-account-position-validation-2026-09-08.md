# 受控账号与正式位置链路验收

## 用户批准的例外

2026-09-08 用户确认：仅用受控测试账号建立会话，后续位置采集、蜂窝上传、
会话鉴权、设备绑定、权限门禁和数据库记录执行既有正式业务规则。不另建位置
回显入口，不使用隔离业务库，不删除当前测试数据。真实 Apple/SMS 登录及
Personal Team 不支持的 Apple/Watch 能力继续暂停。

这不等于上架认证或完整产品验收。受控身份明确标记 `CONTROLLED_TEST`，不伪装
为手机号或 Apple 账号；正式可用登录方式仍只有 PHONE/APPLE。

## 实现边界

- 后端开关 `AED_ENABLE_CONTROLLED_TEST_ACCOUNTS` 默认 false。只允许 VM 本地
  管理脚本创建受控身份，没有公开的测试注册、匿名上传或固定验证码接口。
- 创建账号使用正常 HMAC 身份索引、账号会话和单次轮换刷新令牌。账号会话
  仅有 `session:bootstrap`；业务写入仍需四份协议、设备绑定及正常设备会话。
- 关闭开关并重启即拒绝受控账号/设备 bearer 与刷新请求；重发同一测试账号
  凭据会撤销其旧会话，但不会删除其用户、位置或事件证据。
- `AEDResponseControlledTests` Debug scheme 复用手机正式源代码、Core Location、
  APIClient 和 Azure `/api/v2/`。唯一替换为首次账号会话导入；不包含离线
  TestHost 编译标记、假场景资源或模拟位置。
- ControlledTests 使用现有 `dev.codex.aedresponse.testhost` 安装位，因此安装后
  会替换手机上旧离线 Tests 程序，不卸载或主动清空其容器。生产目标及其 Apple/
  Watch entitlement 不变。受控手机包不嵌入 Watch，不代表 Watch 已验证。
- 凭据只能经受控管理传输进入 Documents/controlled-session.json；客户端验证
  HTTPS issuer、身份类型、有效期及内容大小，写入 Keychain 成功后删除这一份
  一次性凭据文件，不删除业务数据。令牌不写入源代码、日志、URL 或 App 资源。
- 普通生产/离线 TestHost 构建拒绝恢复 CONTROLLED_TEST 会话。导入功能仅在
  `AED_CONTROLLED_TEST && DEBUG` 编译条件下存在。

## 服务器操作约束

同一 SQLiteStateStore 不能由两个独立进程并发写入。操作顺序必须为：

1. 在候选目录执行完整 check/test/build，核对既有线上源文件无额外改动。
2. 备份数据库及旧代码，保留原环境 pepper/数据库路径和 HTTPS 配置。
3. 安装新代码及受控账号 opt-in drop-in，停止业务服务后才能运行
   `backend/deploy/azure/provision-controlled-account.mjs`。
4. 脚本以服务账号运行并读取现有环境；账号 key、HTTPS origin、0600 输出文件
   为显式参数，输出文件必须不存在。只打印非敏感身份摘要，不输出凭据。
5. 重启正常服务，检查健康、匿名拒绝及数据库完整性，再安装/导入实机凭据。

不修改 SQLite 表结构，但存储模型新增 provider 值；旧代码不识别此值。不能在
写入受控账号后直接回滚到旧解析器，也不能用恢复旧备份的方式丢掉之后的位置
或事件证据。测试期结束优先关闭开关，保留数据，由用户决定上线前清理。

## 验收证据分级

首次实机检查为中立待命 R：在手机取得真实定位后，经正常位置接口写入
`devices.latestPosition`，核对位置观察时间、更新 ID、服务端 ACK 和持久化结果。
中立待命按既定规则只保留最新位置、10 分钟失效，不是每秒事件轨迹。

P 与事件参与者的逐秒留存/5 秒批量上传，必须有真实合法事件和参与身份后再测；
本次不伪造 Watch Fall/SOS、不以合成坐标或原生 echo 诊断替代。

蜂窝验收还需实机确认业务使用移动数据；Mac/USB/Wi-Fi 调试连接本身不构成
蜂窝业务证据。Tailscale 仅用于服务器管理，不能承载业务数据。

## 本轮实际结果（13:16 CST 后）

- 本机及 Azure 均为完整 **114/114** 后端测试通过，check/build 通过；其中
  纯业务 76/76。新增 HTTP 用例实测正常刷新、四份协议门禁、设备绑定、匿名/
  账号级越权拒绝、非法坐标拒绝、位置写入和幂等 ACK。均为自动化合成数据，
  不冒充手机定位。Azure 测试使用临时库，不向业务库伪造患者/位置。
- ControlledTests generic iOS 编译、普通 Tests/UITests build-for-testing、
  生产 Release 编译通过，全部 `CODE_SIGNING_ALLOWED=NO`。新增普通构建拒绝
  受控身份的 XCTest 已编译但未运行；没有使用 Simulator。生产二进制没有
  ControlledTestAuthSessionStore 符号。
- 13:16 CST 新代码已切换到 `/opt/aedresponse/current`；5 个后端改动源文件
  SHA-256 与本机一致。旧代码位于
  `/opt/aedresponse/releases/before-controlled-20260908-1315`；SQLite 一致性
  备份 `/var/lib/aedresponse/backups/before-controlled-20260908-1315.sqlite`
  及当前库 integrity_check 均为 ok。未更改原环境文件、HTTPS、证书或数据库表。
- 公网 HTTPS health 200、匿名 REST 401、JSON 边界、WSS 匿名拒绝通过。
  **受控开关仍为 false，没有签发线上账号/会话**；业务库仍只有原来 2 个 AED。
  等手机安装恢复后再启用和签发，避免导入短期 access token 已过期。
- 实机尚未通过：普通 Tests 签名仍报 `errSecInternalComponent`，此前详细
  诊断为私钥签名操作授权失败（不等于账号无效，也不等于钥匙串锁住）。
  后续 GUI 检查遇到 Mac 锁屏，13:15 左右 iPhone 17 Pro 也为 unavailable。
  已请用户解锁 Mac，需恢复手机连接才能继续。
- 未安装新 App、未上传真实位置、未改变钥匙串/证书/Apple 或 Watch 特殊权限。

证据：`/tmp/aedresponse-controlled-{business,full,build,testcompile,release,public,signing}-20260908.log`；
远端完整测试 `/home/REDACTED/aedresponse-controlled-test-20260908-1315.log`，
本机副本 `backend/logs/azure-20260908/controlled-backend-tests.log`。
