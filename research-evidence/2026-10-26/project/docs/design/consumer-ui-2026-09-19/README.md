# 用户端 UI：2026-09-19

用户提供 AED1–AED4 图片并授权按图调整。采用原生 SwiftUI，图片仅为参考，不作为 UI 背景。

## 设计约定
- 白色背景；绿色主按钮（约 #109E40）；浅灰信息区域；16px 主要间距；14–18px 圆角。
- 系统字体，页面标题 largeTitle，卡片标题 headline，正文 body/subheadline，次要信息 caption。
- 待命页：绿色状态条、附近响应者、默认地图/列表切换、上报患者卡、安全说明、行动/设置底栏。
- 邀请页：心形图标、标题、距离/时间/搜索范围、动态倒计时、接受/暂不参与。
- 导航页：状态驱动步骤、地图、目的地说明、当前步骤主按钮、Apple 地图与不可用操作、团队与退出。
- 设置页：账户/Watch/权限，协议与同意记录，系统设置，退出与注销；技术诊断与坐标移出首页。

## 保持的行为与数据边界
- 无手动角色切换；上报确认、邀请接受/拒绝、AED 到达/获取分步、退出三次确认、注销确认维持原用例。
- 数量和范围来自服务器，不复制设计里的 500m/1km/3km 或示例人数。离线测试保持示例标识。
- Assignment 只含 AED 坐标，未含名称、楼层；显示 AED 取用点，不伪造图片中的医院地址。
- 实际地图使用 MapKit；离线 TestHost 仍使用无网络示意图。UI 验证应使用 iOS 模拟器而非浏览器。
- 模拟事件标识与权限失败提示保留，Watch/网络状态不可固定显示正常。

## 主要文件
RootView.swift、ResponderDashboardView.swift、NearbyVolunteersView.swift、ResponderNavigationView.swift、SettingsView.swift、AuthView.swift。

## 登录协议补充要求
- 用户追加要求：协议在登录前签署，采用常见复选框；不签署不能登录。
- AuthView 展示四项默认未选中的复选框，协议名称可打开全文；敏感个人信息独立勾选。
- 全部协议已加载且全部勾选后才准备 Apple challenge；按钮、授权配置和回调三处检查。
- 成功认证后复用 completeOnboarding 保存当前账户同意记录与请求权限，沿用现有同步流程。
- 本地不跨账号记忆登录前勾选；旧会话协议更新仍保留 Onboarding 复核入口，统一使用复选框。
- TestHost 的未登录入口和假 challenge 仅用于离线 UI 测试；生产目标保持真实认证和 Keychain。

## 有意差异
- iOS 26 系统 TabBar 为原生浮动外观，与参考图旧版系统底栏不同。
- 邀请页保留现有事件类型文字；任务响应人数收入可展开区域。
- 未连接 Watch/未授权定位通知显示实际状态；不照搬参考图中的已连接/已开启。
- 正式地图仍需在有实际定位和服务数据时验证；离线 TestHost 不加载地图网络瓦片。

## 验证结果
- 5 项 UI 用例全部通过：四页与 AED 分步操作、登录前协议、首次使用协议、设置页隐藏开发信息、附近地图/列表与角色切换。
- 截图复核后收紧标题留白与导航次要按钮；对应设置/附近场景通过，四页操作补跑通过。
- 之前相关 48 项单元测试与 iPhone/Watch 无签名 Release 编译通过；最终布局重新进行了模拟器编译和 UI 验证。
- 具体结果、证据路径、最终视图哈希见 verification.json；视觉差异见 visual-review.md。
- 未提交、未推送、未安装到物理设备。

## 当前截图
- [待命首页](screenshots/AED1-home.png)
- [响应邀请](screenshots/AED2-request.png)
- [AED 导航](screenshots/AED3-navigation.png)
- [设置](screenshots/AED4-settings.png)
- [登录前协议勾选](screenshots/login-consent-checked.png)
