import Foundation

@main
struct FocusedApplicationResolverTests {
    static func main() {
        precondition(selectFocusedApplicationPID(systemPID: 42, frontmostPID: 84) == 42)
        precondition(selectFocusedApplicationPID(systemPID: nil, frontmostPID: 84) == 84)
        precondition(selectFocusedApplicationPID(systemPID: nil, frontmostPID: nil) == nil)
        print("focused application fallback tests passed")
    }
}
