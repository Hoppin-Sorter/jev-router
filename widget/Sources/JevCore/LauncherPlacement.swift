import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Where the floating icon sits over the Claude window, and when it shows. Plain geometry
/// and rules, so JevCoreChecks can test them without any windows open.
public enum LauncherPlacement {
    /// The icon's spot relative to a window: `x` is how far across the window its centre is
    /// (0 left edge, 1 right edge) and `fromBottom` how many points its bottom edge is above the
    /// window's bottom. Kept this way the icon stays over the reply box when the window moves,
    /// and keeps its place across the width when the window is resized.
    public struct Anchor: Equatable {
        public var x: Double
        public var fromBottom: Double

        public init(x: Double, fromBottom: Double) {
            self.x = x
            self.fromBottom = fromBottom
        }

        /// Middle of the window, low down: about where a full-size window's reply box sits.
        public static let standard = Anchor(x: 0.5, fromBottom: 100)
    }

    /// Windows smaller than this are not the conversation window (a quick-entry bar, a popover).
    public static let minimumWindow = CGSize(width: 400, height: 300)
    /// How far the icon stays in from the window's edges.
    public static let inset: CGFloat = 4

    public static func anchor(of icon: CGRect, in window: CGRect) -> Anchor {
        guard window.width > 0 else { return .standard }
        let x = (icon.midX - window.minX) / window.width
        return Anchor(x: min(max(Double(x), 0), 1), fromBottom: max(Double(icon.minY - window.minY), 0))
    }

    /// The icon's frame for an anchor, kept inside the window.
    public static func frame(for anchor: Anchor, size: CGFloat, in window: CGRect) -> CGRect {
        let lowX = window.minX + inset
        let highX = max(window.maxX - size - inset, lowX)
        let lowY = window.minY + inset
        let highY = max(window.maxY - size - inset, lowY)
        let x = window.minX + CGFloat(anchor.x) * window.width - size / 2
        let y = window.minY + CGFloat(anchor.fromBottom)
        return CGRect(x: min(max(x, lowX), highX), y: min(max(y, lowY), highY), width: size, height: size)
    }

    /// The window to follow: the first of `windows` (front to back) big enough to be the conversation.
    public static func mainWindow(among windows: [CGRect]) -> CGRect? {
        windows.first { $0.width >= minimumWindow.width && $0.height >= minimumWindow.height }
    }

    /// Window bounds from CGWindowList (origin at the top left of the main display, y down) in
    /// AppKit's screen coordinates (origin at its bottom left, y up).
    public static func appKitRect(fromCG rect: CGRect, mainDisplayHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: mainDisplayHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    /// Whether the icon is on screen. Confined, it shows only while Claude is the front app and
    /// has a window to float over. While Jev Bar itself is in front, say its menu bar panel is
    /// open, nothing changes, so using Jev Bar doesn't make the icon blink away.
    public static func shouldShow(confined: Bool, claudeFrontmost: Bool, ownAppFrontmost: Bool, hasWindow: Bool, wasShowing: Bool) -> Bool {
        if !confined { return true }
        if ownAppFrontmost { return wasShowing }
        return claudeFrontmost && hasWindow
    }
}
