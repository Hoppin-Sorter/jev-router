import AppKit
import JevCore
import Observation
import SwiftUI

/// The pop-out: a small always-on-top pill with the model, focus and today's savings.
/// Drag it anywhere; it follows you across Spaces and over full-screen apps.
@MainActor
@Observable
final class PillController {
    @ObservationIgnored private var panel: NSPanel?
    private(set) var isShown = false

    func toggle(model: AppModel) {
        if let panel {
            panel.close()
            self.panel = nil
            isShown = false
            return
        }
        let panel = PillPanel(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 34),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        let host = NSHostingView(rootView: PillView(model: model) { [weak self] in self?.toggle(model: model) })
        // The default sizing options pin the window to the pill's size as the text changes.
        panel.contentView = host
        panel.setContentSize(host.fittingSize)
        if !panel.setFrameUsingName("JevPill"), let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.maxX - 320, y: f.maxY - 54))
        }
        panel.setFrameAutosaveName("JevPill")
        panel.orderFrontRegardless()
        self.panel = panel
        isShown = true
    }
}

/// Borderless panels can't take clicks on their buttons unless they may become key.
private final class PillPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

struct PillView: View {
    let model: AppModel
    let close: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: model.menuIcon)
            Text(model.mode == .off ? "Off" : model.modelName).fontWeight(.semibold)
            Text("·").foregroundStyle(.secondary)
            Text(model.focusLabel).foregroundStyle(.secondary)
            if let today = model.savings[.today] {
                Text("·").foregroundStyle(.secondary)
                Text("\(today.saved >= 0 ? "saved" : "cost") \(Money.format(abs(today.saved))) today")
                    .foregroundStyle(today.saved >= 0 ? .green : .orange)
                    .monospacedDigit()
            }
            Button(action: close) { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("Close the pop-out")
        }
        .font(.callout)
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: Capsule())
        .fixedSize()
    }
}
