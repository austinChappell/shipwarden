import SwiftUI
import VisionKit

/// Pairs the phone with a Mac. The Mac shows a QR code in Settings › Mobile.
struct PairView: View {
    @Environment(AppModel.self) private var model
    @State private var scanning = false
    @State private var pasted = ""
    @State private var deviceName = AppModel.deviceName
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "laptopcomputer.and.iphone")
                            .font(.system(size: 40))
                            .foregroundStyle(.tint)
                        Text("Connect to ShipWarden on your Mac")
                            .font(.headline)
                        Text("On the Mac, open ShipWarden › Settings › Mobile. Turn on phone connections, then select “Pair a phone”. The phone must be on the same network as the Mac.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }

                if let link = model.pendingLink {
                    Section("Mac") {
                        LabeledContent("Name", value: link.name)
                        LabeledContent("Addresses", value: link.hosts.joined(separator: ", "))
                        TextField("Name of this phone", text: $deviceName)
                        Button {
                            Task { await pair(link) }
                        } label: {
                            HStack {
                                Text("Pair with \(link.name)")
                                if working { Spacer(); ProgressView() }
                            }
                        }
                        .disabled(working)
                        Button("Cancel", role: .cancel) { model.pendingLink = nil }
                    }
                } else {
                    Section {
                        Button {
                            scanning = true
                        } label: {
                            Label("Scan the QR code", systemImage: "qrcode.viewfinder")
                        }
                        .disabled(!QRScanner.isAvailable)
                        if !QRScanner.isAvailable {
                            Text("This device cannot scan codes. Copy the link on the Mac and paste it below.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section("Or paste the pairing link") {
                        TextField("shipwarden://pair?…", text: $pasted, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.footnote.monospaced())
                        Button("Use the link") { use(pasted) }
                            .disabled(pasted.isEmpty)
                    }
                }

                if model.pendingLink == nil {
                    Section {
                        Button {
                            model.startDemo()
                        } label: {
                            Label("Try the demo", systemImage: "play.rectangle")
                        }
                    } header: {
                        Text("No Mac nearby?")
                    } footer: {
                        Text("The demo shows sample agents. It does not connect to a Mac.")
                    }
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                    }
                }

                if model.pairing != nil && model.pendingLink == nil {
                    Section {
                        Text("This phone is paired with \(model.pairing?.macName ?? "a Mac"). A new pairing replaces it.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Pair with a Mac")
            .sheet(isPresented: $scanning) {
                QRScanner { text in
                    scanning = false
                    use(text)
                }
                .ignoresSafeArea()
            }
        }
    }

    private func use(_ text: String) {
        guard let link = PairingLink(text) else {
            error = "This is not a ShipWarden pairing link."
            return
        }
        error = nil
        model.pendingLink = link
    }

    private func pair(_ link: PairingLink) async {
        working = true
        error = nil
        defer { working = false }
        do {
            let name = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
            try await model.pair(with: link, deviceName: name.isEmpty ? AppModel.deviceName : name)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Reads QR codes with the camera (VisionKit).
struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    static var isAvailable: Bool {
        DataScannerViewController.isSupported && DataScannerViewController.isAvailable
    }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true
        )
        controller.delegate = context.coordinator
        try? controller.startScanning()
        return controller
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        private var done = false

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let code) = item, let text = code.payloadStringValue, PairingLink(text) != nil, !done {
                    done = true
                    dataScanner.stopScanning()
                    onCode(text)
                    return
                }
            }
        }
    }
}
