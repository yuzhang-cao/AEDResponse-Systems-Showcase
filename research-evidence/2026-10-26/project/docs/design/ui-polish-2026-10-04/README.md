# iPhone UI 优化 · 2026-10-04

## 范围与设计约定

用户要求改善现有 App UI，并明确允许使用完全离线 iOS Simulator 检查界面。本轮只调整原生 SwiftUI 视图，保留已确认的登录与启动动画。

- 主屏：行动待命、响应邀请、AED 导航、设置；共享样式同步到患者页。
- 浅色页面底 #F4F6F7、白色内容区、深绿主操作 #087F5B、系统语义正文色。深色使用动态颜色；红色仅用于紧急或破坏性操作。
- 页面边距 20 pt、组间距 20 pt、内容内边距 16 pt、卡片圆角 18 pt、按钮至少 52 pt 高。
- 系统字体，页面标题 32 pt 动态缩放，卡片 headline，辅助 subheadline/caption；SF Symbols 统一尺寸与字重。
- 首页保留行动标题、真实连接状态、附近响应者、列表/地图切换、患者上报与二次确认、安全说明、行动/设置导航。
- 邀请保留事件类型、距离/预计用时/搜索范围、接受倒计时和接受/拒绝；不提前暴露具体患者位置。
- 导航保留任务进度、地图/目的地、分步主操作、Apple 地图、AED 不可用、协作团队和退出确认。
- 设置按账号与设备、权限与显示、隐私与协议、账号操作分组；值来自原状态，长状态/大字体允许换行。
- 离线图必须保留“示例数据”“范围示意/测试路线”；真实地图仍使用现有 MapKit。测试第三个 tab 不进入生产版本。

## 不得改变的行为

不改 AppStore、后端、状态机、权限门禁、登录校验、统计过期逻辑或真实地图坐标处理；不合并“已到达 AED”与“确认已获取 AED”。保留所有现有 accessibilityIdentifier、业务提示与确认。已有未提交修改逐文件增量保留，不提交、推送、部署或安装真机。

## 验证

本轮完成。本地界面修改、编译与离线 UI 验证已完成，没有安装真机。

- iPhone + Watch Debug generic SDK 无签名构建成功（最后一轮日志 `/tmp/aed-ui-polish-device-final-20261004.log`）。
- 离线 TestHost 的 Simulator 构建成功。
- ApprovedUIScenarioTests 3/3；设置入口与附近地图/列表 UI 用例 2/2 通过。最后的四页/AED步骤用例 1/1 通过（分轮执行，不是一次全项目测试）。
- 最终综合用例：`/tmp/aed-ui-polish-layout-20261004.xcresult`。验证了待命、邀请、AED到达、获取后携带前往患者与设置。
- 复核了原生1206×2622截图，并抽查设置页深色与辅助功能大字号。邀请空导航栏、地图按钮换行及破坏性操作颜色已在最终截图中修正。
- 修改前基线与首轮综合用例曾失败。失败层级确认自动场景点击没有生效，旧helper只判断已有横幅而误认成功；现在等待真实tab选择并最多重试一次，没有放宽业务断言。按钮等待由3秒调为10秒，避免冷启动环境中的过短等待。
- `git diff --check` 通过。登录、启动动画、协议页源码与本轮前快照哈希一致。

运行时为强制离线 TestHost，界面里的“测试”tab、示例数据与测试路线不出现在生产目标。真实网络地图、后台救助与物理设备行为不属于此次验证。


## 预览与文件

- [待命首页](screenshots/home-light.png)
- [邀请页](screenshots/request-light.png)
- [AED任务](screenshots/navigation-light.png)
- [已获取AED](screenshots/aed-acquired.png)
- [设置](screenshots/settings-light.png)
- [深色与大字号设置](screenshots/settings-dark-accessibility.png)
- [视觉比较记录](visual-review.md)、[验证清单与哈希](verification.json)

主要修改为 `ios/AEDResponse/Views/` 下 RootView、ResponderDashboardView、NearbyVolunteersView、ResponderNavigationView、SettingsView、PatientDashboardView，以及既有 `ios/AEDResponseUITests/AEDResponseUITests.swift` 的场景等待与截图证据。
