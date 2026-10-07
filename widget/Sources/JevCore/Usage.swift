import Foundation

/// One assistant request's usage, read from a Claude Code transcript.
public struct UsageRecord: Codable, Equatable, Sendable {
    /// message.id + requestId: the same request can appear on several lines and in several files.
    public var key: String
    public var model: String
    /// Seconds since the epoch.
    public var at: Double
    public var usage: Usage
}

/// Scans ~/.claude/projects/**/*.jsonl for assistant usage. A file whose size and
/// modification time have not changed is not read again; the cache can be kept on disk.
public final class UsageScanner {
    public let root: URL
    public let cacheURL: URL?
    /// How many files the last scan actually read (the rest came from the cache).
    public private(set) var filesParsed = 0

    private struct Entry: Codable {
        var mtime: Double
        var size: Int
        var records: [UsageRecord]
    }

    private var cache: [String: Entry] = [:]

    public init(
        root: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects"),
        cacheURL: URL? = nil
    ) {
        self.root = root
        self.cacheURL = cacheURL
        if let cacheURL, let data = try? Data(contentsOf: cacheURL),
           let saved = try? JSONDecoder().decode([String: Entry].self, from: data) {
            cache = saved
        }
    }

    /// Every distinct request at or after `since`, oldest first.
    public func scan(since: Date) -> [UsageRecord] {
        filesParsed = 0
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]
        var seenPaths = Set<String>()
        var byKey: [String: UsageRecord] = [:]
        let cutoff = since.timeIntervalSince1970

        if let walker = fm.enumerator(at: root, includingPropertiesForKeys: keys) {
            for case let url as URL in walker where url.pathExtension == "jsonl" {
                guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
                let mtime = values.contentModificationDate?.timeIntervalSince1970 ?? 0
                let size = values.fileSize ?? 0
                let path = url.path
                seenPaths.insert(path)
                // A file last written before the window holds nothing inside it.
                if mtime < cutoff { continue }
                let records: [UsageRecord]
                if let hit = cache[path], hit.mtime == mtime, hit.size == size {
                    records = hit.records
                } else {
                    records = (try? Data(contentsOf: url)).map(Self.parse) ?? []
                    cache[path] = Entry(mtime: mtime, size: size, records: records)
                    filesParsed += 1
                }
                for r in records where r.at >= cutoff { byKey[r.key] = r }
            }
        }
        // Forget files that are gone; keep older ones, which a longer window may still want.
        cache = cache.filter { seenPaths.contains($0.key) }
        saveCache()
        return byKey.values.sorted { $0.at < $1.at }
    }

    private func saveCache() {
        guard let cacheURL else { return }
        try? FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(cache).write(to: cacheURL, options: .atomic)
    }

    /// Reads one transcript: assistant lines with a usage block. A request repeated
    /// within the file keeps its last line, which carries the final counts.
    public static func parse(_ data: Data) -> [UsageRecord] {
        let marker = Data("\"usage\"".utf8)
        var order: [String] = []
        var byKey: [String: UsageRecord] = [:]
        for line in data.split(separator: 0x0A) where line.range(of: marker) != nil {
            guard
                let obj = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any],
                obj["type"] as? String == "assistant",
                let message = obj["message"] as? [String: Any],
                let id = message["id"] as? String,
                let model = message["model"] as? String,
                let u = message["usage"] as? [String: Any],
                let stamp = obj["timestamp"] as? String,
                let at = parseTimestamp(stamp)
            else { continue }
            let int = { (dict: [String: Any], key: String) in (dict[key] as? Int) ?? 0 }
            var usage = Usage(input: int(u, "input_tokens"), output: int(u, "output_tokens"), cacheRead: int(u, "cache_read_input_tokens"))
            let written = int(u, "cache_creation_input_tokens")
            if let split = u["cache_creation"] as? [String: Any] {
                usage.cacheWrite5m = int(split, "ephemeral_5m_input_tokens")
                usage.cacheWrite1h = int(split, "ephemeral_1h_input_tokens")
                // Anything the split does not account for is billed as a 5-minute write.
                usage.cacheWrite5m += max(0, written - usage.cacheWrite5m - usage.cacheWrite1h)
            } else {
                usage.cacheWrite5m = written
            }
            let key = "\(id)|\(obj["requestId"] as? String ?? "")"
            if byKey[key] == nil { order.append(key) }
            byKey[key] = UsageRecord(key: key, model: model, at: at.timeIntervalSince1970, usage: usage)
        }
        return order.compactMap { byKey[$0] }
    }

    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let whole = ISO8601DateFormatter()

    static func parseTimestamp(_ s: String) -> Date? {
        fractional.date(from: s) ?? whole.date(from: s)
    }
}

// The app runs one scan at a time, off the main thread, and never shares a scanner
// between two scans at once.
extension UsageScanner: @unchecked Sendable {}
