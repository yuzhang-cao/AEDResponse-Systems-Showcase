# 已废弃提案：客户端零登录与自动测试会话

状态：已于 2026-09-05 被新身份规则取代，仅保留为历史记录，不得用于开发或验收。

替代规则：生产 App 必须先登录，只允许手机号验证码或 Sign in with Apple；稳定 `userId`、四项同意、设备会话和 Watch companion-link 以 `docs/requirements.md` 与 `contracts/openapi.yaml` 为准。

## 用户需求

患者和响应者打开 APP 后可直接使用，不显示账号、密码、注册或登录页面。

“无需用户登录”不等于所有业务 API 完全匿名开放。建议由客户端自动申请短期、限权的测试会话，继续隔离 Socket.IO 房间和可见事件。

## 建议的 v2 变更

该变更与 `openapi.yaml` v1 的 `/auth/login` 不兼容，合并时应把 `info.version` 提升到 `2.0.0` 并提供迁移说明。

```yaml
/session/bootstrap:
  post:
    security: []
    summary: Create a short-lived test-only app session without user login
    responses:
      '201':
        description: Temporary scoped test session
        content:
          application/json:
            schema:
              type: object
              required: [sessionToken, expiresAt]
              properties:
                sessionToken: { type: string }
                expiresAt: { type: string, format: date-time }
```

其余业务端点继续使用 bearer token；客户端不保存账号或密码，也不把 token 写入 UserDefaults、Keychain、日志或仓库。

## 服务端安全约束

- bootstrap token 必须短期有效、可撤销且仅限测试环境。
- 会话只允许访问预置测试数据，不得创建公众账号或接入真实急救调度。
- 需要速率限制、审计记录和房间隔离。
- 不接受客户端自报管理员或任意患者/响应者身份。
- token 到期后客户端静默重新 bootstrap；不得弹出登录页。

## iOS 迁移

- 设置页只保留 API 地址和连接状态。
- `LiveSession` 自动调用 `bootstrapSession()`，取得临时 token 后连接 Socket.IO。
- APP 默认进入完全离线 Demo，因此首次打开立即可操作；Live 联调需要用户明确填写测试服务地址。

## 兼容性

- v1 服务端尚未实现 `/session/bootstrap` 时，Live 联调会明确失败，但离线 Demo 不受影响。
- 不允许在 iOS 端硬编码 v1 测试账号密码作为兼容方案。
- Android 和服务端采用 v2 后，再正式替换共享 `contracts/openapi.yaml` 与 `contracts/events.md` 中的登录表述。
