import SwiftUI
import UIKit

/// Turns the screen of an agent into styled text.
enum TerminalStyle {
    /// The 16 basic colors. They are the default colors of Ghostty, which ShipWarden uses on the Mac.
    private static let basic: [UInt32] = [
        0x1d1f21, 0xcc6666, 0xb5bd68, 0xf0c674, 0x81a2be, 0xb294bb, 0x8abeb7, 0xc5c8c6,
        0x666666, 0xd54e53, 0xb9ca4a, 0xe7c547, 0x7aa6da, 0xc397d8, 0x70c0b1, 0xeaeaea
    ]

    static let background = Color(rgb: 0x0f1115)
    static let foreground = Color(rgb: 0xd8dee9)

    /// Returns the color of a palette index: the 16 basic colors, the 6×6×6 cube, then the gray ramp.
    static func paletteColor(_ index: Int) -> UInt32 {
        switch index {
        case 0..<16:
            return basic[index]
        case 16..<232:
            let value = index - 16
            let steps: [UInt32] = [0, 95, 135, 175, 215, 255]
            return steps[value / 36] << 16 | steps[(value / 6) % 6] << 8 | steps[value % 6]
        case 232..<256:
            let gray = UInt32(8 + (index - 232) * 10)
            return gray << 16 | gray << 8 | gray
        default:
            return 0xd8dee9
        }
    }

    static func color(_ color: TerminalColor?, bold: Bool) -> Color? {
        switch color {
        case .none: return nil
        // Bold text with a basic color uses the bright color, as in most terminals.
        case .palette(let index): return Color(rgb: paletteColor(bold && index < 8 ? index + 8 : index))
        case .rgb(let value): return Color(rgb: value)
        }
    }

    /// The width of one character of the monospaced font, as a part of the font size.
    static let characterWidthRatio: CGFloat = {
        let font = UIFont.monospacedSystemFont(ofSize: 100, weight: .regular)
        return ("M" as NSString).size(withAttributes: [.font: font]).width / 100
    }()

    /// Adds the text variation selector after symbols that iOS can show as emoji, for example "⏺".
    /// A terminal shows them as text, one cell wide.
    static func textPresentation(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            scalars.append(scalar)
            if scalar.value >= 0x2000, scalar.properties.isEmoji, !scalar.properties.isEmojiPresentation {
                scalars.append("\u{FE0E}")
            }
        }
        return String(scalars)
    }

    /// The lines to show: the empty lines at the end go, except for the line with the cursor.
    static func visibleLines(_ snapshot: ScreenSnapshot) -> ArraySlice<[ScreenRun]> {
        let cursorLine = snapshot.lines.count - snapshot.rows + snapshot.cursor.y
        var end = snapshot.lines.count
        while end > 0, end - 1 > cursorLine, snapshot.lines[end - 1].allSatisfy({ $0.t.allSatisfy(\.isWhitespace) && $0.bg == nil }) {
            end -= 1
        }
        return snapshot.lines[..<end]
    }

    /// Makes one text for all lines. A text with all lines draws faster than one view for each line.
    static func attributed(_ snapshot: ScreenSnapshot, fontSize: CGFloat) -> AttributedString {
        var result = AttributedString()
        let regular = Font.system(size: fontSize, design: .monospaced)
        let bold = Font.system(size: fontSize, weight: .bold, design: .monospaced)
        let lines = visibleLines(snapshot)
        for (index, line) in lines.enumerated() {
            for run in line {
                var part = AttributedString(textPresentation(run.t))
                let isBold = run.b == 1
                var fg = color(run.fg, bold: isBold) ?? foreground
                var bg = color(run.bg, bold: false)
                if run.v == 1 {
                    let swapped = bg ?? background
                    bg = fg
                    fg = swapped
                }
                part.font = isBold ? bold : regular
                part.foregroundColor = run.d == 1 ? fg.opacity(0.6) : fg
                if let bg { part.backgroundColor = bg }
                if run.u == 1 { part.underlineStyle = .single }
                if run.i == 1 { part.font = (isBold ? bold : regular).italic() }
                result.append(part)
            }
            // The line break gets the font too, so an empty line has the height of a text line.
            var end = AttributedString(index < lines.count - 1 ? "\n" : " ")
            end.font = regular
            result.append(end)
        }
        return result
    }
}

extension Color {
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255
        )
    }

    /// Reads a CSS color such as `#4a8fe7`.
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(rgb: value)
    }
}

extension AgentState {
    var color: Color {
        switch self {
        case .waiting: .orange
        case .working: .blue
        case .done: .green
        case .starting, .idle: .secondary
        case .exited: .gray
        }
    }

    var symbol: String {
        switch self {
        case .waiting: "exclamationmark.bubble.fill"
        case .working: "gearshape.2.fill"
        case .done: "checkmark.circle.fill"
        case .starting: "hourglass"
        case .idle: "circle"
        case .exited: "stop.circle"
        }
    }
}
