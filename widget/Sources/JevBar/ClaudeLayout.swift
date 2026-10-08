import AppKit
import ApplicationServices

/// What the Claude window is showing, read through Accessibility: the page's name (which says
/// whether it's a Claude Code session or a chat) and where the sidebar's and any side pane's
/// resize handles are. Needs Accessibility access for Jev Bar; without it nothing is read and the
/// icon keeps to the whole window, in every tab.
///
/// A full search of Claude's window takes tens of milliseconds, so it runs off the main thread at
/// most once a second, and the elements it finds are kept: each tick then only re-reads their
/// name and frames. Coordinates are Accessibility's: from the top left of the main display, y down.
final class ClaudeLayout: @unchecked Sendable {
    struct Snapshot: Equatable {
        var pageTitle: String
        var sidebarHandle: CGRect?
        var paneHandle: CGRect?
    }

    static var isTrusted: Bool { AXIsProcessTrusted() }

    /// Shows macOS's prompt to grant Accessibility access (System Settings → Privacy & Security).
    static func askForAccess() {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    private let queue = DispatchQueue(label: "JevBar.ClaudeLayout")
    private let lock = NSLock()
    private var snapshot: Snapshot?
    // Touched on `queue` only.
    private var pid: pid_t = 0
    private var page: AXUIElement?
    private var handles: [AXUIElement] = []
    private var lastSearch = Date.distantPast
    private var busy = false

    /// The last reading, or nil if there is none (no access, or the page wasn't found).
    var latest: Snapshot? {
        lock.lock(); defer { lock.unlock() }
        return snapshot
    }

    /// Reads again in the background; `latest` has the result on a later tick.
    func refresh(pid: pid_t) {
        guard Self.isTrusted else {
            store(nil)
            return
        }
        queue.async { [self] in
            guard !busy else { return }
            busy = true
            defer { busy = false }
            store(read(pid: pid))
        }
    }

    private func store(_ s: Snapshot?) {
        lock.lock(); snapshot = s; lock.unlock()
    }

    private func read(pid: pid_t) -> Snapshot? {
        if pid != self.pid {
            self.pid = pid
            page = nil
            handles = []
            lastSearch = .distantPast
            // Chromium-based apps only build their page's outline once something asks for it.
            AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        var title = page.flatMap { Self.string($0, kAXTitleAttribute) }
        var frames = handles.compactMap(Self.frame)
        // Look again when the page went stale (another session, a reload) or a handle came or went
        // (the sidebar or a pane opened or closed), but not more than once a second.
        let stale = title == nil || title!.isEmpty || frames.count != handles.count
        if stale || Date().timeIntervalSince(lastSearch) > 2 {
            if Date().timeIntervalSince(lastSearch) > 1 {
                search(pid: pid)
                title = page.flatMap { Self.string($0, kAXTitleAttribute) }
                frames = handles.compactMap(Self.frame)
            }
        }
        guard let title, !title.isEmpty else { return nil }
        guard let window = Self.frontWindowFrame(pid: pid) else { return Snapshot(pageTitle: title) }
        let left = frames.filter { $0.midX < window.midX }.max { $0.minX < $1.minX }
        let right = frames.filter { $0.midX > window.midX }.min { $0.minX < $1.minX }
        return Snapshot(pageTitle: title, sidebarHandle: left, paneHandle: right)
    }

    /// Breadth first through the front window: the named web page, and every resize handle.
    private func search(pid: pid_t) {
        lastSearch = Date()
        page = nil
        handles = []
        let app = AXUIElementCreateApplication(pid)
        guard let window = Self.element(app, kAXFocusedWindowAttribute) ?? (Self.value(app, kAXWindowsAttribute) as? [AXUIElement])?.first else { return }
        var queue: [AXUIElement] = [window]
        var visited = 0
        while !queue.isEmpty, visited < 5000 {
            let e = queue.removeFirst()
            visited += 1
            switch Self.string(e, kAXRoleAttribute) {
            case "AXWebArea":
                if page == nil, let t = Self.string(e, kAXTitleAttribute), !t.isEmpty { page = e }
            case "AXSplitter":
                handles.append(e)
            default:
                break
            }
            queue.append(contentsOf: (Self.value(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [])
        }
    }

    private static func frontWindowFrame(pid: pid_t) -> CGRect? {
        let app = AXUIElementCreateApplication(pid)
        return (element(app, kAXFocusedWindowAttribute) ?? (value(app, kAXWindowsAttribute) as? [AXUIElement])?.first).flatMap(frame)
    }

    private static func value(_ e: AXUIElement, _ attribute: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, attribute as CFString, &v) == .success ? v : nil
    }

    private static func element(_ e: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let v = value(e, attribute), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    private static func string(_ e: AXUIElement, _ attribute: String) -> String? {
        value(e, attribute) as? String
    }

    private static func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = value(e, kAXPositionAttribute), let s = value(e, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: origin, size: size)
    }
}
