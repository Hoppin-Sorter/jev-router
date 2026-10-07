import AppKit
import Foundation
import JevCore
import Observation

enum Card: String, CaseIterable, Identifiable {
    case now = "Now"
    case focus = "Focus"
    case saved = "Saved"
    case recent = "Recent"

    var id: String { rawValue }
}

/// Everything the panel and the pill show, read from ~/.config/jev and the Claude Code
/// transcripts. Small files are polled; the transcript scan runs once a minute, off the main thread.
@MainActor
@Observable
final class AppModel {
    private(set) var settings = SharedSettings()
    private(set) var last: LastState?
    /// Newest first, at most five. Decisions carry no prompt text.
    private(set) var recent: [Decision] = []
    private(set) var savings: [SavingsWindow: SavingsSummary] = [:]
    private(set) var savingsUpdated: Date?
    private(set) var writeError: String?
    var savingsWindow: SavingsWindow = .today
    private(set) var hiddenCards: Set<String>

    let store = ConfigStore()
    @ObservationIgnored private var decisions: [Decision] = []
    @ObservationIgnored private var decisionsDate: Date?
    @ObservationIgnored private var scanning = false
    @ObservationIgnored private var lastScan = Date.distantPast
    @ObservationIgnored private var timer: Timer?
    private let scanner: UsageScanner = {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return UsageScanner(cacheURL: caches.appendingPathComponent("jev-bar/usage-cache.json"))
    }()

    init() {
        hiddenCards = Set(UserDefaults.standard.stringArray(forKey: "hiddenCards") ?? [])
        refresh()
        let timer = Timer(timeInterval: 1.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // .common so it keeps firing while the panel is open.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        refreshSavings()
    }

    // MARK: Reading

    private func tick() {
        refresh()
        if Date().timeIntervalSince(lastScan) > 60 { refreshSavings() }
    }

    func refresh() {
        if let s = store.readSettings() { settings = s }
        last = store.readLast()
        let date = store.modificationDate(store.decisionsURL)
        if date != decisionsDate {
            decisionsDate = date
            decisions = store.readDecisions()
            recent = Array(decisions.suffix(5).reversed())
        }
    }

    func refreshSavings() {
        guard !scanning else { return }
        scanning = true
        lastScan = Date()
        let scanner = scanner
        let decisions = decisions
        Task.detached(priority: .utility) {
            let now = Date()
            let usage = scanner.scan(since: SavingsWindow.month.start(now: now))
            var result: [SavingsWindow: SavingsSummary] = [:]
            for w in SavingsWindow.allCases {
                result[w] = SavingsSummary.make(usage: usage, decisions: decisions, window: w, now: now)
            }
            await MainActor.run {
                self.savings = result
                self.savingsUpdated = now
                self.scanning = false
            }
        }
    }

    // MARK: What the panel shows

    var mode: RouterMode { settings.mode }
    var decision: Decision? { last?.decision }
    var session: String? { last?.session.isEmpty == false ? last?.session : nil }

    var modelName: String {
        guard let id = decision?.model else { return "No decision yet" }
        return Pricing.model(for: id)?.name ?? id
    }

    var shortModel: String {
        if mode == .off { return "Off" }
        guard let id = decision?.model else { return "Jev" }
        return Pricing.model(for: id)?.short ?? "Jev"
    }

    var menuIcon: String {
        switch mode {
        case .off: return "pause.circle"
        case .shadow: return "eye"
        case .auto: return "arrow.triangle.branch"
        }
    }

    var focusLabel: String { SharedSettings.focusLabels[max(0, min(4, settings.focus))] }
    var canNudge: Bool { mode != .off && session != nil }

    // MARK: Writing

    private func write(_ change: (inout SharedSettings) -> Void) {
        do {
            settings = try store.updateSettings(change)
            writeError = nil
        } catch {
            writeError = "Couldn't save to \(store.settingsURL.path): \(error.localizedDescription)"
        }
    }

    func setMode(_ m: RouterMode) { write { $0.mode = m } }
    func setFocus(_ f: Int) { write { $0.focus = max(0, min(4, f)) } }
    func setEffort(_ on: Bool) { write { $0.effort = on } }
    func setSkills(_ on: Bool) { write { $0.skills = on } }
    func setSpecialists(_ on: Bool) { write { $0.specialists = on } }

    /// Moves the latest session's model one tier down (−1) or up (+1), applied on its next request.
    func nudge(_ by: Int) {
        guard let session else { return }
        write { $0.nudge = Nudge(target: session, by: by) }
    }

    func isVisible(_ card: Card) -> Bool { !hiddenCards.contains(card.rawValue) }

    func setVisible(_ card: Card, _ on: Bool) {
        if on { hiddenCards.remove(card.rawValue) } else { hiddenCards.insert(card.rawValue) }
        UserDefaults.standard.set(Array(hiddenCards), forKey: "hiddenCards")
    }
}
