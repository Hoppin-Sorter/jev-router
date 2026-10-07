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

try? FileManager.default.removeItem(at: scratch)
print("\(passed) checks passed, \(failures) failed")
exit(failures == 0 ? 0 : 1)
