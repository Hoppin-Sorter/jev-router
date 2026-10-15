import Foundation

// The files the jev-router plugin and this widget share in ~/.config/jev/.
// lib/contract.ts in the plugin is the other half; keep the two in step.
//
//   settings.json    both write it; the newer updatedAt wins.
//   last.json        the plugin writes it: the latest decision and whether a turn is running.
//   decisions.jsonl  the plugin appends one decision per line (never prompt text).
//   sessions/<host>.json
//                    the plugin's heartbeat for each Claude desktop session it runs in, named
//                    by the app's id for the session (the one in the page's address).

public enum RouterMode: String, Codable, CaseIterable, Sendable {
    case off, shadow, auto
}

public struct Nudge: Codable, Equatable, Sendable {
    public var target: String
    public var by: Int
    public var id: String

    public init(target: String, by: Int, id: String = UUID().uuidString) {
        self.target = target
        self.by = by
        self.id = id
    }
}

public struct SharedSettings: Equatable, Sendable {
    public var mode: RouterMode = .auto
    /// 0 = token efficient … 4 = task focused.
    public var focus: Int = 2
    public var effort = false
    public var skills = true
    public var specialists = true
    public var nudge: Nudge?
    /// Milliseconds since the epoch.
    public var updatedAt: Double = 0
    public var updatedBy: String?

    public init() {}

    public static let focusLabels = ["Token efficient", "Lean", "Balanced", "Thorough", "Task focused"]

    /// Lenient, like the plugin: a bad field takes its default; text that is not a JSON object gives nil.
    public static func parse(_ data: Data) -> SharedSettings? {
        guard let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        var s = SharedSettings()
        if let m = raw["mode"] as? String, let mode = RouterMode(rawValue: m) { s.mode = mode }
        if let f = raw["focus"] as? Int, (0...4).contains(f) { s.focus = f }
        let flags: [(String, WritableKeyPath<SharedSettings, Bool>)] = [("effort", \.effort), ("skills", \.skills), ("specialists", \.specialists)]
        for (key, path) in flags {
            if let b = raw[key] as? Bool { s[keyPath: path] = b }
        }
        if let n = raw["nudge"] as? [String: Any],
           let target = n["target"] as? String,
           let by = n["by"] as? Int, by == 1 || by == -1,
           let id = n["id"] as? String, !id.isEmpty {
            s.nudge = Nudge(target: target, by: by, id: id)
        }
        if let at = raw["updatedAt"] as? Double, at.isFinite { s.updatedAt = at }
        s.updatedBy = raw["updatedBy"] as? String
        return s
    }

    public func encoded() -> Data {
        var obj: [String: Any] = [
            "version": 1,
            "mode": mode.rawValue,
            "focus": focus,
            "effort": effort,
            "skills": skills,
            "specialists": specialists,
            "nudge": nudge.map { n -> Any in ["target": n.target, "by": n.by, "id": n.id] } ?? NSNull(),
            "updatedAt": updatedAt,
        ]
        if let updatedBy { obj["updatedBy"] = updatedBy }
        var data = (try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        data.append(0x0A)
        return data
    }
}

public struct Decision: Codable, Equatable, Sendable {
    public var at: Double
    public var session: String
    public var tier: String
    public var model: String
    public var effort: String?
    public var subject: String?
    public var skill: String?
    public var why: String
    public var confidence: Double?
    public var latencyMs: Double?
    public var jevTokens: Double?
    public var jevCostUsd: Double?
    public var shadow: Bool?
    public var manual: Bool?
    public var focus: Int?

    public var date: Date { Date(timeIntervalSince1970: at / 1000) }

    /// Reads decisions.jsonl, oldest first, skipping lines it cannot read.
    public static func parseLines(_ data: Data) -> [Decision] {
        let decoder = JSONDecoder()
        return data.split(separator: 0x0A).compactMap { try? decoder.decode(Decision.self, from: Data($0)) }
    }
}

public struct LastState: Codable, Equatable, Sendable {
    public var session: String
    public var working: Bool
    /// When the current turn started (working) or the last one ended (idle), in ms.
    public var since: Double
    public var mode: RouterMode
    public var decision: Decision?
    public var updatedAt: Double

    public static func parse(_ data: Data) -> LastState? {
        try? JSONDecoder().decode(LastState.self, from: data)
    }
}

/// One desktop session's heartbeat: Jev is running in it while the beat is fresh and not ended.
public struct SessionBeat: Codable, Equatable, Sendable {
    public static let interval: Double = 30_000
    /// Three missed beats: the process quit without saying so.
    public static let staleAfter: Double = 90_000

    public var host: String
    public var session: String
    public var startedAt: Double
    public var updatedAt: Double
    public var ended: Bool?

    public init(host: String, session: String, startedAt: Double, updatedAt: Double, ended: Bool? = nil) {
        self.host = host
        self.session = session
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.ended = ended
    }

    public static func parse(_ data: Data) -> SessionBeat? {
        try? JSONDecoder().decode(SessionBeat.self, from: data)
    }

    /// The file name for a host session id, or nil for anything that isn't one.
    public static func fileName(host: String) -> String? {
        let ok = !host.isEmpty && host.count <= 128 && host.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "_" || $0 == "-"
        }
        return ok ? host + ".json" : nil
    }

    /// Whether the session's process was running Jev as of `now` (ms since the epoch).
    public func isLive(now: Double) -> Bool {
        ended != true && now - updatedAt <= Self.staleAfter
    }
}

/// Reads and writes ~/.config/jev/. Every read tolerates a missing or half-written file.
public struct ConfigStore: Sendable {
    public let dir: URL

    public init(dir: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/jev")) {
        self.dir = dir
    }

    public var settingsURL: URL { dir.appendingPathComponent("settings.json") }
    public var lastURL: URL { dir.appendingPathComponent("last.json") }
    public var decisionsURL: URL { dir.appendingPathComponent("decisions.jsonl") }
    public var sessionsURL: URL { dir.appendingPathComponent("sessions") }

    public func readSettings() -> SharedSettings? {
        (try? Data(contentsOf: settingsURL)).flatMap(SharedSettings.parse)
    }

    public func readLast() -> LastState? {
        (try? Data(contentsOf: lastURL)).flatMap(LastState.parse)
    }

    public func readDecisions() -> [Decision] {
        (try? Data(contentsOf: decisionsURL)).map(Decision.parseLines) ?? []
    }

    /// The heartbeat of the desktop session with this id, if the plugin has run in it.
    public func readBeat(host: String) -> SessionBeat? {
        guard let name = SessionBeat.fileName(host: host) else { return nil }
        return (try? Data(contentsOf: sessionsURL.appendingPathComponent(name))).flatMap(SessionBeat.parse)
    }

    /// Deletes heartbeats of sessions that stopped more than `age` seconds ago; the plugin
    /// can't delete files, so the folder would otherwise keep one per session ever opened.
    public func pruneBeats(olderThan age: TimeInterval = 7 * 86_400, now: Date = Date()) {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: sessionsURL.path) else { return }
        for name in names where name.hasSuffix(".json") {
            let url = sessionsURL.appendingPathComponent(name)
            guard let beat = (try? Data(contentsOf: url)).flatMap(SessionBeat.parse) else { continue }
            if now.timeIntervalSince1970 * 1000 - beat.updatedAt > age * 1000 { try? fm.removeItem(at: url) }
        }
    }

    /// Applies `change` to the current settings and writes them, newer than whatever is there.
    @discardableResult
    public func updateSettings(now: Date = Date(), _ change: (inout SharedSettings) -> Void) throws -> SharedSettings {
        var s = readSettings() ?? SharedSettings()
        change(&s)
        s.updatedAt = max(now.timeIntervalSince1970 * 1000, s.updatedAt + 1).rounded(.down)
        s.updatedBy = "widget"
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try s.encoded().write(to: settingsURL, options: .atomic)
        return s
    }

    public func modificationDate(_ url: URL) -> Date? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
    }
}
