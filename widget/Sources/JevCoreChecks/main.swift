import Foundation
import JevCore

// `swift run JevCoreChecks` from widget/: checks JevCore's pure logic against Fixtures/.
// Exits non-zero on any failure. No XCTest or Swift Testing, so it runs with only the
// Command Line Tools installed.

var failures = 0
var passed = 0

func check(_ ok: @autoclosure () -> Bool, _ what: String, file: StaticString = #fileID, line: UInt = #line) {
    if ok() {
        passed += 1
    } else {
        failures += 1
        print("FAIL \(file):\(line)  \(what)")
    }
}

func near(_ a: Double, _ b: Double, _ tolerance: Double = 1e-9) -> Bool { abs(a - b) <= tolerance }

let fixtures: URL = {
    // widget/Sources/JevCoreChecks/main.swift -> widget/Fixtures
    let here = URL(fileURLWithPath: #filePath)
    return here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures")
}()

let expected = try! JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("expected.json"))) as! [String: Any]
let now = ISO8601DateFormatter().date(from: expected["now"] as! String)!
var utc = Calendar(identifier: .gregorian)
utc.timeZone = TimeZone(identifier: "UTC")!

// MARK: Pricing

for (id, key) in expected["models"] as! [String: Any] {
    check(Pricing.model(for: id)?.key == key as? String, "model \(id) → \(key)")
}
do {
    let opus = Pricing.baseline.price
    check(near(Pricing.cost(Usage(input: 1_000_000), at: opus), 4), "Opus 5.5 input $4/Mtok")
    check(near(Pricing.cost(Usage(output: 1_000_000), at: opus), 20), "Opus 5.5 output $20/Mtok")
    check(near(Pricing.cost(Usage(cacheRead: 1_000_000), at: opus), 0.20), "Opus 5.5 cache read $0.20/Mtok")
    check(near(Pricing.cost(Usage(cacheWrite5m: 1_000_000), at: opus), 5), "5-minute cache write is 1.25x input")
    check(near(Pricing.cost(Usage(cacheWrite1h: 1_000_000), at: opus), 8), "1-hour cache write is 2x input")
    let haiku = Pricing.model(for: "claude-haiku-4-5-20251001")!.price
    check(near(Pricing.cost(Usage(input: 1000, output: 500, cacheRead: 20000, cacheWrite5m: 4000), at: haiku), 0.0105), "Haiku request")
    check(near(Pricing.jevPerMTok, 0.042), "Jev price")
    check(Money.format(1.234) == "$1.23", "money ≥ $1")
    check(Money.format(0.0123) == "$0.012", "money cents")
    check(Money.format(-0.00012) == "−$0.0001", "money tiny negative")
}

// MARK: Transcript usage and the mtime cache

let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("jevcore-checks-\(UUID().uuidString)")
// copyItem needs the destination's parent to exist.
try! FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
try! FileManager.default.copyItem(at: fixtures.appendingPathComponent("projects"), to: scratch.appendingPathComponent("projects"))

let cacheURL = scratch.appendingPathComponent("cache/usage.json")
let scanner = UsageScanner(root: scratch.appendingPathComponent("projects"), cacheURL: cacheURL)
let all = scanner.scan(since: .distantPast)
check(all.count == expected["distinctRequests"] as! Int, "distinct requests: got \(all.count)")
check(scanner.filesParsed == 3, "first scan reads the three transcripts, got \(scanner.filesParsed)")
let msg2 = all.first { $0.key == "msg_2|req_2" }
check(msg2?.usage == Usage(input: 2000, output: 3000, cacheRead: 100_000, cacheWrite5m: 6000, cacheWrite1h: 4000), "cache write split")
check(all.first { $0.key == "msg_3|req_3" }?.usage.cacheWrite5m == 2000, "no split: all 5-minute")

_ = scanner.scan(since: .distantPast)
check(scanner.filesParsed == 0, "unchanged files come from the cache, got \(scanner.filesParsed)")
let reloaded = UsageScanner(root: scratch.appendingPathComponent("projects"), cacheURL: cacheURL)
_ = reloaded.scan(since: .distantPast)
check(reloaded.filesParsed == 0, "the cache survives a restart, got \(reloaded.filesParsed)")

let s2 = scratch.appendingPathComponent("projects/proj-b/s2.jsonl")
let extra = #"{"type":"assistant","requestId":"req_9","timestamp":"2026-10-07T17:00:00Z","message":{"id":"msg_9","model":"claude-sonnet-5-5","usage":{"input_tokens":10,"output_tokens":10}}}"#
let handle = try! FileHandle(forWritingTo: s2)
handle.seekToEndOfFile()
handle.write(Data((extra + "\n").utf8))
try! handle.close()
let grown = scanner.scan(since: .distantPast)
check(scanner.filesParsed == 1, "a changed file is read again, got \(scanner.filesParsed)")
check(grown.count == all.count + 1, "the new request is counted")

// MARK: Savings windows

let decisions = Decision.parseLines(try! Data(contentsOf: fixtures.appendingPathComponent("config/decisions.jsonl")))
check(decisions.count == 5, "decisions.jsonl skips the junk line, got \(decisions.count)")
for (name, raw) in expected["windows"] as! [String: [String: Any]] {
    let window = SavingsWindow(rawValue: name)!
    let s = SavingsSummary.make(usage: all, decisions: decisions, window: window, now: now, calendar: utc)
    check(near(s.actual, raw["actual"] as! Double), "\(name) actual \(s.actual)")
    check(near(s.baseline, raw["baseline"] as! Double), "\(name) baseline \(s.baseline)")
    check(near(s.jev, raw["jev"] as! Double, 1e-12), "\(name) jev \(s.jev)")
    check(near(s.saved, (raw["baseline"] as! Double) - (raw["actual"] as! Double) - (raw["jev"] as! Double)), "\(name) saved")
    check(s.requests == raw["requests"] as! Int && s.unpriced == raw["unpriced"] as! Int, "\(name) request counts")
    let mix = (raw["mix"] as! [[Any]]).map { "\($0[0]):\($0[1])" }
    check(s.mix.map { "\($0.key):\($0.requests)" } == mix, "\(name) mix \(s.mix.map(\.key))")
}

// MARK: Water and CO₂ (display-only estimate)

do {
    let f = expected["impactFactors"] as! [String: Double]
    check(ImpactFactors.standard == ImpactFactors(whPerUSD: f["whPerUSD"]!, litersPerKWh: f["litersPerKWh"]!, kgCO2PerKWh: f["kgCO2PerKWh"]!), "impact factors")
    for (name, raw) in expected["impact"] as! [String: [String: Any]] {
        let s = SavingsSummary.make(usage: all, decisions: decisions, window: SavingsWindow(rawValue: name)!, now: now, calendar: utc)
        let i = s.impactSaved
        check(near(s.saved, raw["saved"] as! Double), "\(name) saved for impact \(s.saved)")
        check(near(i.energyWh, raw["energyWh"] as! Double), "\(name) energy \(i.energyWh)")
        check(near(i.waterL, raw["waterL"] as! Double, 1e-12), "\(name) water \(i.waterL)")
        check(near(i.co2Kg, raw["co2Kg"] as! Double, 1e-12), "\(name) CO2 \(i.co2Kg)")
        check(Impact.water(i.waterL) == raw["water"] as! String, "\(name) water text \(Impact.water(i.waterL))")
        check(Impact.co2(i.co2Kg) == raw["co2"] as! String, "\(name) CO2 text \(Impact.co2(i.co2Kg))")
        check(Impact.everyday(i.energyWh) == raw["everyday"] as? String, "\(name) everyday \(Impact.everyday(i.energyWh) ?? "nil")")
    }
    check(SavingsWindow.impactDefault == .month, "the water and CO2 line defaults to 30 days")
    check(Impact.everyday(0) == nil, "nothing to compare")
    check(Impact.everyday(0.1) == "like an LED bulb on for under a minute", "under a minute of LED")
    check(Impact.everyday(14.9) == "like an LED bulb on for 89 min", "LED minutes up to a phone charge")
    check(Impact.everyday(15) == "like 1 phone charge", "phone charges from 15 Wh")
    check(Impact.everyday(-20) == "like 1.3 phone charges", "size only, one decimal")
    check(Impact.everyday(149.5) == "like 10 phone charges" && Impact.everyday(600) == "like 40 phone charges", "whole charges from 10")
    check(Impact.water(1.2) == "≈ 1.2 L" && Impact.co2(0.045) == "≈ 45 g", "water and CO2 units")
    check(Impact.energy(0.338976) == "≈ 0.34 Wh" && Impact.energy(1500) == "≈ 1.5 kWh", "energy text")
    check(Impact(usd: 0).waterL == 0, "nothing saved, nothing claimed")
}

// MARK: The ~/.config/jev contract

let store = ConfigStore(dir: scratch.appendingPathComponent("config"))
try! FileManager.default.copyItem(at: fixtures.appendingPathComponent("config"), to: store.dir)
let settings = store.readSettings()
check(settings?.mode == .shadow && settings?.focus == 3 && settings?.effort == true && settings?.skills == false, "settings.json fields")
check(settings?.nudge == Nudge(target: "sess-a", by: -1, id: "n-1"), "settings.json nudge")
check(SharedSettings.parse(Data("nope".utf8)) == nil, "junk settings are rejected")
let lenient = SharedSettings.parse(Data(#"{"mode":"sideways","focus":9,"effort":"yes","nudge":{"target":"s","by":3,"id":"x"}}"#.utf8))
check(lenient?.mode == .auto && lenient?.focus == 2 && lenient?.effort == false && lenient?.nudge == nil, "bad fields take defaults")

let before = settings!.updatedAt
let written = try! store.updateSettings(now: Date(timeIntervalSince1970: 1)) { $0.focus = 0 }
check(written.updatedAt == before + 1, "a write is newer than the file even with a slow clock")
check(written.updatedBy == "widget", "the widget signs its writes")
let back = store.readSettings()
check(back?.focus == 0 && back?.mode == .shadow && back?.nudge?.id == "n-1", "a write keeps the other fields")
let savedJSON = try! JSONSerialization.jsonObject(with: Data(contentsOf: store.settingsURL)) as! [String: Any]
check(savedJSON["version"] as? Int == 1 && savedJSON["mode"] as? String == "shadow", "the plugin's field names")

let fresh = ConfigStore(dir: scratch.appendingPathComponent("new/jev"))
check(fresh.readSettings() == nil && fresh.readLast() == nil && fresh.readDecisions().isEmpty, "a missing folder reads as empty")
try! fresh.updateSettings { $0.nudge = Nudge(target: "sess-b", by: 1) }
check(fresh.readSettings()?.nudge?.target == "sess-b", "writing creates the folder")

let last = store.readLast()
check(last?.session == "sess-a" && last?.working == true && last?.mode == .shadow, "last.json")
check(last?.decision?.shadow == true && last?.decision?.subject == "science", "last.json decision")
check(decisions.last?.skill == nil && decisions[3].skill == "data:sql-queries", "decision fields")

// MARK: Floating icon placement

do {
    typealias P = LauncherPlacement
    let size: CGFloat = 28
    // CGWindowList bounds → AppKit: a full-size window under a 33pt menu bar on a 982pt display.
    let full = P.appKitRect(fromCG: CGRect(x: 0, y: 33, width: 1512, height: 949), mainDisplayHeight: 982)
    check(full == CGRect(x: 0, y: 0, width: 1512, height: 949), "CG window bounds flip to AppKit")
    let upper = P.appKitRect(fromCG: CGRect(x: 100, y: 100, width: 800, height: 600), mainDisplayHeight: 982)
    check(upper == CGRect(x: 100, y: 282, width: 800, height: 600), "a window near the top sits high in AppKit")

    let spot = P.frame(for: .standard, size: size, in: full)
    check(spot == CGRect(x: 742, y: 100, width: 28, height: 28), "the standard anchor: centred, 100 up")
    check(P.anchor(of: spot, in: full) == .standard, "an icon's anchor round-trips")

    // The window moves and shrinks: the icon keeps its place in it.
    let moved = CGRect(x: 200, y: -50, width: 756, height: 700)
    let followed = P.frame(for: P.anchor(of: spot, in: full), size: size, in: moved)
    check(followed.midX == moved.midX && followed.minY == moved.minY + 100, "the icon follows the window")
    let left = P.anchor(of: CGRect(x: 300, y: 250, width: 28, height: 28), in: full)
    check(near(left.x, 314.0 / 1512.0) && near(left.fromBottom, 250), "anchor from a dragged spot")

    // Never outside the window, even for an anchor past the edge or a window smaller than the icon.
    let edge = P.frame(for: P.Anchor(x: 1, fromBottom: 5000), size: size, in: full)
    check(edge.maxX == full.maxX - P.inset && edge.maxY == full.maxY - P.inset, "clamped inside the window")
    let low = P.frame(for: P.Anchor(x: 0, fromBottom: 0), size: size, in: full)
    check(low.minX == P.inset && low.minY == P.inset, "clamped to the near edges too")
    let tiny = P.frame(for: .standard, size: size, in: CGRect(x: 10, y: 10, width: 20, height: 20))
    check(tiny.origin == CGPoint(x: 14, y: 14), "a window smaller than the icon doesn't produce nonsense")
    check(P.anchor(of: spot, in: .zero) == .standard, "a zero-width window gives the standard anchor")

    // Which window to follow: front to back, skipping small ones.
    let quickEntry = CGRect(x: 500, y: 700, width: 520, height: 80)
    check(P.mainWindow(among: [quickEntry, full]) == full, "a small window in front is skipped")
    check(P.mainWindow(among: [quickEntry]) == nil && P.mainWindow(among: []) == nil, "no big window, nothing to follow")
    check(P.mainWindow(among: [upper, full]) == upper, "the front big window wins")

    // When it shows.
    func show(_ confined: Bool, claude: Bool, own: Bool = false, window: Bool = true, was: Bool = false) -> Bool {
        P.shouldShow(confined: confined, claudeFrontmost: claude, ownAppFrontmost: own, hasWindow: window, wasShowing: was)
    }
    check(show(true, claude: true), "Claude in front: shown")
    check(!show(true, claude: false), "another app in front: hidden")
    check(!show(true, claude: true, window: false), "Claude in front but no window (minimised, other Space): hidden")
    check(show(true, claude: false, own: true, was: true), "Jev Bar in front keeps it shown")
    check(!show(true, claude: false, own: true, was: false), "Jev Bar in front keeps it hidden")
    check(show(false, claude: false, window: false) && show(false, claude: false), "not confined: always shown")
    check(!P.shouldShow(confined: true, claudeFrontmost: true, ownAppFrontmost: false, hasWindow: true, inCodeSession: false, wasShowing: true), "Claude in front on a chat: hidden")

    // Code tab or chat, from the page's name.
    check(P.isCodeSession(pageTitle: "jev-router setup - Claude Code"), "a Code session")
    check(!P.isCodeSession(pageTitle: "Trip ideas - Claude") && !P.isCodeSession(pageTitle: "Claude Code tips - Claude"), "a chat, even one about Claude Code")

    // The session's area: right of the sidebar handle (AppKit coordinates, the probe's real window).
    let handle = CGRect(x: 258, y: 0, width: 14, height: 949)
    check(P.sessionArea(window: full, sidebarHandle: handle) == CGRect(x: 272, y: 0, width: 1240, height: 949), "right of the sidebar")
    check(P.sessionArea(window: full, sidebarHandle: nil) == full, "sidebar collapsed: the whole window")
    check(P.sessionArea(window: full, sidebarHandle: CGRect(x: 0, y: 0, width: 14, height: 949)) == full, "a handle at the very left counts as collapsed")
    check(P.sessionArea(window: full, sidebarHandle: CGRect(x: 1400, y: 0, width: 14, height: 949)) == full, "a handle on the right isn't the sidebar's")
    let pane = CGRect(x: 1100, y: 0, width: 14, height: 949)
    check(P.sessionArea(window: full, sidebarHandle: handle, paneHandle: pane) == CGRect(x: 272, y: 0, width: 828, height: 949), "left of an open side pane")
    check(P.sessionArea(window: full, sidebarHandle: nil, paneHandle: pane).minX == 0, "a pane with the sidebar collapsed")
    let inArea = P.frame(for: .standard, size: size, in: P.sessionArea(window: full, sidebarHandle: handle))
    check(inArea.minX >= 272 && inArea.midX == 272 + 620, "the icon centres in the session area, not the window")
}

try? FileManager.default.removeItem(at: scratch)
print("\(passed) checks passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
