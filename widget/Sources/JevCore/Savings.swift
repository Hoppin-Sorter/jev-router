import Foundation

public enum SavingsWindow: String, CaseIterable, Identifiable, Sendable {
    case today = "Today"
    case week = "7 days"
    case month = "30 days"

    public var id: String { rawValue }

    /// Today starts at local midnight; the others are rolling.
    public func start(now: Date, calendar: Calendar = .current) -> Date {
        switch self {
        case .today: return calendar.startOfDay(for: now)
        case .week: return now.addingTimeInterval(-7 * 86_400)
        case .month: return now.addingTimeInterval(-30 * 86_400)
        }
    }
}

public struct MixSlice: Equatable, Sendable {
    public let key: String
    public let name: String
    public let requests: Int
}

/// API value at list prices for one window, against the same tokens all on Opus 5.5.
public struct SavingsSummary: Equatable, Sendable {
    /// What the requests were worth at their own models' list prices.
    public var actual: Double = 0
    /// The same tokens priced on Opus 5.5.
    public var baseline: Double = 0
    /// What the Jev calls cost.
    public var jev: Double = 0
    public var requests = 0
    /// Requests on models with no price here (left out of both sides).
    public var unpriced = 0
    /// Requests per model, most first.
    public var mix: [MixSlice] = []

    /// Positive when routing came out cheaper than Opus 5.5 for everything, after Jev.
    public var saved: Double { baseline - actual - jev }

    public init() {}

    public static func make(
        usage: [UsageRecord],
        decisions: [Decision],
        window: SavingsWindow,
        now: Date,
        calendar: Calendar = .current
    ) -> SavingsSummary {
        let from = window.start(now: now, calendar: calendar).timeIntervalSince1970
        let to = now.timeIntervalSince1970
        var s = SavingsSummary()
        var counts: [String: Int] = [:]
        for r in usage where r.at >= from && r.at <= to {
            guard let m = Pricing.model(for: r.model) else {
                s.unpriced += 1
                continue
            }
            s.requests += 1
            s.actual += Pricing.cost(r.usage, at: m.price)
            s.baseline += Pricing.cost(r.usage, at: Pricing.baseline.price)
            counts[m.key, default: 0] += 1
        }
        for d in decisions {
            let at = d.at / 1000
            if at >= from && at <= to { s.jev += d.jevCostUsd ?? 0 }
        }
        // Most requests first; ties keep the price table's order.
        s.mix = Pricing.models.enumerated()
            .compactMap { i, m in counts[m.key].map { (i, MixSlice(key: m.key, name: m.name, requests: $0)) } }
            .sorted { $0.1.requests != $1.1.requests ? $0.1.requests > $1.1.requests : $0.0 < $1.0 }
            .map(\.1)
        return s
    }
}

public enum Money {
    /// "$1.23", "$0.004", "−$0.12": enough digits that small numbers are not all "$0.00".
    public static func format(_ usd: Double) -> String {
        let sign = usd < 0 ? "−" : ""
        let v = abs(usd)
        let digits = v >= 1 ? 2 : v >= 0.01 ? 3 : v == 0 ? 2 : 4
        return sign + "$" + String(format: "%.\(digits)f", v)
    }
}
