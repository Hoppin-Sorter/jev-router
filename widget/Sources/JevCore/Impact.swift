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
