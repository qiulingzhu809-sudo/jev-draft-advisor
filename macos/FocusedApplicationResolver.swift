import Darwin

func selectFocusedApplicationPID(systemPID: pid_t?, frontmostPID: pid_t?) -> pid_t? {
    systemPID ?? frontmostPID
}
