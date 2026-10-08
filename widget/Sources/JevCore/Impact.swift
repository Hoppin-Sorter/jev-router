import Foundation

/// A rough estimate of the energy, water and CO₂ behind a dollar figure of API use, for
/// the widget's optional "Water & CO₂" line. Display only: the router never reads it, so it
/// has no say in which model Jev picks.
///
/// Anthropic publishes no per-model energy figures, so this takes list price as a stand-in
/// for compute: a request that costs twice as much is assumed to use twice the energy.
/// Treat the result as an order of magnitude, not a measurement.
public struct ImpactFactors: Equatable, Sendable {
    /// Watt-hours per US dollar of list-price usage. Epoch AI (Feb 2025) put a typical
    /// GPT-4o query at about 0.3 Wh; at roughly 500 output tokens and $10 per million,
    /// that query is $0.005, or 60 Wh per dollar.
    public var whPerUSD: Double
    /// Litres of water per kWh. Google's Gemini figures (Aug 2025) give 0.26 mL for 0.24 Wh,
    /// about 1.1 L/kWh, counting data-center cooling only.
    public var litersPerKWh: Double
    /// kg CO₂e per kWh: about the US grid average (location-based). Providers that buy clean
    /// power report lower market-based figures.
    public var kgCO2PerKWh: Double

    public init(whPerUSD: Double = 60, litersPerKWh: Double = 1.1, kgCO2PerKWh: Double = 0.4) {
        self.whPerUSD = whPerUSD
        self.litersPerKWh = litersPerKWh
        self.kgCO2PerKWh = kgCO2PerKWh
    }

    public static let standard = ImpactFactors()
}

public struct Impact: Equatable, Sendable {
    public var energyWh: Double
    public var waterL: Double
    public var co2Kg: Double

    public init(usd: Double, factors: ImpactFactors = .standard) {
        energyWh = usd * factors.whPerUSD
        waterL = energyWh / 1000 * factors.litersPerKWh
        co2Kg = energyWh / 1000 * factors.kgCO2PerKWh
    }

    /// "≈ 373 mL", "≈ 1.2 L"; a negative amount (routing used more) gets a minus sign.
    public static func water(_ liters: Double) -> String {
        approx(liters, units: [(1, "L"), (0.001, "mL")])
    }

    /// "≈ 136 mg", "≈ 45 g", "≈ 2.3 kg" of CO₂e.
    public static func co2(_ kg: Double) -> String {
        approx(kg, units: [(1, "kg"), (0.001, "g"), (0.000_001, "mg")])
    }

    /// "≈ 0.34 Wh", "≈ 12 Wh", "≈ 1.5 kWh".
    public static func energy(_ wh: Double) -> String {
        let v = abs(wh)
        let sign = wh < 0 ? "−" : ""
        if v >= 1000 { return "≈ \(sign)\(String(format: "%.1f", v / 1000)) kWh" }
        return "≈ \(sign)\(String(format: v >= 10 ? "%.0f" : "%.2f", v)) Wh"
    }

    /// A 60 W-equivalent LED bulb draws about 10 W.
    public static let ledBulbWatts = 10.0
    /// A full charge of a recent phone takes about 15 Wh from the wall: a 13–17 Wh battery
    /// plus charger losses.
    public static let phoneChargeWh = 15.0

    /// An everyday comparison for an amount of energy: "like an LED bulb on for 2 min" below one
    /// phone charge, "like 1.3 phone charges" from there up, nil for nothing. Uses the size only;
    /// the caller says whether it was saved or used.
    public static func everyday(_ wh: Double) -> String? {
        let v = abs(wh)
        guard v > 0 else { return nil }
        if v < phoneChargeWh {
            let minutes = v / ledBulbWatts * 60
            return minutes < 1 ? "like an LED bulb on for under a minute" : "like an LED bulb on for \(Int(minutes.rounded())) min"
        }
        let charges = v / phoneChargeWh
        let rounded = charges < 10 ? (charges * 10).rounded() / 10 : charges.rounded()
        let shown = String(format: rounded == rounded.rounded() ? "%.0f" : "%.1f", rounded)
        return "like \(shown) phone charge\(shown == "1" ? "" : "s")"
    }

    /// Picks the largest unit the value reaches (the last one otherwise).
    private static func approx(_ value: Double, units: [(scale: Double, name: String)]) -> String {
        let v = abs(value)
        let sign = value < 0 ? "−" : ""
        let unit = units.first { v >= $0.scale } ?? units[units.count - 1]
        let shown = v / unit.scale
        let decimals = shown >= 10 ? 0 : shown >= 1 ? 1 : 2
        return "≈ \(sign)\(String(format: "%.\(decimals)f", shown)) \(unit.name)"
    }
}

public extension SavingsSummary {
    /// The estimated energy, water and CO₂ behind `saved` (negative when routing cost more).
    var impactSaved: Impact { Impact(usd: saved) }
}

public extension SavingsWindow {
    /// The water and CO₂ line covers 30 days unless the person picks another window: one day's
    /// figure is usually too small to mean much.
    static let impactDefault: SavingsWindow = .month
}
