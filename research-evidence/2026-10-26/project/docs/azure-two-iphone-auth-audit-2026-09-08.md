# Azure 双机连接与 Apple/Watch 身份链路核对

日期：2026-09-08。用户授权 iPhone 17 Pro 通过 Wi-Fi、iPhone 16 通过 USB 进行测试；
短信服务暂不接入；本轮检查 Apple 登录是否符合要求，并说明 Watch 验证器的接入。

## 当前实测状态

| 项目 | 当前证据 | 结论 |
| --- | --- | --- |
| iPhone 17 Pro 开发连接 | CoreDevice `transportType=localNetwork`、tunnel connected、Developer Mode enabled | Wi-Fi 连接成功 |
| iPhone 16 开发连接 | CoreDevice `transportType=wired`、tunnel connected、Developer Mode enabled | USB 连接成功；用户解锁后 passcodeRequired=false |
| Azure 入口 | 本机实际 HTTPS `/healthz` 返回 200/status=ok | 公网入口正常 |
| 完整生产 App 签名 | Xcode 明确拒绝 Personal Team 的 Sign In with Apple 与 Fall Detection Notifications | 当前团队无法按现有能力构建安装生产 App |
| 独立真机诊断包签名 | XCTest 框架 CodeSign 返回 `errSecInternalComponent`；更详细日志为 `CSSMERR_CSP_OPERATION_AUTH_DENIED` | 私钥签名操作被系统拒绝，尚未解决 |
| 新增诊断测试编译 | `build-for-testing CODE_SIGNING_ALLOWED=NO` 成功 | 5 项诊断用例已编译，尚未安装/运行 |

这里的 Wi-Fi/USB 是 Mac 与手机的开发管理链路，不等于 App 到 Azure 的实际业务
链路。新增诊断用例会从真机记录 NWPath 类型，只有执行后才能判断当次是 Wi-Fi
还是蜂窝出网。目前没有双机前后端业务通过证据。

诊断入口为 `ios/AEDResponseTests/LiveAzureTransportTests.swift`，必须显式设置
`AED_LIVE_TEST_ORIGIN` 才会联网，默认整组跳过。它检查原始 ServerConnectionProbe、
APIClient 对 Apple 503 的处理、受保护 REST 的 401、16 KiB 边界，以及原生
URLSession WSS/Engine.IO 握手后的认证拒绝。不会发送短信、创建假账号、上传位置，
不会把 TestHost 的 fake identity 注入线上服务。

## Apple 登录是否符合要求

结论：**目前不符合完整真实登录要求**。已有部分客户端与会话基础，但缺少上线
配置和核心服务端验证，不能把现有按钮、entitlement 文件或 stub 测试视为可用登录。

| 检查点 | 状态与源码 |
| --- | --- |
| 原生登录按钮 | `AuthView.swift:140` 使用 SignInWithAppleButton |
| 随机 nonce | `AuthView.swift:206` 用 SecRandomCopyBytes 生成 raw nonce，对 Apple 请求传 SHA256(rawNonce) |
| 严格后端请求 | `APIClient.swift:248` 向后端传 identityToken、原始 nonce、可选 authorizationCode；没有上传客户端自称的 Apple subject |
| 会话保存 | `AuthSessionStore.swift:6` 使用设备 Keychain，AfterFirstUnlockThisDeviceOnly |
| 生产服务地址 | `ios/project.yml:33` / `AEDResponse/Info.plist` 仍为空；Azure 部署没有自动改此客户端配置 |
| 真实服务器验签 | `backend/src/main.ts:5` 没有注入 AppleIdentityTokenVerifier；`service.ts:1058` 因无 provider 返回 503 |
| 防重放 | 当前没有 Apple 登录一次性 challenge/消费记录，只有向预留 verifier 传递 nonce；必须在真实 verifier 与事务流程中补齐 |
| provider 故障分类 | `service.ts:1081` 将 verifier 的所有异常转成 401，接入时需保留签名/nonce 无效 401 与 Apple 密钥源故障 503 的区别 |
| Apple 账号/能力 | 实际签名使用的 Personal Team 不支持 Sign In with Apple；需具备该能力的 Apple Developer Program 团队及匹配 provisioning profile |

Apple 要求后端验证 token 签名、issuer、audience、过期时间与 nonce，并将登录请求
和 nonce 绑定以抵御重放。见 [Verifying a user](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)
与 [Authenticating users](https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple)。

与本项目对接时，verifier 需要：

1. 从 Apple 的 [JWKS](https://appleid.apple.com/auth/keys) 获取并缓存公钥，按 kid 选取
   允许的签名算法进行校验；当前实测 JWKS 为 RSA/RS256，不接受客户端指定的任意
   密钥来源或 `alg=none`。Apple client_secret 的签名与 identity token 的验签是不同步骤。
2. 限定 `iss=https://appleid.apple.com`，`aud` 为真实 iPhone App 的 client_id/Bundle ID，
   校验 exp 及必要时间字段。
3. 用 `SHA256(rawNonce)` 比较 token 中的 nonce，并事务化消费一次性登录请求；仅对
   客户端 rawNonce 做字符串比较或仅解码 JWT 都不够。
4. 验证成功才将 Apple sub 交给已有 provider-scoped HMAC/stable userId 流程。
5. 如采用 authorizationCode 换取 Apple refresh token、撤销/状态校验流程，再配置
   Team ID、Key ID、相应 `.p8` 私钥以生成 client_secret。公钥验签本身不需要 `.p8`。

本轮只审核这些差距，没有修改真实认证规则或开发短信 adapter。

## Watch 验证器怎么接入

已有 Watch 客户端 `DeviceCheckAppAttestAdapter` 调用 `DCAppAttestService`，
`WatchAPIReporter.redeemCompanionLink` 将 attestationObject、keyId 和一次性 link
ticket 发送到 `/api/v2/watch/session/redeem`。后端接口 `WatchAttestationVerifier`
已经存在，但 main.ts 未注入任何真实实现。

接入顺序：

1. 为实际 Watch App ID 开通 App Attest 并更新 profile。App ID prefix 通常为 Team ID，
   但应以实际注册标识和签名 profile 的 application-identifier 为准。Debug 使用
   development，发布使用 production；服务端也必须明确区分，不能同时盲目信任。
   在真实 Watch 上检查 `isSupported`。Apple 说明 watchOS 9 及以上的 Watch 扩展受支持，
   但具体设备能力仍须查询。[Apple isSupported 文档](https://developer.apple.com/documentation/devicecheck/dcappattestservice/issupported)
2. 保留当前认证 iPhone 生成的 5 分钟一次性 ticket 和账号/设备/pair 绑定。服务端按
   当前 `companionLinkClientDataHash` 构造预期 hash；客户端和服务端的复合 challenge
   序列化必须逐字节一致。
3. 实现真实 verifier：解析 `apple-appattest` CBOR、验证 x5c 链到 Apple App Attest
   根证书、校验 `SHA256(authData || clientDataHash)` 与证书 nonce 扩展一致、RP ID
   hash、credentialId/keyId、初始 counter=0、aaguid 环境；按 Apple 当前规范处理
   相应平台的额外校验。使用传入的 expectedClientDataHash 的解码字节，不重复哈希它。
4. 持久化验证后的公钥、keyId、环境、用户/设备绑定和 receipt，防止同一 key 跨用户
   重绑。当前接口只返回 verified/deviceInstanceId，尚无公钥与 counter 存储，需要
   增加持久化支持；后续若用 assertion 保护关键请求，还需唯一 challenge、签名验证
   和递增 counter 检查。
5. 在启动入口通过现有 `createBackend({ config, watchAttestationVerifier })` 注入。
   无效证明拒绝认证，临时服务故障与无效证明区分处理。仅填写环境变量
   `AED_WATCH_APP_ATTEST_APP_ID` 不会自动获得 verifier。

算法与存储要求依据 [Apple 服务端 App Attest 验证文档](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)。
Fall Detection Notifications 是另一项独立且须获批的能力；完成 App Attest 不代表
拥有跌倒检测授权，也不证明 Emergency SOS 可观测性。

## 证据与后续

- 设备连接 JSON：`/tmp/aed-iphone17pro-details-20260908.json`、`/tmp/aed-iphone16-details-20260908.json`。
- 生产签名失败：`/tmp/aedresponse-azure-production-signing-20260908.log`。
- 诊断包签名失败：`/tmp/aedresponse-azure-physical-build-20260908.log`。
- 未签名编译成功：`/tmp/aedresponse-azure-physical-compile-20260908.log`。
- DerivedData：`/tmp/aedresponse-azure-physical-20260908`。

### 签名原因更正（同日 Xcode 实查）

此前将 `errSecInternalComponent` 直接归因为“登录钥匙串锁住”不成立。
Security API 实测 `SecKeychainGetStatus` 成功，flags=7，unlocked=true。
`SecIdentityCopyPrivateKey` 也成功返回现有身份的私钥引用（未导出私钥）。
Xcode → Settings → Apple Accounts → Personal Team → Manage Certificates 确实显示
现有 Apple Development 证书，Status 栏没有缺少私钥/失效提示。

强制 dry-run 签名仍失败；对应 codesign/securityd 日志为
`CSSMERR_CSP_OPERATION_AUTH_DENIED`，并显示 `SecKeyCreateSignature` 的授权失败。
这证明签名操作被拒绝，但还不足以区分具体私钥 ACL 与钥匙串完整性原因。
不能因此继续要求用户解锁已解锁的钥匙串或重建证书。

Xcode production target 的 Team UI 当前为 None；命令行已使用
`DEVELOPMENT_TEAM=[TEAM]`，因此 UI 的 None 不是此前命令行私钥操作失败的解释。
Personal Team 不支持 Sign In with Apple/Fall Detection Notifications 的能力限制则
有独立构建日志证据。没有修改、导出、删除或重建开发证书，没有放宽私钥访问控制。

恢复时先定位并解决实际签名授权错误，再用同一 DerivedData 完成签名。为生成的
`.xctestrun` 的 `AEDResponseTests.EnvironmentVariables` 增加
`AED_LIVE_TEST_ORIGIN=https://redacted-host.invalid`，只运行
`AEDResponseTests/LiveAzureTransportTests`，分别指定两台真实 UDID 并保存 xcresult。
不得用当前未签名 build-for-testing 结果宣告真机测试成功。

