import Foundation

@main
struct DraftCapturePolicyTests {
    static func main() {
        precondition(selectDraft(accessibilityDraft: "AX 草稿", copiedDraft: "复制草稿") == "AX 草稿")
        precondition(selectDraft(accessibilityDraft: nil, copiedDraft: "复制草稿") == "复制草稿")
        precondition(selectDraft(accessibilityDraft: "   ", copiedDraft: "复制草稿") == "复制草稿")
        precondition(selectDraft(accessibilityDraft: nil, copiedDraft: "\n\t") == nil)
        print("draft capture policy tests passed")
    }
}
