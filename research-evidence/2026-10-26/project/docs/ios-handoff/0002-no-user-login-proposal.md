# 已废弃决策记录：客户端零登录与匿名设备会话

状态：已于 2026-09-05 被新身份规则取代，仅保留为历史记录，不得用于开发或验收。

替代规则：生产 App 必须先登录，只允许手机号验证码或 Sign in with Apple；稳定 `userId`、四项同意、设备会话和 Watch companion-link 以 `docs/requirements.md` 与 `contracts/openapi.yaml` 为准。

## 决策

患者和志愿响应者不创建账号，App 不显示账号、密码、注册或登录页面。客户端通过 `POST /api/v2/session/bootstrap` 自动取得匿名、短期、限权、可撤销和可轮换的设备会话。

iPhone bootstrap 携带两份独立协议接受记录；Watch 使用与配对 iPhone 建立的限权 `companionPairId`。服务端根据设备会话和服务端状态决定可见事件与权限，客户端不得自报管理员、患者或响应者身份。

bearer token 只保存在进程内，不写入 UserDefaults、Keychain、日志或仓库。token 临近到期或业务请求首次返回 `401` 时静默重新 bootstrap；同一请求最多自动轮换并重试一次，不弹出登录页。

## 安全约束

- bootstrap 必须限速、可审计并最小化 scope。
- 设备标识只能是可轮换的 app-scoped 随机标识，不是用户身份。
- 服务端必须隔离 Socket.IO 房间和 REST 可见范围。
- 不得为兼容 v1 恢复 `/auth/login`、硬编码测试账号或持久化凭据。
- 匿名会话不改变项目不接真实急救调度、不提供医学诊断的边界。

具体字段与响应以 `contracts/openapi.yaml` 为准；本文件不再是待合并提案。
