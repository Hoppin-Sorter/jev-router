import AppKit
import JevCore
import Observation
import SwiftUI

/// A small always-on-top icon you can park anywhere, say just above Claude's reply box.
/// Click it and it turns into a close button with a dial above it: the focus slider and
/// switches for the router, effort, skills and specialists. Drag the icon to move it.
/// Off until it's turned on under ⋯ → Floating icon, and remembered after that.
///
/// By default it belongs to the Claude window: it shows only while the Claude app is in front,
/// moves and resizes with that window, and is gone when you switch to another app. It can't tell
/// a Code session from a chat, since macOS gives other apps a window's size and place but not its
/// title without Screen Recording access. ⋯ → Only show over Claude turns the confinement off.
@MainActor
@Observable
final class LauncherController {
    static let size: CGFloat = 28
    static let claudeBundleID = "com.anthropic.claudefordesktop"

    @ObservationIgnored private var panel: NSPanel?
    @ObservationIgnored private var dial: NSPanel?
    @ObservationIgnored private var tracker: Timer?
    /// Claude's conversation window in AppKit screen coordinates, as of the last look.
    @ObservationIgnored private var claudeWindow: CGRect?
    @ObservationIgnored private var anchor = LauncherController.savedAnchor()
    private(set) var isShown = false
    private(set) var isOpen = false
    private(set) var onlyInClaude = UserDefaults.standard.object(forKey: "launcherOnlyInClaude") as? Bool ?? true

    func restore(model: AppModel) {
        if UserDefaults.standard.bool(forKey: "showLauncher") { show(model: model) }
    }

    func toggle(model: AppModel) {
        if isShown { hide() } else { show(model: model) }
        UserDefaults.standard.set(isShown, forKey: "showLauncher")
    }

    private func show(model: AppModel) {
        guard panel == nil else { return }
        let size = NSSize(width: Self.size, height: Self.size)
        let panel = Self.floatingPanel(size: size)
        panel.hasShadow = false
        // One level above the dial: a click in the dial brings it forward, and the X under the
        // icon must still take the next click.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)

        let view = LauncherView(frame: NSRect(origin: .zero, size: size))
        view.toolTip = "Jev: click for the dial, drag to move"
        let icon = NSHostingView(rootView: LauncherIcon(model: model, launcher: self))
        icon.frame = view.bounds
        icon.autoresizingMask = [.width, .height]
        view.addSubview(icon)
        view.onClick = { [weak self] in self?.toggleDial(model: model) }
        view.onMove = { [weak self] in self?.moved() }
        view.onMoveEnd = { [weak self] in self?.saveAnchor() }
        panel.contentView = view

        // The first time, low in the middle of the main screen, about where a full-size
        // window's reply box sits; after that wherever it was left.
        if !panel.setFrameUsingName("JevLauncher"), let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.minY + 100))
        }
        panel.setFrameAutosaveName("JevLauncher")
        self.panel = panel
        isShown = true
        startTracking()
        refresh()
    }

    private func hide() {
        stopTracking()
        closeDial()
        dial?.close()
        dial = nil
        panel?.close()
        panel = nil
        isShown = false
    }

    private func toggleDial(model: AppModel) {
        if isOpen {
            closeDial()
            return
        }
        let dial = self.dial ?? makeDial(model: model)
        self.dial = dial
        placeDial()
        dial.orderFrontRegardless()
        isOpen = true
    }

    private func closeDial() {
        dial?.orderOut(nil)
        isOpen = false
    }

    func setOnlyInClaude(_ on: Bool) {
        // Turning it on with the icon already over Claude keeps it there.
        if on, let panel, let window = Self.claudeWindowNow(), window.intersects(panel.frame) {
            anchor = LauncherPlacement.anchor(of: panel.frame, in: window)
            saveAnchor()
        }
        onlyInClaude = on
        UserDefaults.standard.set(on, forKey: "launcherOnlyInClaude")
        refresh()
    }

    // MARK: Following Claude

    private func startTracking() {
        guard tracker == nil else { return }
        // Where a window is can't be observed without Accessibility access, so look ten times a second.
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        RunLoop.main.add(timer, forMode: .common)
        tracker = timer
    }

    private func stopTracking() {
        tracker?.invalidate()
        tracker = nil
    }

    /// Shows or hides the icon (and the dial, if it's open) and keeps it over the Claude window.
    private func refresh() {
        guard let panel else { return }
        let front = NSWorkspace.shared.frontmostApplication
        claudeWindow = onlyInClaude ? Self.claudeWindowNow() : nil
        let showing = LauncherPlacement.shouldShow(
            confined: onlyInClaude,
            claudeFrontmost: front?.bundleIdentifier == Self.claudeBundleID,
            ownAppFrontmost: front?.processIdentifier == ProcessInfo.processInfo.processIdentifier,
            hasWindow: claudeWindow != nil,
            wasShowing: panel.isVisible
        )
        if showing {
            if let window = claudeWindow {
                let origin = LauncherPlacement.frame(for: anchor, size: Self.size, in: window).origin
                if origin != panel.frame.origin {
                    panel.setFrameOrigin(origin)
                    placeDial()
                }
            }
            if !panel.isVisible {
                panel.orderFrontRegardless()
                if isOpen { dial?.orderFrontRegardless() }
            }
        } else if panel.isVisible {
            dial?.orderOut(nil)
            panel.orderOut(nil)
        }
    }

    /// The icon was dragged: remember its place in the Claude window and bring the dial along.
    private func moved() {
        if let panel, let window = claudeWindow {
            anchor = LauncherPlacement.anchor(of: panel.frame, in: window)
        }
        placeDial()
    }

    private func saveAnchor() {
        UserDefaults.standard.set(anchor.x, forKey: "launcherAnchorX")
        UserDefaults.standard.set(anchor.fromBottom, forKey: "launcherAnchorFromBottom")
    }

    private static func savedAnchor() -> LauncherPlacement.Anchor {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: "launcherAnchorX") != nil else { return .standard }
        return LauncherPlacement.Anchor(x: defaults.double(forKey: "launcherAnchorX"), fromBottom: defaults.double(forKey: "launcherAnchorFromBottom"))
    }

    private static func claudeWindowNow() -> CGRect? {
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: claudeBundleID).first?.processIdentifier else { return nil }
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        // Front to back, ordinary windows only (layer 0), so a stray invisible one doesn't count.
        let windows = info.compactMap { w -> CGRect? in
            guard (w[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let bounds = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
            return CGRect(dictionaryRepresentation: bounds as CFDictionary)
        }
        guard let window = LauncherPlacement.mainWindow(among: windows), let mainDisplay = NSScreen.screens.first else { return nil }
        return LauncherPlacement.appKitRect(fromCG: window, mainDisplayHeight: mainDisplay.frame.height)
    }

    private func makeDial(model: AppModel) -> NSPanel {
        let dial = Self.floatingPanel(size: DialView.size)
        // See-through, so a shadow would only darken the words behind it.
        dial.hasShadow = false
        dial.contentView = NSHostingView(rootView: DialView(model: model))
        return dial
    }

    /// Puts the dial's X spot on the icon. Parked too near a screen edge, the dial is kept on
    /// screen instead, so it no longer lines up with the icon but can still be reached.
    private func placeDial() {
        guard let panel, let dial else { return }
        var origin = NSPoint(
            x: panel.frame.midX - DialView.center.x,
            y: panel.frame.midY - (DialView.size.height - DialView.center.y)
        )
        if let f = (panel.screen ?? NSScreen.main)?.visibleFrame {
            origin.x = min(max(origin.x, f.minX), f.maxX - DialView.size.width)
            origin.y = min(max(origin.y, f.minY), f.maxY - DialView.size.height)
        }
        dial.setFrameOrigin(origin)
    }

    private static func floatingPanel(size: NSSize) -> NSPanel {
        let panel = KeyablePanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        panel.isReleasedWhenClosed = false
        // Clicks land without taking the keyboard, so typing still goes to Claude's reply box.
        panel.becomesKeyOnlyIfNeeded = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        return panel
    }
}

/// Borderless panels can't take clicks on their buttons unless they may become key.
private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// The icon's own mouse handling: a click that barely moves opens or closes the dial, a drag
/// moves the window. Every point inside belongs to this view, so the SwiftUI icon beneath only draws.
private final class LauncherView: NSView {
    var onClick: () -> Void = {}
    var onMove: () -> Void = {}
    var onMoveEnd: () -> Void = {}
    private var dragStart: NSPoint?
    private var originAtStart: NSPoint = .zero
    private var dragged = false

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }

    override func mouseDown(with event: NSEvent) {
        dragStart = NSEvent.mouseLocation
        originAtStart = window?.frame.origin ?? .zero
        dragged = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStart, let window else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - start.x
        let dy = now.y - start.y
        if abs(dx) > 3 || abs(dy) > 3 { dragged = true }
        if dragged {
            window.setFrameOrigin(NSPoint(x: originAtStart.x + dx, y: originAtStart.y + dy))
            onMove()
        }
    }

    override func mouseUp(with event: NSEvent) {
        defer { dragStart = nil }
        if dragged { onMoveEnd() } else { onClick() }
    }
}

/// Closed, a pale blue rounded square with the menu bar's symbol (a branch when routing, an
/// eye in shadow mode, a pause sign when off); open, a round X that closes the dial.
struct LauncherIcon: View {
    let model: AppModel
    let launcher: LauncherController

    var body: some View {
        if launcher.isOpen {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .bold))
                .frame(width: LauncherController.size, height: LauncherController.size)
                .background(.regularMaterial, in: Circle())
                .overlay(Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1))
        } else {
            let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
            Image(systemName: model.menuIcon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.blue)
                .frame(width: LauncherController.size, height: LauncherController.size)
                .background(.regularMaterial, in: shape)
                .background(Color.blue.opacity(0.18), in: shape)
        }
    }
}

/// The dial over the open icon: focus from Task focused (top) to Token efficient (bottom),
/// and four switches. Changes go through AppModel, so they reach settings.json like the panel's.
/// Its background is see-through, so the conversation behind it stays readable.
struct DialView: View {
    /// Wide enough that the longest labels, "Router shadow" and "Specialists on", sit the same
    /// distance from each edge.
    static let size = CGSize(width: 320, height: 272)
    /// Where the icon's centre sits, from the dial's top-left corner.
    static let center = CGPoint(x: 160, y: 242)
    private static let trackTop: CGFloat = 18
    private static let step: CGFloat = 30

    let model: AppModel
    @State private var dragging: Int?

    var body: some View {
        let focus = dragging ?? model.settings.focus
        let labels = SharedSettings.focusLabels
        let x = Self.center.x
        let shape = RoundedRectangle(cornerRadius: 22, style: .continuous)
        ZStack {
            shape.fill(Color(nsColor: .windowBackgroundColor).opacity(0.5))
            shape.strokeBorder(Color.secondary.opacity(0.35), lineWidth: 0.5)

            Capsule()
                .fill(Color.secondary.opacity(0.4))
                .frame(width: 2, height: Self.step * 4)
                .position(x: x, y: Self.trackTop + Self.step * 2)
            ForEach(0..<5) { level in
                let current = level == focus
                Circle()
                    .fill(current ? Color.accentColor : Color(nsColor: .windowBackgroundColor))
                    .overlay(Circle().strokeBorder(current ? Color.accentColor : Color.secondary, lineWidth: 1))
                    .frame(width: current ? 16 : 10, height: current ? 16 : 10)
                    .position(x: x, y: dotY(level))
            }
            Text(labels[4]).onSolid().frame(width: 100, alignment: .trailing).position(x: x - 66, y: dotY(4))
            Text(labels[0]).onSolid().frame(width: 100, alignment: .trailing).position(x: x - 66, y: dotY(0))
            Text(labels[max(0, min(4, focus))])
                .fontWeight(.semibold)
                .foregroundStyle(.primary)
                .onSolid()
                .frame(width: 100, alignment: .leading)
                .position(x: x + 66, y: dotY(focus))
            // Click a dot or drag along the line; the choice is saved when you let go.
            Color.clear
                .contentShape(Rectangle())
                .frame(width: 44, height: Self.step * 4 + 24)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { dragging = level(at: $0.location.y) }
                        .onEnded {
                            model.setFocus(level(at: $0.location.y))
                            dragging = nil
                        }
                )
                .position(x: x, y: Self.trackTop + Self.step * 2)
                .help("Focus: Task focused at the top, Token efficient at the bottom")

            switchButton(
                "Router \(routerWord)", symbol: routerSymbol, state: routerState,
                at: CGPoint(x: x - 100, y: 232), help: "Router: on, then shadow, then off"
            ) { model.setMode(nextMode) }
            switchButton(
                "Effort \(onOff(model.settings.effort))", symbol: "brain", state: model.settings.effort ? .on : .off,
                at: CGPoint(x: x - 54, y: 184), help: "Set reasoning effort with the model"
            ) { model.setEffort(!model.settings.effort) }
            switchButton(
                "Skills \(onOff(model.settings.skills))", symbol: "puzzlepiece", state: model.settings.skills ? .on : .off,
                at: CGPoint(x: x + 54, y: 184), help: "Hint the installed skill Jev picks"
            ) { model.setSkills(!model.settings.skills) }
            switchButton(
                "Specialists \(onOff(model.settings.specialists))", symbol: "flask", state: model.settings.specialists ? .on : .off,
                at: CGPoint(x: x + 100, y: 232), help: "Let Fable take hard science and math"
            ) { model.setSpecialists(!model.settings.specialists) }
        }
        .font(.caption2)
        .foregroundStyle(Color.primary.opacity(0.8))
        .frame(width: Self.size.width, height: Self.size.height)
    }

    private func dotY(_ level: Int) -> CGFloat { Self.trackTop + CGFloat(4 - level) * Self.step }

    /// The level nearest a point on the drag area, which starts 12 points above the top dot.
    private func level(at y: CGFloat) -> Int { max(0, min(4, 4 - Int(((y - 12) / Self.step).rounded()))) }

    private func onOff(_ on: Bool) -> String { on ? "on" : "off" }

    private var routerState: SwitchState { model.mode == .auto ? .on : model.mode == .shadow ? .shadow : .off }
    private var routerWord: String { model.mode == .auto ? "on" : model.mode == .shadow ? "shadow" : "off" }
    private var routerSymbol: String { model.mode == .auto ? "arrow.triangle.branch" : model.mode == .shadow ? "eye" : "pause" }
    /// On, then shadow, then off, then on again: what the old control bar's Router button did.
    private var nextMode: RouterMode { model.mode == .auto ? .shadow : model.mode == .shadow ? .off : .auto }

    enum SwitchState {
        case on, shadow, off

        var tint: Color { self == .on ? .accentColor : self == .shadow ? .orange : .secondary }
    }

    private func switchButton(
        _ title: String, symbol: String, state: SwitchState, at point: CGPoint, help: String,
        action: @escaping () -> Void
    ) -> some View {
        Group {
            Button(action: action) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(state.tint)
                    .frame(width: 32, height: 32)
                    .background(state == .off ? Color.primary.opacity(0.04) : state.tint.opacity(0.18), in: Circle())
                    // A solid base, so the words behind don't run through the symbol.
                    .background(Color(nsColor: .windowBackgroundColor), in: Circle())
                    .overlay(Circle().strokeBorder(state.tint.opacity(state == .off ? 0.5 : 0.7), lineWidth: 1))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(help)
            .position(point)
            Text(title).fixedSize().onSolid().position(x: point.x, y: point.y + 26)
        }
    }
}

private extension View {
    /// A solid backing for the dial's words, so they read clearly over the conversation behind
    /// the see-through dial.
    func onSolid() -> some View {
        padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Color(nsColor: .windowBackgroundColor).opacity(0.92), in: Capsule())
    }
}
