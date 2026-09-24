import ApplicationServices

@main
struct DraftElementResolverTests {
    static func main() {
        precondition(draftCandidateScore(role: kAXTextAreaRole as String,
                                         value: "继续测试",
                                         isFocused: true,
                                         isValueSettable: true) != nil)
        precondition(draftCandidateScore(role: kAXStaticTextRole as String,
                                         value: "历史回复",
                                         isFocused: false,
                                         isValueSettable: false) == nil)

        let focused = draftCandidateScore(role: kAXTextAreaRole as String,
                                          value: "草稿",
                                          isFocused: true,
                                          isValueSettable: true)!
        let unfocused = draftCandidateScore(role: kAXTextAreaRole as String,
                                            value: "旧草稿",
                                            isFocused: false,
                                            isValueSettable: true)!
        precondition(focused > unfocused)
        print("draft element resolver tests passed")
    }
}
