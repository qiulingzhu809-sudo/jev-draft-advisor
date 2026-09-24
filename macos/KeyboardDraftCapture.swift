import AppKit
import Carbon

func selectDraft(accessibilityDraft: String?, copiedDraft: String?) -> String? {
    for draft in [accessibilityDraft, copiedDraft] {
        guard let draft else { continue }
        if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return draft
        }
    }
    return nil
}

private struct PasteboardSnapshot {
    let items: [[NSPasteboard.PasteboardType: Data]]

    init(_ pasteboard: NSPasteboard) {
        items = (pasteboard.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                item.data(forType: type).map { (type, $0) }
            })
        }
    }

    func restore(to pasteboard: NSPasteboard) {
        pasteboard.clearContents()
        let restoredItems = items.map { values -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in values {
                item.setData(data, forType: type)
            }
            return item
        }
        if !restoredItems.isEmpty {
            pasteboard.writeObjects(restoredItems)
        }
    }
}

private func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = [], to pid: pid_t) {
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
        return
    }
    down.flags = flags
    up.flags = flags
    down.postToPid(pid)
    up.postToPid(pid)
}

/// Reads a focused editor that does not expose AXValue by temporarily copying its contents.
/// The user's pasteboard is restored before this function returns.
func captureDraftUsingKeyboard(from pid: pid_t,
                               pasteboard: NSPasteboard = .general,
                               timeout: TimeInterval = 0.6) -> String? {
    let snapshot = PasteboardSnapshot(pasteboard)
    defer { snapshot.restore(to: pasteboard) }

    pasteboard.clearContents()
    postKey(CGKeyCode(kVK_ANSI_A), flags: .maskCommand, to: pid)
    Thread.sleep(forTimeInterval: 0.04)
    postKey(CGKeyCode(kVK_ANSI_C), flags: .maskCommand, to: pid)

    let deadline = Date().addingTimeInterval(timeout)
    var copied: String?
    repeat {
        if let value = pasteboard.string(forType: .string),
           !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            copied = value
            break
        }
        Thread.sleep(forTimeInterval: 0.02)
    } while Date() < deadline

    // Collapse the Select All range without modifying the draft.
    postKey(CGKeyCode(kVK_RightArrow), to: pid)
    return copied
}
