import ApplicationServices

struct DraftElementMatch {
    let element: AXUIElement
    let value: String
    let role: String
    let score: Int
}

func draftCandidateScore(role: String,
                         value: String,
                         isFocused: Bool,
                         isValueSettable: Bool) -> Int? {
    guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    let textRoles = [kAXTextAreaRole as String, kAXTextFieldRole as String, kAXComboBoxRole as String]
    guard textRoles.contains(role) || isValueSettable else { return nil }

    var score = 0
    if isFocused { score += 1_000 }
    if isValueSettable { score += 200 }
    if role == kAXTextAreaRole as String { score += 100 }
    score += min(value.count, 80)
    return score
}

private func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func copyString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    copyAttribute(element, attribute) as? String
}

private func copyBool(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    (copyAttribute(element, attribute) as? Bool) ?? false
}

private func isValueSettable(_ element: AXUIElement) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success
        && settable.boolValue
}

private func candidate(for element: AXUIElement) -> DraftElementMatch? {
    let role = copyString(element, kAXRoleAttribute as CFString) ?? "未知类型"
    let value = copyString(element, kAXValueAttribute as CFString)
        ?? copyString(element, kAXSelectedTextAttribute as CFString)
        ?? ""
    guard let score = draftCandidateScore(role: role,
                                          value: value,
                                          isFocused: copyBool(element, kAXFocusedAttribute as CFString),
                                          isValueSettable: isValueSettable(element)) else {
        return nil
    }
    return DraftElementMatch(element: element, value: value, role: role, score: score)
}

private func childElements(of element: AXUIElement) -> [AXUIElement] {
    let attributes = [kAXChildrenAttribute as CFString, kAXVisibleChildrenAttribute as CFString]
    var children: [AXUIElement] = []
    for attribute in attributes {
        if let values = copyAttribute(element, attribute) as? [AXUIElement] {
            children.append(contentsOf: values)
        }
    }
    return children
}

func resolveDraftElement(appElement: AXUIElement,
                         systemElement: AXUIElement,
                         maxNodes: Int = 2_500,
                         maxDepth: Int = 30) -> DraftElementMatch? {
    var roots: [AXUIElement] = []
    for (element, attribute) in [
        (appElement, kAXFocusedUIElementAttribute as CFString),
        (systemElement, kAXFocusedUIElementAttribute as CFString),
        (appElement, kAXFocusedWindowAttribute as CFString),
    ] {
        if let value = copyAttribute(element, attribute) {
            roots.append(value as! AXUIElement)
        }
    }
    if let windows = copyAttribute(appElement, kAXWindowsAttribute as CFString) as? [AXUIElement] {
        roots.append(contentsOf: windows)
    }

    var queue = roots.map { ($0, 0) }
    var cursor = 0
    var visited = Set<CFHashCode>()
    var best: DraftElementMatch?
    while cursor < queue.count && cursor < maxNodes {
        let (element, depth) = queue[cursor]
        cursor += 1
        let identity = CFHash(element)
        guard visited.insert(identity).inserted else { continue }

        if let match = candidate(for: element), best == nil || match.score > best!.score {
            best = match
        }
        if depth < maxDepth {
            queue.append(contentsOf: childElements(of: element).map { ($0, depth + 1) })
        }
    }
    return best
}
