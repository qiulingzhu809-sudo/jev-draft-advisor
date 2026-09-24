import AppKit
import ApplicationServices
import Carbon

private let hotkeySignature: OSType = 0x4A45564A // JEVJ

private func hotkeyHandler(_ event: EventHandlerCallRef?, _ ref: EventRef?, _ data: UnsafeMutableRawPointer?) -> OSStatus {
    guard let data else { return OSStatus(eventNotHandledErr) }
    let advisor = Unmanaged<DraftAdvisor>.fromOpaque(data).takeUnretainedValue()
    // Capture the focused app before the event loop can move focus elsewhere.
    advisor.analyzeFocusedDraft()
    return noErr
}

private final class MovableLabel: NSTextField {
    override var mouseDownCanMoveWindow: Bool { true }
}

final class DraftAdvisor: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var panel: NSPanel?
    private var label: NSTextField?
    private var pinMenuItem: NSMenuItem?
    private var hotkey: EventHotKeyRef?
    private var busy = false
    private var isPositionPinned = false
    private let preferences = UserDefaults(suiteName: "jev-draft-advisor")!
    private let priorities = [("balanced", "均衡"), ("cost", "性价比"), ("quality", "质量优先"), ("speed", "速度优先")]
    private var priority: String { preferences.string(forKey: "priority") ?? "balanced" }
    private var considerQuota: Bool { preferences.object(forKey: "considerQuota") as? Bool ?? true }
    private var preferenceItems: [NSMenuItem] = []
    private var quotaItems: [NSMenuItem] = []

    private func addPreferences(to menu: NSMenu) {
        let parent = NSMenuItem(title: "推荐偏好", action: nil, keyEquivalent: "")
        let choices = NSMenu()
        for (key, title) in priorities {
            let item = NSMenuItem(title: title, action: #selector(selectPriority(_:)), keyEquivalent: "")
            item.representedObject = key
            item.target = self
            choices.addItem(item)
            preferenceItems.append(item)
        }
        parent.submenu = choices
        menu.addItem(parent)
        let quota = NSMenuItem(title: "参考本地 Codex 登录账户额度", action: #selector(toggleQuota), keyEquivalent: "")
        quota.target = self
        quotaItems.append(quota)
        menu.addItem(quota)
        refreshPreferences()
    }

    private func refreshPreferences() {
        for item in preferenceItems { item.state = (item.representedObject as? String) == priority ? .on : .off }
        for item in quotaItems { item.state = considerQuota ? .on : .off }
    }

    @objc private func selectPriority(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        preferences.set(key, forKey: "priority")
        refreshPreferences()
    }

    @objc private func toggleQuota() {
        preferences.set(!considerQuota, forKey: "considerQuota")
        refreshPreferences()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Jev"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "分析 Codex 草稿  ⌃J", action: #selector(analyzeFocusedDraft), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "隐藏弹窗", action: #selector(hidePanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: ""))
        menu.items.forEach { $0.target = self }
        addPreferences(to: menu)
        statusItem.menu = menu

        let id = EventHotKeyID(signature: hotkeySignature, id: 1)
        let result = RegisterEventHotKey(UInt32(kVK_ANSI_J), UInt32(controlKey), id,
                                        GetApplicationEventTarget(), 0, &hotkey)
        guard result == noErr else {
            show("快捷键注册失败（可能与其他软件冲突）")
            return
        }
        let types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))]
        InstallEventHandler(GetApplicationEventTarget(), hotkeyHandler, 1, types,
                            Unmanaged.passUnretained(self).toOpaque(), nil)
        print("Jev 草稿建议已启动：切到 Codex，输入文字，按 Control+J。")
    }

    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func hidePanel() {
        panel?.orderOut(nil)
    }

    @objc private func togglePositionPinned() {
        isPositionPinned.toggle()
        panel?.isMovableByWindowBackground = !isPositionPinned
        updatePinMenuItem()
    }

    private func updatePinMenuItem() {
        pinMenuItem?.title = isPositionPinned ? "取消固定位置" : "固定当前位置"
        pinMenuItem?.state = isPositionPinned ? .on : .off
    }

    func menuWillOpen(_ menu: NSMenu) {
        updatePinMenuItem()
    }

    private func makePanelMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        addPreferences(to: menu)
        menu.addItem(.separator())
        let pin = NSMenuItem(title: "固定当前位置", action: #selector(togglePositionPinned), keyEquivalent: "")
        pin.target = self
        pinMenuItem = pin
        menu.addItem(pin)
        menu.addItem(.separator())
        let hide = NSMenuItem(title: "隐藏弹窗", action: #selector(hidePanel), keyEquivalent: "")
        hide.target = self
        menu.addItem(hide)
        let exit = NSMenuItem(title: "退出 Jev", action: #selector(quit), keyEquivalent: "")
        exit.target = self
        menu.addItem(exit)
        return menu
    }

    @objc func analyzeFocusedDraft() {
        if busy { return }
        guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else {
            show("请在「系统设置 → 隐私与安全 → 辅助功能」允许 Jev 草稿建议，然后重试")
            return
        }
        let system = AXUIElementCreateSystemWide()
        var focusedApp: CFTypeRef?
        let appStatus = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &focusedApp)
        var systemPID: pid_t?
        if appStatus == .success, let focusedApp {
            var pid: pid_t = 0
            if AXUIElementGetPid(focusedApp as! AXUIElement, &pid) == .success {
                systemPID = pid
            }
        }
        let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard let pid = selectFocusedApplicationPID(systemPID: systemPID, frontmostPID: frontmostPID) else {
            show("系统未报告当前聚焦应用（AX 错误 \(appStatus.rawValue)），且未找到前台进程")
            return
        }
        let appElement = AXUIElementCreateApplication(pid)
        let focusedProcess = NSRunningApplication(processIdentifier: pid)
        let focusedBundle = focusedProcess?.bundleIdentifier ?? "未知标识"
        guard focusedBundle == "com.openai.codex" || focusedBundle.hasPrefix("com.openai.codex.") else {
            show("当前焦点属于 \(focusedBundle)，不是 Codex。请点击草稿输入框后重试")
            return
        }
        let accessibilityDraft = resolveDraftElement(appElement: appElement, systemElement: system)?.value
        let copiedDraft = selectDraft(accessibilityDraft: accessibilityDraft, copiedDraft: nil) == nil
            ? captureDraftUsingKeyboard(from: pid)
            : nil
        guard let draft = selectDraft(accessibilityDraft: accessibilityDraft, copiedDraft: copiedDraft) else {
            show("未能读取草稿。请先点击 Codex 输入框，确认其中有文字，再按 Control+J")
            return
        }
        if draft.count > 8_000 { show("草稿超过 8000 字，请缩短后再分析"); return }
        busy = true
        let selectedPriority = priority
        let includeQuota = considerQuota
        show("Jev 正在分析当前草稿…")
        DispatchQueue.global(qos: .userInitiated).async {
            let message = self.runJev(draft, priority: selectedPriority, considerQuota: includeQuota)
            DispatchQueue.main.async {
                self.busy = false
                self.show(message)
            }
        }
    }

    private func runJev(_ draft: String, priority: String, considerQuota: Bool) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["JEV_NODE_BIN"] ?? "/opt/homebrew/bin/node")
        process.arguments = ["--env-file=.env", "scripts/advise-draft.mjs"]
        process.currentDirectoryURL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let input = Pipe(), output = Pipe(), error = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = error
        do {
            try process.run()
            let data = try JSONSerialization.data(withJSONObject: ["prompt": draft, "priority": priority, "considerQuota": considerQuota])
            input.fileHandleForWriting.write(data)
            try? input.fileHandleForWriting.close()
            var pending = Data()
            var lastMessage: String?
            while true {
                let chunk = output.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                pending.append(chunk)
                while let newline = pending.firstIndex(of: 10) {
                    let line = Data(pending[..<newline])
                    pending.removeSubrange(...newline)
                    if let message = self.renderResponse(line, priority: priority) {
                        lastMessage = message
                        DispatchQueue.main.async { self.show(message) }
                    }
                }
            }
            process.waitUntilExit()
            guard process.terminationStatus == 0 else {
                let detail = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "未知错误"
                return "分析失败：\(detail.prefix(100))"
            }
            return lastMessage ?? "Jev 返回的数据不完整"
        } catch {
            return "分析失败：\(error.localizedDescription)"
        }
    }

    private func renderResponse(_ response: Data, priority: String) -> String? {
            guard let json = (try? JSONSerialization.jsonObject(with: response)) as? [String: Any],
                  let model = json["model"] as? String, let effort = json["effort"] as? String else {
                return nil
            }
            let depth = json["reasoningDepth"] as? String ?? "normal"
            let review = (json["needsHumanReview"] as? Bool == true) ? " · 请人工复核" : ""
            let title = priorities.first(where: { $0.0 == priority })?.1 ?? priority
            let quota = json["quotaText"] as? String ?? "额度未知"
            let adjustment = (json["budgetAdjusted"] as? Bool == true) ? " · 已节省推理消耗" : ""
            return "\(title)：\(model) · \(effort)（\(depth)）\(review)\n\(quota)\(adjustment)\n请手动切换；草稿未提交到 Codex。"
    }

    private func show(_ message: String) {
        if panel == nil {
            let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 520, height: 110),
                                 styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            window.level = .floating
            window.isOpaque = false
            window.backgroundColor = .clear
            window.hasShadow = true
            window.ignoresMouseEvents = false
            window.isMovableByWindowBackground = true
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

            let root = NSView(frame: window.contentView!.bounds)
            root.wantsLayer = true
            root.layer?.cornerRadius = 36
            root.layer?.borderWidth = 1
            root.layer?.borderColor = NSColor.white.withAlphaComponent(0.7).cgColor
            root.layer?.masksToBounds = true
            let panelMenu = makePanelMenu()
            root.menu = panelMenu

            if #available(macOS 26.0, *) {
                // Native glass supplies its own blur, tint, and edge highlights.
                root.layer?.borderWidth = 0
            } else {
            let box = NSVisualEffectView(frame: root.bounds)
            box.material = .popover
            box.state = .active
            box.blendingMode = .behindWindow
            box.alphaValue = 1
            box.autoresizingMask = [.width, .height]
            box.menu = panelMenu
            root.addSubview(box)

            // Keep blur fully composited; reducing its alpha exposes sharp text behind it.
            let tint = NSView(frame: root.bounds)
            tint.wantsLayer = true
            tint.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.12).cgColor
            tint.autoresizingMask = [.width, .height]
            tint.menu = panelMenu
            root.addSubview(tint)
            }

            let text = MovableLabel(frame: .zero)
            text.frame = NSRect(x: 22, y: 16, width: 476, height: 78)
            text.isBezeled = false
            text.drawsBackground = false
            text.isEditable = false
            text.isSelectable = false
            text.maximumNumberOfLines = 5
            text.lineBreakMode = .byWordWrapping
            text.font = .systemFont(ofSize: 13)
            text.textColor = .labelColor
            text.menu = panelMenu
            root.addSubview(text)
            if #available(macOS 26.0, *) {
                let glass = NSGlassEffectView(frame: root.bounds)
                glass.style = .clear
                glass.cornerRadius = 36
                glass.contentView = root
                glass.menu = panelMenu
                window.contentView = glass
            } else {
                window.contentView = root
            }
            panel = window
            label = text
        }
        label?.stringValue = message
        if !isPositionPinned {
            let mouse = NSEvent.mouseLocation
            let screen = NSScreen.screens.first(where: { $0.frame.contains(mouse) }) ?? NSScreen.main
            let bounds = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1000, height: 700)
            let x = min(max(mouse.x - 260, bounds.minX + 8), bounds.maxX - 528)
            let y = min(max(mouse.y + 22, bounds.minY + 8), bounds.maxY - 118)
            panel?.setFrameOrigin(NSPoint(x: x, y: y))
        }
        panel?.orderFrontRegardless()
    }
}

@main
struct JevDraftAdvisorMain {
    static func main() {
        let app = NSApplication.shared
        let advisor = DraftAdvisor()
        app.delegate = advisor
        app.run()
    }
}
