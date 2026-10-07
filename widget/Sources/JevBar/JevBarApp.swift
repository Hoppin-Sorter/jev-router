import AppKit
import SwiftUI

@main
struct JevBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            PanelView(model: model, pill: delegate.pill)
        } label: {
            // The menu bar keeps it short: an icon and the model's family name.
            HStack(spacing: 3) {
                Image(systemName: model.menuIcon)
                Text(model.shortModel)
            }
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let pill = PillController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The bundle sets LSUIElement; this covers `swift run JevBar` without a bundle.
        NSApp.setActivationPolicy(.accessory)
    }
}
