import XCTest

@MainActor
final class AEDResponseUITests: XCTestCase {
    func testOptInLiveScreenEvidence() throws {
        guard ProcessInfo.processInfo.environment["AED_LIVE_SCREEN_EVIDENCE"] == "1" else {
            throw XCTSkip("Explicit connected-device evidence only")
        }
        let bundleID = ProcessInfo.processInfo.environment["AED_LIVE_APP_BUNDLE_ID"]
            ?? "dev.codex.aedresponse.testhost"
        guard ["dev.codex.aedresponse", "dev.codex.aedresponse.testhost"].contains(bundleID) else {
            XCTFail("Unsupported live evidence target")
            return
        }
        let app = XCUIApplication(bundleIdentifier: bundleID)
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let visibleActionTab = app.tabBars.buttons["行动"]
        if visibleActionTab.waitForExistence(timeout: 2), visibleActionTab.isHittable {
            visibleActionTab.tap()
        }
        attachScreenshot(app, named: "live-action-screen")
        if ProcessInfo.processInfo.environment["AED_WAIT_FOR_LIVE_REQUEST"] == "1" {
            let actionTab = app.tabBars.buttons["行动"]
            XCTAssertTrue(actionTab.waitForExistence(timeout: 5))
            actionTab.tap()
            print("AED_LIVE_OBSERVER_READY")
            let accept = app.buttons["accept-response-button"]
            let appeared = accept.waitForExistence(timeout: 90)
            attachScreenshot(app, named: appeared ? "live-request-arrived" : "live-request-timeout")
            let snapshot = XCTAttachment(string: app.debugDescription)
            snapshot.name = "live-request-hierarchy"
            snapshot.lifetime = .keepAlways
            add(snapshot)
            XCTAssertTrue(appeared, "No request button appeared during live observation")
            XCTAssertTrue(accept.isHittable, "Request button exists but cannot be tapped")
        }
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "live-accessibility-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    func testStandbyMapFillsActionPageAndShowsAggregateCounts() {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "neutral")
        let map = app.descendants(matching: .any)["offline-nearby-map"].firstMatch
        XCTAssertTrue(map.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["standby-action-panel"].exists)
        assertFullPageMap(app)
        assertNearbyCounts(app)
        XCTAssertTrue(app.descendants(matching: .any)["nearby-summary-note"].firstMatch.label.contains("示例数据"))
        XCTAssertFalse(app.descendants(matching: .any)["nearby-view-mode-picker"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["live-nearby-map"].exists)
        attachScreenshot(app, named: "map-first-standby")

        openLocalScenario(app, id: "patient")
        XCTAssertTrue(app.buttons["patient-resolve-button"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["standby-action-panel"].exists)
        XCTAssertFalse(app.buttons["report-found-patient-button"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["nearby-volunteers-card"].exists)
        openLocalScenario(app, id: "responderGoToPatient")
        XCTAssertTrue(app.buttons["advance-assignment-button"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["standby-action-panel"].exists)
        XCTAssertFalse(app.buttons["report-found-patient-button"].exists)
    }

    func testSettingsRangePreferenceOnlyHidesCirclesAndPreservesCounts() {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "neutral")
        assertNearbyCounts(app)

        app.tabBars.buttons["设置"].tap()
        let rangesToggle = app.switches["settings-nearby-range-circles-toggle"]
        XCTAssertTrue(rangesToggle.waitForExistence(timeout: 5))
        let initiallyEnabled = rangesToggle.value as? String == "1"
        for _ in 0..<4 where !rangesToggle.isHittable { app.swipeUp() }
        if initiallyEnabled { rangesToggle.tap() }
        XCTAssertEqual(rangesToggle.value as? String, "0")

        app.tabBars.buttons["行动"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["offline-nearby-map"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["offline-range-circles"].exists)
        assertNearbyCounts(app)
        XCTAssertTrue(app.descendants(matching: .any)["nearby-summary-note"].firstMatch.label.contains("示例数据"))
        XCTAssertFalse(app.descendants(matching: .any)["live-nearby-map"].exists)
        attachScreenshot(app, named: "map-first-circles-hidden-counts-preserved")

        app.tabBars.buttons["设置"].tap()
        XCTAssertTrue(rangesToggle.waitForExistence(timeout: 5))
        rangesToggle.tap()
        XCTAssertEqual(rangesToggle.value as? String, "1")
        app.tabBars.buttons["行动"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["offline-range-circles"].waitForExistence(timeout: 5))
        assertNearbyCounts(app)
        attachScreenshot(app, named: "map-first-circles-restored")

        if !initiallyEnabled {
            app.tabBars.buttons["设置"].tap()
            XCTAssertTrue(rangesToggle.waitForExistence(timeout: 5))
            rangesToggle.tap()
        }
    }

    func testSettingsRoundTripPreservesAedTaskProgress() {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "responderFetchAed")
        let advance = app.buttons["advance-assignment-button"]
        XCTAssertTrue(advance.waitForExistence(timeout: 3))
        tapPanelElement(app, element: advance)
        XCTAssertTrue(waitForButton(app, id: "advance-assignment-button", label: "已到达 AED"))

        for _ in 0..<2 {
            app.tabBars.buttons["设置"].tap()
            XCTAssertTrue(app.descendants(matching: .any)["settings-account-status"].waitForExistence(timeout: 3))
            app.tabBars.buttons["行动"].tap()
            XCTAssertTrue(waitForButton(app, id: "advance-assignment-button", label: "已到达 AED"))
            XCTAssertFalse(app.buttons["aed-acquired-button"].exists)
        }

        tapPanelElement(app, element: advance)
        XCTAssertTrue(app.buttons["aed-acquired-button"].waitForExistence(timeout: 3))
        app.tabBars.buttons["设置"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings-account-status"].waitForExistence(timeout: 3))
        app.tabBars.buttons["行动"].tap()
        XCTAssertTrue(app.buttons["aed-acquired-button"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["advance-assignment-button"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["test-route-canvas"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["live-route-map"].exists)
    }

    func testFirstUseRequiresFourSeparateAgreements() {
        let app = launchApp(arguments: ["-UITestForceOnboarding"])

        let patientAgreement = app.descendants(matching: .any)["patient-agreement-toggle"].firstMatch
        let responderAgreement = app.descendants(matching: .any)["responder-agreement-toggle"].firstMatch
        let privacyPolicy = app.descendants(matching: .any)["privacy-policy-toggle"].firstMatch
        let sensitivePersonalInformation = app.descendants(matching: .any)["sensitive-personal-information-toggle"].firstMatch
        XCTAssertTrue(patientAgreement.waitForExistence(timeout: 3))
        XCTAssertTrue(responderAgreement.waitForExistence(timeout: 3))
        XCTAssertTrue(privacyPolicy.waitForExistence(timeout: 3))
        XCTAssertTrue(sensitivePersonalInformation.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["complete-onboarding-button"].exists)

        patientAgreement.tap()
        responderAgreement.tap()
        privacyPolicy.tap()
        sensitivePersonalInformation.tap()
        app.buttons["签署并申请权限"].tap()

        XCTAssertTrue(app.descendants(matching: .any)["standby-action-panel"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.segmentedControls["role-picker"].exists)
        attachScreenshot(app, named: "onboarding-complete-neutral")
    }

    func testBackendPatientActivationShowsPatientControlsWithoutRolePicker() {
        let app = launchApp(arguments: ["-UITestPatientEvent"])

        XCTAssertTrue(app.staticTexts["救助进度"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["救助进行中"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["patient-event-card"].firstMatch.exists)
        XCTAssertTrue(app.buttons["confirm-false-alarm-button"].exists)
        XCTAssertTrue(app.buttons["patient-resolve-button"].exists)
        XCTAssertFalse(app.tabBars.buttons["时间线"].exists)
        XCTAssertFalse(app.segmentedControls["role-picker"].exists)
        XCTAssertFalse(app.buttons["manual-sos-button"].exists)
        XCTAssertFalse(app.buttons["wearable-mock-button"].exists)
        XCTAssertFalse(app.buttons["report-found-patient-button"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["standby-action-panel"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["action-map-canvas"].exists)
        attachScreenshot(app, named: "patient-activated")
    }

    func testNearbyFixtureShowsCurrentOfferAndAcceptsLocally() throws {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "responseRequest")

        let requestCard = app.descendants(matching: .any)["response-request-card"].firstMatch
        XCTAssertTrue(requestCard.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["跌倒救助"].exists)
        let accept = app.buttons["accept-response-button"]
        XCTAssertTrue(accept.exists)
        assertFullPageMap(app)
        XCTAssertFalse(app.staticTexts["安全测试地点 A"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["task-location-details"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["test-route-canvas"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["live-route-map"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["offline-range-circles"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["nearby-map-count-1000"].exists)
        XCTAssertFalse(app.buttons["report-found-patient-button"].exists)
        scrollPanelToReveal(app, element: accept)
        assertPrimaryActionFitsPanel(app, button: accept)
        attachScreenshot(app, named: "map-first-invitation-private-position")

        tapPanelElement(app, element: app.buttons["accept-response-button"])

        XCTAssertTrue(app.descendants(matching: .any)["responder-navigation-view"].waitForExistence(timeout: 3))
        attachScreenshot(app, named: "map-first-task-default")
        tapPanelElement(app, element: app.buttons["响应状态"])
        XCTAssertTrue(app.descendants(matching: .any)["response-status-card"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["advance-assignment-button"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["advance-assignment-button"].label, "开始前往")
        let advance = app.buttons["advance-assignment-button"]
        scrollPanelToReveal(app, element: advance)
        assertPrimaryActionFitsPanel(app, button: advance)
        assertFullPageMap(app)
        XCTAssertTrue(app.descendants(matching: .any)["test-route-canvas"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["live-route-map"].exists)
        attachScreenshot(app, named: "map-first-accepted-task")
    }

    func testLocalFetchAssignmentUsesRapRouteAndCompletesPatientHandoff() throws {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "responderFetchAed")

        let navigation = app.descendants(matching: .any)["responder-navigation-view"].firstMatch
        XCTAssertTrue(navigation.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["advance-assignment-button"].exists)
        XCTAssertEqual(app.buttons["advance-assignment-button"].label, "开始前往")

        tapPanelElement(app, element: app.buttons["advance-assignment-button"])
        let route = app.descendants(matching: .any)["test-route-canvas"].firstMatch
        XCTAssertTrue(route.waitForExistence(timeout: 3))
        XCTAssertEqual(route.label, "测试路线：当前位置到AED")
        attachScreenshot(app, named: "responder-en-route-to-aed")
        XCTAssertTrue(waitForButton(app, id: "advance-assignment-button", label: "已到达 AED"))

        tapPanelElement(app, element: app.buttons["advance-assignment-button"])
        let acquired = app.buttons["aed-acquired-button"]
        XCTAssertTrue(acquired.waitForExistence(timeout: 3))
        tapPanelElement(app, element: acquired)

        XCTAssertTrue(waitForElementLabel(
            app,
            identifier: "test-route-canvas",
            label: "测试路线：当前位置到患者"
        ))
        XCTAssertTrue(waitForButton(app, id: "advance-assignment-button", label: "携 AED 前往患者"))
        attachScreenshot(app, named: "aed-acquired-route-to-patient")
        tapPanelElement(app, element: app.buttons["advance-assignment-button"])
        XCTAssertTrue(waitForButton(app, id: "advance-assignment-button", label: "已到达患者"))
        tapPanelElement(app, element: app.buttons["advance-assignment-button"])
        XCTAssertTrue(app.buttons["responder-resolve-button"].waitForExistence(timeout: 3))
        tapPanelElement(app, element: app.buttons["响应状态"])
        XCTAssertTrue(app.descendants(matching: .any)["response-status-card"].waitForExistence(timeout: 3))
    }

    func testTestHostCanSwitchFromPatientToResponderPreview() throws {
        let app = launchApp(arguments: [])

        let testTab = app.tabBars.buttons["测试"]
        XCTAssertTrue(testTab.waitForExistence(timeout: 3))
        testTab.tap()

        let patient = app.buttons["local-test-scenario-patient"]
        XCTAssertTrue(patient.waitForExistence(timeout: 3))
        patient.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["local-test-scenario-banner"]
                .firstMatch
                .waitForExistence(timeout: 3)
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["patient-event-card"]
                .firstMatch
                .waitForExistence(timeout: 3)
        )

        testTab.tap()
        let fetchAed = app.buttons["local-test-scenario-responderFetchAed"]
        XCTAssertTrue(fetchAed.waitForExistence(timeout: 3))
        fetchAed.tap()
        XCTAssertTrue(app.descendants(matching: .any)["responder-navigation-view"].exists)
        tapPanelElement(app, element: app.buttons["响应状态"])
        XCTAssertTrue(app.descendants(matching: .any)["response-status-card"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.tabBars.buttons["时间线"].exists)
    }

    func testPatientFalseAlarmHasOneExplicitConfirmation() throws {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "patient")

        let falseAlarm = app.buttons["confirm-false-alarm-button"]
        XCTAssertTrue(falseAlarm.waitForExistence(timeout: 3))
        falseAlarm.tap()
        // The native confirmation sheet exposes a wrapper and its child with
        // the same identifier; both represent this one visible action.
        let confirmation = app.buttons["patient-confirmation-button"].firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
        XCTAssertEqual(confirmation.label, "确认误报")
        attachScreenshot(app, named: "patient-false-alarm-confirmation")
        confirmation.tap()
        XCTAssertTrue(app.staticTexts["已标记误报"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["patient-resolve-button"].exists)
    }

    func testPatientResolveHasOneExplicitConfirmation() throws {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "patient")

        let resolve = app.buttons["patient-resolve-button"]
        XCTAssertTrue(resolve.waitForExistence(timeout: 3))
        resolve.tap()
        let confirmation = app.buttons["patient-confirmation-button"].firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 3))
        XCTAssertEqual(confirmation.label, "确认结束")
        attachScreenshot(app, named: "patient-resolve-confirmation")
        confirmation.tap()
        XCTAssertTrue(app.staticTexts["救助已结束"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["confirm-false-alarm-button"].exists)
    }

    func testResponderStartRevealsNavigationAndResponseStatus() throws {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "responderGoToPatient")

        XCTAssertTrue(app.descendants(matching: .any)["responder-navigation-view"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["advance-assignment-button"].waitForExistence(timeout: 3))
        XCTAssertEqual(app.buttons["advance-assignment-button"].label, "开始前往")
        tapPanelElement(app, element: app.buttons["响应状态"])
        XCTAssertTrue(app.descendants(matching: .any)["response-status-card"].waitForExistence(timeout: 3))

        tapPanelElement(app, element: app.buttons["advance-assignment-button"])

        XCTAssertTrue(app.descendants(matching: .any)["response-status-card"].waitForExistence(timeout: 3))
        XCTAssertTrue(waitForElementLabel(
            app,
            identifier: "test-route-canvas",
            label: "测试路线：当前位置到患者"
        ))
        attachScreenshot(app, named: "responder-en-route")
    }

    func testSettingsShowsUserPermissionsAndHidesDeveloperInformation() throws {
        let app = launchApp(arguments: [])
        let settingsTab = app.tabBars.buttons["设置"]
        XCTAssertTrue(settingsTab.waitForExistence(timeout: 3))
        settingsTab.tap()

        XCTAssertTrue(app.descendants(matching: .any)["settings-account-status"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["settings-server-state"].exists)
        XCTAssertFalse(app.buttons["settings-ping-button"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["settings-location-permission"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["settings-notification-permission"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["settings-watch-communication"].exists)
        XCTAssertTrue(app.switches["settings-nearby-range-circles-toggle"].exists)
        attachScreenshot(app, named: "settings-connection")
        let systemSettings = app.descendants(matching: .any)["settings-system-settings-button"].firstMatch
        for _ in 0..<5 {
            if systemSettings.exists && systemSettings.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(systemSettings.exists)
        XCTAssertFalse(app.descendants(matching: .any)["settings-location-latitude"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["settings-location-longitude"].exists)
        app.buttons["settings-consent-link"].tap()
        XCTAssertTrue(app.staticTexts["患者协议"].waitForExistence(timeout: 3))
        app.navigationBars.buttons.firstMatch.tap()

        XCTAssertFalse(app.staticTexts["Watch 真机门槛"].exists)
        XCTAssertFalse(app.staticTexts["特殊 entitlement 需 Apple 单独批准"].exists)
        XCTAssertFalse(app.staticTexts["有限配对 ID"].exists)
        XCTAssertFalse(app.staticTexts["DEBUG 开发服务器地址"].exists)
        XCTAssertFalse(app.staticTexts["受信任服务地址"].exists)
        XCTAssertFalse(app.staticTexts["AEDResponseServiceBaseURL"].exists)
        XCTAssertFalse(app.staticTexts["http://127.0.0.1:8787"].exists)
        attachScreenshot(app, named: "settings-safe-surface")
    }

    func testDefaultActionHidesSafeTestDialer() {
        let app = launchApp(arguments: [])

        XCTAssertTrue(app.descendants(matching: .any)["standby-action-panel"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["safe-dialer-button"].exists)
        XCTAssertFalse(app.staticTexts["用户主动打开系统拨号器"].exists)
    }

    func testSoleResponderExitCancelsAndThenRequiresThreeDistinctConfirmations() {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "responderGoToPatient")
        let exit = app.buttons["exit-task-button"]
        openTaskExitMenu(app)
        XCTAssertTrue(exit.waitForExistence(timeout: 5))
        exit.tap()
        let confirm = app.buttons["exit-confirmation-button"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 3))
        XCTAssertTrue(confirm.label.contains("1/3"))
        confirm.tap()
        XCTAssertTrue(waitForButton(app, id: "exit-confirmation-button", label: "确认退出（2/3）"))
        app.buttons["exit-cancel-button"].tap()
        openTaskExitMenu(app)
        XCTAssertTrue(exit.waitForExistence(timeout: 5))
        exit.tap()
        XCTAssertTrue(waitForButton(app, id: "exit-confirmation-button", label: "确认退出（1/3）"))
        confirm.tap()
        XCTAssertTrue(waitForButton(app, id: "exit-confirmation-button", label: "确认退出（2/3）"))
        confirm.tap()
        XCTAssertTrue(waitForButton(app, id: "exit-confirmation-button", label: "确认退出（3/3）"))
        attachScreenshot(app, named: "sole-responder-third-confirmation")
        confirm.tap()
        XCTAssertTrue(app.descendants(matching: .any)["standby-action-panel"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.descendants(matching: .any)["responder-navigation-view"].exists)
        // A new preview gets a new event identity and must not inherit the
        // previous preview's permanent exit marker.
        openLocalScenario(app, id: "responderGoToPatient")
        openTaskExitMenu(app)
        XCTAssertTrue(exit.waitForExistence(timeout: 5))
    }

    func testConsumerReferenceScreensAndAedSteps() {
        let app = launchApp(arguments: [])
        openLocalScenario(app, id: "neutral")
        XCTAssertTrue(app.descendants(matching: .any)["standby-action-panel"].waitForExistence(timeout: 5))
        attachScreenshot(app, named: "AED1-home")
        openLocalScenario(app, id: "responseRequest")
        XCTAssertTrue(app.buttons["accept-response-button"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["附近有人需要帮助"].exists)
        attachScreenshot(app, named: "AED2-request")
        openLocalScenario(app, id: "responderFetchAed")
        let advance = app.buttons["advance-assignment-button"]
        XCTAssertTrue(advance.waitForExistence(timeout: 3))
        tapPanelElement(app, element: advance)
        XCTAssertTrue(waitForButton(app, id: "advance-assignment-button", label: "已到达 AED"))
        attachScreenshot(app, named: "AED3-navigation")
        tapPanelElement(app, element: advance)
        let acquired = app.buttons["aed-acquired-button"]
        XCTAssertTrue(acquired.waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["aed-unavailable-button"].exists)
        tapPanelElement(app, element: acquired)
        attachScreenshot(app, named: "AED3-acquired")
        XCTAssertTrue(waitForButton(app, id: "advance-assignment-button", label: "携 AED 前往患者"))
        openLocalScenario(app, id: "neutral")
        app.tabBars.buttons["设置"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["settings-account-status"].waitForExistence(timeout: 3))
        attachScreenshot(app, named: "AED4-settings")
    }

    func testMapFirstDarkAccessibilityScreensKeepPrimaryActionsReachable() {
        let app = launchApp(arguments: [
            "-AppleInterfaceStyle", "Dark",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"
        ])
        openLocalScenario(app, id: "neutral")
        assertNearbyCounts(app)
        assertFullPageMap(app)
        attachScreenshot(app, named: "map-first-dark-accessibility-standby")

        openLocalScenario(app, id: "responseRequest")
        let accept = app.buttons["accept-response-button"]
        XCTAssertTrue(accept.waitForExistence(timeout: 5))
        scrollPanelToReveal(app, element: accept)
        assertPrimaryActionFitsPanel(app, button: accept)
        XCTAssertFalse(app.descendants(matching: .any)["task-location-details"].exists)
        attachScreenshot(app, named: "map-first-dark-accessibility-invitation")

        openLocalScenario(app, id: "responderGoToPatient")
        let advance = app.buttons["advance-assignment-button"]
        XCTAssertTrue(advance.waitForExistence(timeout: 5))
        scrollPanelToReveal(app, element: advance)
        assertPrimaryActionFitsPanel(app, button: advance)
        attachScreenshot(app, named: "map-first-dark-accessibility-task")
        tapPanelElement(app, element: app.buttons["响应状态"])
        XCTAssertTrue(app.descendants(matching: .any)["response-status-card"].waitForExistence(timeout: 3))
    }

    func testLoginRequiresUncheckedAgreementsBeforeAppleSignIn() {
        let app = launchApp(arguments: ["-UITestSignedOut"])
        let login = app.buttons["sign-in-with-apple-button"]
        XCTAssertTrue(login.waitForExistence(timeout: 5))
        XCTAssertFalse(login.isEnabled)
        let kinds = ["PATIENT", "VOLUNTEER_RESPONDER", "PRIVACY_POLICY", "SENSITIVE_PERSONAL_INFORMATION"]
        for kind in kinds {
            let checkbox = app.descendants(matching: .any)["login-consent-\(kind)"].firstMatch
            for _ in 0..<3 where !checkbox.isHittable { app.swipeUp() }
            XCTAssertTrue(checkbox.exists)
            XCTAssertEqual(checkbox.value as? String, "0")
            checkbox.tap()
            if kind != kinds.last { XCTAssertFalse(login.isEnabled) }
        }
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: login)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed)
        attachScreenshot(app, named: "login-consent-checked")
        let privacy = app.descendants(matching: .any)["login-consent-PRIVACY_POLICY"].firstMatch
        privacy.tap()
        XCTAssertFalse(login.isEnabled)
        app.buttons["login-agreement-PRIVACY_POLICY"].tap()
        XCTAssertTrue(app.buttons["agreement-reader-done-button"].waitForExistence(timeout: 3))
        app.buttons["agreement-reader-done-button"].tap()
        XCTAssertFalse(login.isEnabled)
    }

    private func assertNearbyCounts(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        for (radius, count) in [(1_000, 3), (1_500, 5), (2_000, 8)] {
            let value = app.descendants(matching: .any)["nearby-map-count-\(radius)"].firstMatch
            XCTAssertTrue(value.waitForExistence(timeout: 5), file: file, line: line)
            XCTAssertTrue(value.label.contains("\(count) 人"), file: file, line: line)
        }
        for label in ["1 公里内", "1.5 公里内", "2 公里内"] {
            XCTAssertTrue(app.staticTexts[label].exists, "Missing aggregate count: \(label)", file: file, line: line)
        }
    }

    private func assertFullPageMap(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let map = app.descendants(matching: .any)["action-map-canvas"].firstMatch
        XCTAssertTrue(map.waitForExistence(timeout: 5), file: file, line: line)
        XCTAssertGreaterThan(map.frame.height, 300, "Map must be larger than the former 236 pt card", file: file, line: line)
        XCTAssertGreaterThan(map.frame.height, app.frame.height * 0.5, file: file, line: line)
    }

    private func assertPrimaryActionFitsPanel(
        _ app: XCUIApplication, button: XCUIElement,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let panel = app.descendants(matching: .any)["action-map-panel"].firstMatch
        XCTAssertTrue(panel.exists, file: file, line: line)
        XCTAssertTrue(button.isHittable, file: file, line: line)
        XCTAssertGreaterThanOrEqual(button.frame.height, 51.5, file: file, line: line)
        XCTAssertGreaterThanOrEqual(button.frame.minY, panel.frame.minY - 1, file: file, line: line)
        XCTAssertLessThanOrEqual(button.frame.maxY, panel.frame.maxY + 1, file: file, line: line)
        if let tab = app.tabBars.allElementsBoundByIndex.first(where: { $0.exists && $0.frame.height > 0 }) {
            XCTAssertLessThanOrEqual(button.frame.maxY, tab.frame.minY + 1, file: file, line: line)
        }
    }

    private func scrollPanelToReveal(_ app: XCUIApplication, element: XCUIElement) {
        let panel = app.descendants(matching: .any)["action-map-panel"].firstMatch
        XCTAssertTrue(panel.waitForExistence(timeout: 5))
        for _ in 0..<10 {
            if element.exists && element.isHittable,
               element.frame.minY >= panel.frame.minY + 2,
               element.frame.maxY <= panel.frame.maxY - 2 { return }
            let scrollDown = element.exists && element.frame.minY < panel.frame.minY
            let start = panel.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.30 : 0.80))
            let end = panel.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: scrollDown ? 0.80 : 0.30))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTAssertTrue(element.exists && element.isHittable, "The action must remain reachable inside its scrollable panel")
    }

    private func tapPanelElement(_ app: XCUIApplication, element: XCUIElement) {
        scrollPanelToReveal(app, element: element)
        element.tap()
    }

    private func openTaskExitMenu(_ app: XCUIApplication) {
        let more = app.buttons["task-more-menu"]
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        tapPanelElement(app, element: more)
        XCTAssertTrue(app.buttons["exit-task-button"].waitForExistence(timeout: 5))
    }

    private func launchApp(arguments: [String]) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        // -UITestMode selects the TestHost's fake identity and deterministic
        // fixture path. It never starts a server or performs a URL request.
        app.launchArguments = ["-UITestMode"] + arguments
        app.launch()
        return app
    }

    private func openLocalScenario(_ app: XCUIApplication, id: String) {
        let testTab = app.tabBars.buttons["测试"]
        XCTAssertTrue(testTab.waitForExistence(timeout: 3))
        testTab.tap()

        let scenario = app.buttons["local-test-scenario-\(id)"]
        // The first synthesized tab tap may leave the old tab selected on iOS 26.
        // Retry only if the tab did not become selected, never mask a missing scenario.
        if !scenario.waitForExistence(timeout: 5), !testTab.isSelected {
            testTab.tap()
        }
        // The fixture picker is a lazy collection. Large text can place the
        // requested row below the viewport; scroll this selected tab, not the map.
        let picker = app.collectionViews["local-test-scenario-panel"]
        for _ in 0..<8 {
            if scenario.exists && scenario.isHittable { break }
            guard testTab.isSelected else { break }
            let isAbove = scenario.exists && scenario.frame.maxY < picker.frame.minY
            if isAbove { picker.swipeDown() } else { picker.swipeUp() }
        }
        XCTAssertTrue(scenario.waitForExistence(timeout: 5))
        XCTAssertTrue(scenario.isHittable)
        scenario.tap()
        let actionTab = app.tabBars.buttons["行动"]
        let selected = NSPredicate(format: "selected == true")
        // A banner from the previous scenario can still exist after a dropped
        // Simulator tap. Wait for the actual tab transition before inspecting UI.
        let switched = XCTNSPredicateExpectation(predicate: selected, object: actionTab)
        if XCTWaiter.wait(for: [switched], timeout: 5) != .completed, testTab.isSelected {
            scenario.tap()
        }
        let ready = XCTNSPredicateExpectation(predicate: selected, object: actionTab)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
        XCTAssertTrue(app.descendants(matching: .any)["local-test-scenario-banner"].waitForExistence(timeout: 3))
        XCTAssertTrue(actionTab.exists)
    }

    private func waitForButton(
        _ app: XCUIApplication,
        id: String,
        label: String,
        timeout: TimeInterval = 10
    ) -> Bool {
        let button = app.buttons[id]
        guard button.waitForExistence(timeout: timeout) else { return false }
        let predicate = NSPredicate(format: "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: button)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func waitForElementLabel(
        _ app: XCUIApplication,
        identifier: String,
        label: String,
        timeout: TimeInterval = 3
    ) -> Bool {
        let element = app.descendants(matching: .any)[identifier].firstMatch
        guard element.waitForExistence(timeout: timeout) else { return false }
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", label),
            object: element
        )
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    private func attachScreenshot(_ app: XCUIApplication, named name: String) {
        // XCUIApplication.screenshot() is scoped to the app window; do not
        // capture system permission sheets or other private system UI.
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func enableSwitch(_ element: XCUIElement) {
        for _ in 0..<3 {
            if (element.value as? String) == "1" { return }
            let embeddedControl = element.descendants(matching: .switch).element(boundBy: 0)
            if embeddedControl.exists {
                embeddedControl.tap()
            } else {
                element.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
            }
            let enabled = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "value == %@", "1"),
                object: element
            )
            if XCTWaiter.wait(for: [enabled], timeout: 1) == .completed { return }
        }
        XCTAssertEqual(element.value as? String, "1")
    }
}
