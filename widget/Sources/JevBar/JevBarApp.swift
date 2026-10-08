import AppKit
import SwiftUI

@main
struct JevBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: delegate.model, pill: delegate.pill, launcher: delegate.launcher)
        } label: {
            // The menu bar keeps it short: an icon and the model's family name.
            HStack(spacing: 3) {
                Image(systemName: delegate.model.menuIcon)
                Text(delegate.model.shortModel)
            }
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    // Owned here rather than by the App so the floating icon can come back at launch,
    // before anyone has opened the menu bar panel.
    let model = AppModel()
    let pill = PillController()
    let launcher = LauncherController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The bundle sets LSUIElement; this covers `swift run JevBar` without a bundle.
        NSApp.setActivationPolicy(.accessory)
        launcher.restore(model: model)
    }
}
