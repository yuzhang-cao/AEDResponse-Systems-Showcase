# 已确认：原生锁屏通知

2026-09-27 用户确认“按这版实现”。采用系统 UserNotifications / APNs，不制作自定义全屏警报，不引入 ActivityKit，也不在锁屏提供结束救助按钮。

![确认稿](approved-native-notifications.png)

正式视觉稿不显示“模拟测试”等预览标签。真实的受控测试事件仍带 `SIMULATED_TEST`，通知保留“模拟测试”副标题；不得用无标记测试冒充正式救助。

关键语义：

- 已收到手表求助：只代表接收，尚未获得服务器业务确认。
- 救助已发起：仅在匹配服务器 ACK 或授权 REST 事件投影后显示。
- 已有响应者接单：来自服务端业务进展，而非客户端推测。
- 点击通知：解锁后通过当前账号 REST 回读，不直接接受、取消、结束事件。

实际字体、卡片尺寸、显示位置由 iOS 决定。图片是设计稿，不是真机截图。通知不包含身份、精确位置、地址或 AED 路线。

## 2026-10-04 状态文案修正

上方旧确认稿只保留为视觉参考，其中“解锁查看”不再是实现文案。App处于后台不代表手机锁屏，同一条通知也可能在已解锁手机的横幅、通知中心或Watch上展示。

- 本地通知与APNs统一采用“轻点查看…”或实际业务状态，不假设手机是否锁定。
- AEDResponse处于active时，沿用页面状态更新与`willPresent`抑制系统横幅；inactive/background仍允许系统提醒，不依据它们猜测锁屏。
- 继续区分“已收到求助”和“救助已发起”，保持去重、模拟标记和授权REST回读；不因解锁/点击通知直接接受或结束救助。
- 不在进入前台时清空所有旧通知：前台不代表已经查看某个事件，已投递的历史通知也不会因新版本文案自动重写。本次没有新增已读清理行为。

依据：[Apple applicationState](https://developer.apple.com/documentation/uikit/uiapplication/applicationstate)、[前台通知展示处理](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:willpresent:withcompletionhandler:))。

## 生成记录

使用内置 imagegen，非 CLI。原稿：`exec-REDACTED-ID-0013.png`；确认稿：`exec-REDACTED-ID-0014.png`。确认稿已复制进本目录，App 本身不把位图当成通知 UI。

最终编辑提示词：

> Use case: text-localization. Image 1 is the exact edit target. Preserve the three-phone layout, wallpaper, native notification structure, Chinese titles and bodies, app name, icon, sizes, alignment and style. Change only text for the final production product presentation: remove every instance of "模拟测试" and the adjacent separator from all three notification cards. Keep the system label "时效性通知" on the first two cards; remove this label from the third card so a routine progress update is not advertised as interruptive. Change the top board heading from "锁屏提醒 · 设计预览" to exactly "AEDResponse · 锁屏提醒". Replace the arbitrary date "4月12日 星期六" on all three phones with exactly "9月27日 星期日". No "测试", "模拟", "预览", "demo" or "prototype" text anywhere in the output. Do not add buttons, new claims or new UI. This is a production-style visual concept, not evidence of a real device test. All original body text remains unchanged.
