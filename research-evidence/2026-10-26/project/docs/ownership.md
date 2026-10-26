# 目录、分支与平台所有权

## 当前 Windows 任务

- `android-app/`：独占写入；Android 客户端、原生能力和 Android 测试。
- `server/`、`shared/`、`contracts/`：主维护；平台中立后端、协议、数据模型和验收夹具。
- `admin-web/`：独占写入；简单管理后台。
- `docs/ios-handoff/`：输出给 Mac Codex 的只读工作包。

## Mac Codex

- `ios/` 或其独立 iOS 仓库/分支：独占写入；Swift/iOS 平台实现、签名、构建和测试。
- 不直接修改 `android-app/`。
- 若需改变 `contracts/`，先提交协议变更提案和兼容性说明，不能在并行工作时直接改同一共享文件。

## 分支建议

- Windows：`codex/android-server-mvp`
- Mac：`codex/ios-mvp`
- 契约变更通过单独提交或 PR 合并；协议版本不兼容时提升主版本。

当前任务不会创建或修改 `ios/` 目录。

