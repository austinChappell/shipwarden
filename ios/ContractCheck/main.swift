import Foundation

// Checks that Models.swift agrees with the API of the desktop app.
// The desktop tests write the JSON files in ios/ContractFixtures from src/shared/remote.ts.
// scripts/check-ios-contract.sh compiles this file with Models.swift and runs it.

var failures: [String] = []

func fail(_ message: String) {
    failures.append(message)
}

func data(_ folder: URL, _ name: String) -> Data? {
    do {
        return try Data(contentsOf: folder.appendingPathComponent(name))
    } catch {
        fail("\(name): the file cannot be read. \(error)")
        return nil
    }
}

/// Removes the keys with a null value. Swift encodes a nil optional as a missing key, and both mean "no value".
func withoutNulls(_ value: Any) -> Any {
    if let object = value as? [String: Any] {
        return object.filter { !($0.value is NSNull) }.mapValues(withoutNulls)
    }
    if let array = value as? [Any] {
        return array.map(withoutNulls)
    }
    return value
}

func json(_ value: Data) -> NSObject? {
    guard let tree = try? JSONSerialization.jsonObject(with: value, options: [.fragmentsAllowed]) else { return nil }
    return withoutNulls(tree) as? NSObject
}

/// Decodes the file, encodes the value again and compares the two JSON trees.
/// A field that only one side knows makes the trees different.
func roundTrip<T: Codable>(_ type: T.Type, _ folder: URL, _ name: String) {
    guard let original = data(folder, name) else { return }
    do {
        let value = try JSONDecoder().decode(T.self, from: original)
        let encoded = try JSONEncoder().encode(value)
        if json(original) != json(encoded) {
            fail("\(name): \(T.self) does not keep all fields. Compare Models.swift with remote.ts.")
        }
    } catch {
        fail("\(name): \(T.self) cannot decode the file. \(error)")
    }
}

/// Decodes the file and compares the JSON keys with the stored properties of the type.
func decodeWithKeys<T: Decodable>(_ type: T.Type, _ folder: URL, _ name: String) {
    guard let original = data(folder, name) else { return }
    do {
        let value = try JSONDecoder().decode(T.self, from: original)
        let properties = Set(Mirror(reflecting: value).children.compactMap { $0.label })
        let keys = Set((json(original) as? [String: Any])?.keys.map { $0 } ?? [])
        if properties != keys {
            fail("\(name): the keys \(keys.sorted()) are not the same as the properties \(properties.sorted()) of \(T.self).")
        }
    } catch {
        fail("\(name): \(T.self) cannot decode the file. \(error)")
    }
}

guard CommandLine.arguments.count == 2 else {
    print("Usage: contract-check <fixtures folder>")
    exit(2)
}
let folder = URL(fileURLWithPath: CommandLine.arguments[1])

roundTrip(RemoteSnapshot.self, folder, "snapshot-full.json")
roundTrip(RemoteSnapshot.self, folder, "snapshot-minimal.json")
roundTrip(ScreenSnapshot.self, folder, "screen.json")
decodeWithKeys(PairResponse.self, folder, "pair-response.json")
decodeWithKeys(APIErrorBody.self, folder, "error.json")

if let states = data(folder, "agent-states.json") {
    if (try? JSONDecoder().decode([AgentState].self, from: states)) == nil {
        fail("agent-states.json: AgentState does not have all the states of the desktop app.")
    }
}

if let keys = data(folder, "remote-keys.json") {
    let desktop = Set((try? JSONDecoder().decode([String].self, from: keys)) ?? [])
    let phone = Set(RemoteKey.allCases.map(\.rawValue))
    if desktop != phone {
        fail("remote-keys.json: the keys \(desktop.sorted()) are not the same as RemoteKey \(phone.sorted()).")
    }
}

if let expected = data(folder, "input.json") {
    let input = RemoteInput(text: "yes", key: .enter, submit: true)
    if let encoded = try? JSONEncoder().encode(input), json(encoded) != json(expected) {
        fail("input.json: the encoding of RemoteInput is not the same as remote.ts.")
    }
}

if failures.isEmpty {
    print("The iPhone models agree with the desktop API.")
} else {
    for failure in failures { print("FAIL \(failure)") }
    exit(1)
}
