# Apple 登录与设备身份重启测试（2026-09-10）

## 范围

用户授权测试。使用已登录 Apple 账号的17 Pro和现有Azure联调后端；不创建救援、通知或模拟事件，不注销账号、不删除App数据。服务器仅只读查询账户/设备/会话，输出计数、时间和身份组合摘要，不导出令牌或用户身份。

## 实际结果

- 本地命令（backend目录）：`node --import tsx --test test/apple-auth.test.ts test/auth.test.ts`，27 passed / 0 failed；日志 `/tmp/aed-login-regression.log`。合成签名测试不是第二次真实Apple系统授权。
- 设备命令：`xcrun devicectl device process launch --terminate-existing --device REDACTED-ID-0050 dev.codex.aedresponse.testhost`，成功重启实际联网App。
- 重启前后端读数：Apple账号1、iPhone设备1、无活动事件；最后通信23:43:48，最近会话签发23:39:37。
- 23:45:06重启；23:45:09产生新会话；23:45:11继续通信。重启后Apple账号1、设备1，device/user/pair组合摘要与重启前一致，未产生重复设备或账号。
- 这证明本次已登录账号的真实进程重启恢复和后台绑定继续有效；不等于完整救援、Watch配对、系统后台长期运行或退出再登录验收。

## 剩余

- 手动登出再Apple登录、切回旧账号及旧历史补传未执行。
- Watch新配对、失网/蜂窝切换、真实位置有效性未执行。
- 本次没有修改源码或服务器配置，无需数据回退。仅重启App并产生正常会话/状态更新。
