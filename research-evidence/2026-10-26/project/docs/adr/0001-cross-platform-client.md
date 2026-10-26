# ADR-0001：Android 原生客户端与平台中立契约

## 状态

已决定（2026-08-30）。

## 决定

- Windows 任务使用 Kotlin + Jetpack Compose 开发 Android 客户端。
- Node.js + TypeScript + SQLite 提供平台中立 REST/WebSocket 协议。
- iOS 由 MacBook Codex 独立开发；当前任务不创建或修改 `ios/`，不负责 iOS 适配、签名、构建或测试。

## 理由

1. 最新范围明确把 iOS 工程所有权交给 Mac Codex，当前任务无需为了共享 UI 代码强制采用 Flutter。
2. Android 的定位、本地声音/震动/闪屏、TTS、系统拨号器和前台实时连接用原生 API 风险最低。
3. 本机目前有 Node/SQLite，但没有 Android SDK/ADB/Flutter；Flutter 并不能减少当前环境补齐成本。
4. 平台中立契约可让 Swift/iOS 实现独立演进，同时保证状态机、位置类型和安全边界一致。

## Android 构建基线

- Kotlin：2.4.10（稳定修复版）
- Android Gradle Plugin：9.2.0
- Gradle：9.4.1
- Compose BOM：2026.08.00
- JDK：17（Android 官方兼容基线）

当前 Windows 的 Java 24、缺失 Android SDK 和无效 `JAVA_HOME` 不能用于宣称 Android 构建通过。未经用户批准不安装或修改系统工具链。


