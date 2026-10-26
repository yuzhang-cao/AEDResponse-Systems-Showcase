# 用户端真机验证与后台提醒提示修正（2026-09-19）

## 已确认
- iPhone 17 Pro 连接可用，正式 target `dev.codex.aedresponse` 完整开发签名构建、安装、启动成功；未覆盖 `dev.codex.aedresponse.testhost` 受控测试槽位。
- 签名/embedded profile 包含 development APNs entitlement；`codesign --verify --deep --strict` 通过。
- 真机 UI 可访问性树显示 Apple 账号已登录。再次启动后无需交互登录即可进入业务门禁后的推送申请阶段，证明本次会话恢复成功。
- 真机日志连续出现 `phase=token-received`，说明当前 APNs 设备凭据已取得；紧接着出现 `phase=server-registration-failed httpStatus=404`。只保存阶段和 HTTP 状态，未记录凭据。
- 线上 `/healthz` HTTP 200。无凭据 POST `/api/v2/me/push-token` 与 GET `/api/v2/me/nearby-volunteers` 均 HTTP 401；全局鉴权使该匿名探测不能判断登记路由是否存在。
- 真机界面树出现 `live-nearby-map`、当前位置、回到当前位置控件，屏幕采样中出现实际地图瓦片。采样恰逢应用切换动画，不将它当作完整静态页面视觉验收，也不保存包含其他 App 的截图到仓库。

## 用户反馈对应的阶段
用户确认旧提示为“远程通知注册未完成，将在回到前台时重试”。该旧提示来自 iOS/APNs 回调或 profile 环境解析分支，不来自账号注册，也不同于上传服务器失败的文案。旧版丢弃系统错误原因，故原始失败原因未能回溯。本次诊断重启后该阶段成功，不能倒推原始失败是服务器 404。

## 修正
- `AppStore.backgroundReminderIssue` 单独承载后台提醒状态，不再反复占用全局操作失败弹窗。
- 设置页在通知权限下面显示普通用户可理解的异常说明；保留自动重试。
- 仅服务器登记成功，或 APNs 再次返回已被当前服务器会话确认的同一凭据，才清除异常；同一凭据不重复上传。退出时清除该账户的提示。
- RemoteNotificationService/PushRegistrationCoordinator 仅在 Debug 且显式 `AED_PUSH_DIAGNOSTICS=1` 时记录阶段、系统 domain/code、HTTP 状态；不输出 token、响应正文、账号或设备 ID。
- 只读真机 UI 测试增加明确白名单 bundle 参数，避免误操作受控测试 App。

## 验证与证据
- 7 项定向测试通过：`/tmp/aed-push-recovery-tests-20260919.xcresult`，覆盖失败不影响登录、恢复清除提示、同 token 不重复上传、轮换串行、退出隔离、通知仅 REST 对账。
- 最终签名构建：`/tmp/aed-push-final-device-build.log`（BUILD SUCCEEDED）。已安装并启动到 17 Pro。
- 真机只读截图/界面树用例成功：`/tmp/aed-ui-device-final-readback-20260919.xcresult`。它不点击协议、Apple 授权、接受救助或结束救助。
- 原始控制台：`/tmp/aed-push-final-device-console.log`；脱敏阶段记录见 push-stages.log。

## 未关闭项
- 服务器推送登记的 404 仍未修复；本地实现存在对应路由，但尚未核实线上实际部署版本，不能把“线上未部署路由”写成已确认根因。
- 未验证真实 APNs 消息送达、取 AED 实际步行导航或 Watch 联动。
- 未部署服务器、变更数据库、创建救助事件、触发真实跌倒/SOS、提交或推送代码。

下一步：只读核对线上 `/api/v2/me/push-token` 路由及版本，再单独评审部署范围。保持既有登录、设备绑定和救助记录，不用退出/清空数据来绕过错误。
