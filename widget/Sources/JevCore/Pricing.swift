import Foundation

/// List prices in USD per million tokens, from Anthropic's pricing page (October 2026).
public struct Price: Equatable, Sendable {
    public let input: Double
    public let output: Double
    public let cacheRead: Double

    public init(input: Double, output: Double, cacheRead: Double) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
    }

    /// Cache writes are billed as input: 1.25x for the 5-minute cache, 2x for the 1-hour cache.
    public var cacheWrite5m: Double { input * 1.25 }
    public var cacheWrite1h: Double { input * 2 }
}

/// A model family the widget can price, matched from a Claude Code model id.
public struct PricedModel: Equatable, Sendable {
    /// Stable key, e.g. "opus-5-5".
    public let key: String
    /// Display name, e.g. "Opus 5.5".
    public let name: String
    /// Menu bar name, e.g. "Opus".
    public let short: String
    public let price: Price
}

public enum Pricing {
    /// Ordered so a longer id fragment wins: "opus-5-5" before "opus-5".
    public static let models: [PricedModel] = [
        PricedModel(key: "haiku-4-5", name: "Haiku 4.5", short: "Haiku", price: Price(input: 1, output: 5, cacheRead: 0.10)),
        PricedModel(key: "sonnet-5-5", name: "Sonnet 5.5", short: "Sonnet", price: Price(input: 2, output: 10, cacheRead: 0.20)),
        PricedModel(key: "opus-5-5", name: "Opus 5.5", short: "Opus", price: Price(input: 4, output: 20, cacheRead: 0.20)),
        PricedModel(key: "fable-5-1", name: "Fable 5.1", short: "Fable", price: Price(input: 10, output: 50, cacheRead: 0.25)),
        PricedModel(key: "opus-5", name: "Opus 5", short: "Opus", price: Price(input: 5, output: 25, cacheRead: 0.50)),
        PricedModel(key: "fable-5", name: "Fable 5", short: "Fable", price: Price(input: 10, output: 50, cacheRead: 1.00)),
    ]

    /// What every request is compared against: the same tokens, all on Opus 5.5.
    public static let baseline = models[2]

    /// Jev's price: $0.042 per million input tokens.
    public static let jevPerMTok = 0.042

    /// Matches "claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5[1m]" and the like.
    /// Returns nil for models with no price here (older families, "<synthetic>").
    public static func model(for id: String) -> PricedModel? {
        let id = id.lowercased()
        for m in models {
            guard let range = id.range(of: m.key) else { continue }
            // "opus-5" must not match inside "opus-5-5", nor "fable-5" inside "fable-5-1".
            let rest = id[range.upperBound...]
            if rest.hasPrefix("-"), let next = rest.dropFirst().first, next.isNumber {
                // "-5" (a minor version) or "-20251001" (a date)? Dates are 8 digits.
                let digits = rest.dropFirst().prefix(while: { $0.isNumber })
                if digits.count < 8 { continue }
            }
            return m
        }
        return nil
    }

    /// Cost in USD of one request's usage at `price`.
    public static func cost(_ u: Usage, at price: Price) -> Double {
        let perToken =
            Double(u.input) * price.input
            + Double(u.output) * price.output
            + Double(u.cacheRead) * price.cacheRead
            + Double(u.cacheWrite5m) * price.cacheWrite5m
            + Double(u.cacheWrite1h) * price.cacheWrite1h
        return perToken / 1_000_000
    }
}

/// Token counts from one assistant message's `usage`.
public struct Usage: Equatable, Codable, Sendable {
    public var input: Int
    public var output: Int
    public var cacheRead: Int
    public var cacheWrite5m: Int
    public var cacheWrite1h: Int

    public init(input: Int = 0, output: Int = 0, cacheRead: Int = 0, cacheWrite5m: Int = 0, cacheWrite1h: Int = 0) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheWrite5m = cacheWrite5m
        self.cacheWrite1h = cacheWrite1h
    }

    public var total: Int { input + output + cacheRead + cacheWrite5m + cacheWrite1h }
}
