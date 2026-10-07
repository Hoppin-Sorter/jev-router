import JevCore
import SwiftUI

struct PanelView: View {
    let model: AppModel
    let pill: PillController

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if let error = model.writeError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if model.isVisible(.now) { NowCard(model: model) }
            if model.isVisible(.focus) { FocusCard(model: model) }
            if model.isVisible(.saved) { SavedCard(model: model) }
            if model.isVisible(.recent) { RecentCard(model: model) }
            if Card.allCases.allSatisfy({ !model.isVisible($0) }) {
                Text("All cards are hidden. Customize shows them again.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(width: 340)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Jev").font(.headline)
            Picker("Router", selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
                Text("Off").tag(RouterMode.off)
                Text("Shadow").tag(RouterMode.shadow)
                Text("On").tag(RouterMode.auto)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .help("Off: Claude Code's own model. Shadow: Jev decides and logs, nothing switches. On: Jev routes.")
            Menu {
                Section("Customize") {
                    ForEach(Card.allCases) { card in
                        Toggle(card.rawValue, isOn: Binding(get: { model.isVisible(card) }, set: { model.setVisible(card, $0) }))
                    }
                }
                Divider()
                Button(pill.isShown ? "Close pop-out" : "Pop out") { pill.toggle(model: model) }
                Button("Refresh savings") { model.refreshSavings() }
                Button("Open ~/.config/jev") { NSWorkspace.shared.open(model.store.dir) }
                Divider()
                Button("Quit Jev Bar") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }
}

/// A titled, rounded section of the panel.
struct CardBox<Content: View>: View {
    let title: String
    var trailing: AnyView? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if let trailing { trailing }
            }
            content
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct NowCard: View {
    let model: AppModel

    var body: some View {
        CardBox(title: "Now") {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.mode == .off ? "Router off" : model.modelName).font(.title3.weight(.semibold))
                    if model.decision?.shadow == true && model.mode == .shadow {
                        Text("Shadow: what Jev would pick").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Button { model.nudge(-1) } label: { Image(systemName: "minus") }
                    .help("One tier down for this session's next request")
                Button { model.nudge(1) } label: { Image(systemName: "plus") }
                    .help("One tier up for this session's next request")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(!model.canNudge)

            if let d = model.decision {
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 2) {
                    row("Tier", d.tier + (d.manual == true ? " (you)" : ""))
                    if let s = d.subject { row("Subject", s) }
                    row("Effort", d.effort ?? "session default")
                    if let s = d.skill { row("Skill", "/" + s) }
                    if let c = d.confidence { row("Confidence", "\(Int((c * 100).rounded()))%") }
                    if let ms = d.latencyMs { row("Latency", "\(Int(ms)) ms") }
                }
                .font(.callout)
            }
            if let last = model.last {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let since = Date(timeIntervalSince1970: last.since / 1000)
                    Label(
                        "\(last.working ? "Working" : "Idle") · \(elapsed(context.date.timeIntervalSince(since)))",
                        systemImage: last.working ? "circle.fill" : "circle"
                    )
                    .font(.caption)
                    .foregroundStyle(last.working ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
                }
            } else {
                Text("No session has written ~/.config/jev/last.json yet. Send a prompt in Claude Code with jev-router installed.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ name: String, _ value: String) -> some View {
        GridRow {
            Text(name).foregroundStyle(.secondary)
            Text(value)
        }
    }
}

func elapsed(_ seconds: TimeInterval) -> String {
    let s = max(0, Int(seconds))
    if s < 60 { return "\(s)s" }
    if s < 3600 { return "\(s / 60)m \(s % 60)s" }
    return "\(s / 3600)h \(s / 60 % 60)m"
}

struct FocusCard: View {
    let model: AppModel
    @State private var dragging: Double?

    var body: some View {
        CardBox(title: "Focus", trailing: AnyView(Text(label).font(.caption).foregroundStyle(.secondary))) {
            Slider(
                value: Binding(get: { dragging ?? Double(model.settings.focus) }, set: { dragging = $0 }),
                in: 0...4,
                step: 1
            ) {
                Text("Focus")
            } minimumValueLabel: {
                Text("Token efficient").font(.caption2)
            } maximumValueLabel: {
                Text("Task focused").font(.caption2)
            } onEditingChanged: { editing in
                if !editing, let v = dragging {
                    model.setFocus(Int(v.rounded()))
                    dragging = nil
                }
            }
            .labelsHidden()
            HStack {
                Toggle("Effort", isOn: Binding(get: { model.settings.effort }, set: { model.setEffort($0) }))
                    .help("Set reasoning effort with the model")
                Toggle("Skills", isOn: Binding(get: { model.settings.skills }, set: { model.setSkills($0) }))
                    .help("Hint the installed skill Jev picks")
                Toggle("Specialists", isOn: Binding(get: { model.settings.specialists }, set: { model.setSpecialists($0) }))
                    .help("Let Fable take hard science and math")
            }
            .toggleStyle(.checkbox)
            .font(.callout)
        }
    }

    private var label: String {
        SharedSettings.focusLabels[Int((dragging ?? Double(model.settings.focus)).rounded())]
    }
}

struct SavedCard: View {
    let model: AppModel

    var body: some View {
        CardBox(title: "Saved") {
            Picker("Window", selection: Binding(get: { model.savingsWindow }, set: { model.savingsWindow = $0 })) {
                ForEach(SavingsWindow.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if let s = model.savings[model.savingsWindow] {
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 2) {
                    money("API value", s.actual)
                    money("All on Opus 5.5", s.baseline)
                    money("Jev", s.jev)
                    Divider().gridCellColumns(2)
                    GridRow {
                        Text(s.saved >= 0 ? "Saved" : "Cost more").fontWeight(.semibold)
                        Text(Money.format(abs(s.saved)))
                            .fontWeight(.semibold)
                            .foregroundStyle(s.saved >= 0 ? .green : .orange)
                            .monospacedDigit()
                    }
                }
                .font(.callout)
                if s.requests > 0 {
                    MixBar(mix: s.mix, total: s.requests)
                }
                Text(footnote(s)).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Reading Claude Code transcripts…").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func money(_ name: String, _ usd: Double) -> some View {
        GridRow {
            Text(name).foregroundStyle(.secondary)
            Text(Money.format(usd)).monospacedDigit()
        }
    }

    private func footnote(_ s: SavingsSummary) -> String {
        var text = "\(s.requests) requests at API list prices; your plan may bill differently."
        if s.unpriced > 0 { text += " \(s.unpriced) on other models left out." }
        return text
    }
}

/// Requests per model, as one bar with a legend.
struct MixBar: View {
    let mix: [MixSlice]
    let total: Int

    static func color(_ key: String) -> Color {
        switch key {
        case "haiku-4-5": return .teal
        case "sonnet-5-5": return .blue
        case "opus-5-5": return .purple
        case "fable-5-1": return .orange
        case "opus-5": return .indigo
        default: return .pink
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                HStack(spacing: 1) {
                    ForEach(mix, id: \.key) { slice in
                        Self.color(slice.key)
                            .frame(width: max(2, geo.size.width * CGFloat(slice.requests) / CGFloat(max(total, 1)) - 1))
                    }
                }
            }
            .frame(height: 8)
            .clipShape(Capsule())
            HStack(spacing: 8) {
                ForEach(mix, id: \.key) { slice in
                    HStack(spacing: 3) {
                        Circle().fill(Self.color(slice.key)).frame(width: 6, height: 6)
                        Text("\(slice.name) \(Int((Double(slice.requests) * 100 / Double(max(total, 1))).rounded()))%")
                    }
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }
}

struct RecentCard: View {
    let model: AppModel

    var body: some View {
        CardBox(title: "Recent") {
            if model.recent.isEmpty {
                Text("No decisions yet.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(model.recent.enumerated()), id: \.offset) { _, d in
                HStack(spacing: 6) {
                    Text(d.date, format: .dateTime.hour().minute()).foregroundStyle(.secondary).monospacedDigit()
                    Text(Pricing.model(for: d.model)?.name ?? d.model)
                    Text(d.tier).foregroundStyle(.secondary)
                    if let s = d.skill { Text("/" + s).foregroundStyle(.secondary).lineLimit(1) }
                    Spacer(minLength: 0)
                    if d.shadow == true { tag("shadow") }
                    if d.manual == true { tag("you") }
                }
                .font(.caption)
            }
        }
    }

    private func tag(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .padding(.horizontal, 4)
            .background(.quaternary, in: Capsule())
    }
}
