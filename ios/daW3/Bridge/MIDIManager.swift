import CoreMIDI
import Foundation

/// MIDI 1.0 byte stream <-> Universal MIDI Packet words (MIDI 1.0 protocol), for CoreMIDI's event-list APIs.
enum UMP {
    /// Number of 32-bit words in a UMP whose first word has message type `mt`.
    static func wordCount(messageType mt: UInt32) -> Int {
        switch mt {
        case 0x0, 0x1, 0x2, 0x6, 0x7: return 1
        case 0x3, 0x4, 0x8, 0x9, 0xA: return 2
        case 0xB, 0xC: return 3
        default: return 4
        }
    }

    /// Expected length of a MIDI 1.0 message starting with `status` (0 = sysex / variable).
    static func messageLength(status: UInt8) -> Int {
        switch status & 0xF0 {
        case 0x80, 0x90, 0xA0, 0xB0, 0xE0: return 3
        case 0xC0, 0xD0: return 2
        case 0xF0:
            switch status {
            case 0xF0: return 0
            case 0xF1, 0xF3: return 2
            case 0xF2: return 3
            default: return 1
            }
        default: return 1
        }
    }

    /// MIDI 1.0 bytes (one or more complete messages) -> UMP messages (each an array of words), group 0.
    static func encode(_ bytes: [UInt8]) -> [[UInt32]] {
        var out: [[UInt32]] = []
        var i = 0
        while i < bytes.count {
            let status = bytes[i]
            guard status & 0x80 != 0 else { i += 1; continue } // stray data byte
            if status == 0xF0 {
                var end = i + 1
                while end < bytes.count && bytes[end] != 0xF7 { end += 1 }
                let payload = Array(bytes[(i + 1)..<min(end, bytes.count)])
                out.append(contentsOf: encodeSysex7(payload))
                i = end + 1
                continue
            }
            let len = messageLength(status: status)
            let d1 = len > 1 && i + 1 < bytes.count ? UInt32(bytes[i + 1] & 0x7F) : 0
            let d2 = len > 2 && i + 2 < bytes.count ? UInt32(bytes[i + 2] & 0x7F) : 0
            let mt: UInt32 = status >= 0xF0 ? 0x1 : 0x2
            out.append([(mt << 28) | (UInt32(status) << 16) | (d1 << 8) | d2])
            i += len
        }
        return out
    }

    static func encodeSysex7(_ payload: [UInt8]) -> [[UInt32]] {
        let chunks = stride(from: 0, to: max(payload.count, 1), by: 6).map { Array(payload[$0..<min($0 + 6, payload.count)]) }
        return chunks.enumerated().map { idx, chunk in
            let kind: UInt32
            if chunks.count == 1 { kind = 0 } else if idx == 0 { kind = 1 } else if idx == chunks.count - 1 { kind = 3 } else { kind = 2 }
            var b = [UInt8](repeating: 0, count: 6)
            for (j, v) in chunk.enumerated() { b[j] = v & 0x7F }
            let w0 = (UInt32(0x3) << 28) | (kind << 20) | (UInt32(chunk.count) << 16) | (UInt32(b[0]) << 8) | UInt32(b[1])
            let w1 = (UInt32(b[2]) << 24) | (UInt32(b[3]) << 16) | (UInt32(b[4]) << 8) | UInt32(b[5])
            return [w0, w1]
        }
    }

    /// UMP words -> complete MIDI 1.0 messages. `sysex` carries a partial sysex across calls.
    static func decode(_ words: [UInt32], sysex: inout [UInt8]) -> [[UInt8]] {
        var out: [[UInt8]] = []
        var i = 0
        while i < words.count {
            let w0 = words[i]
            let mt = w0 >> 28
            let n = wordCount(messageType: mt)
            defer { i += n }
            switch mt {
            case 0x1, 0x2:
                let status = UInt8((w0 >> 16) & 0xFF)
                let len = messageLength(status: status)
                let msg = [status, UInt8((w0 >> 8) & 0x7F), UInt8(w0 & 0x7F)]
                out.append(Array(msg.prefix(max(len, 1))))
            case 0x3:
                guard i + 1 < words.count else { break }
                let w1 = words[i + 1]
                let kind = (w0 >> 20) & 0xF
                let count = Int((w0 >> 16) & 0xF)
                let b: [UInt8] = [UInt8((w0 >> 8) & 0xFF), UInt8(w0 & 0xFF), UInt8(w1 >> 24), UInt8((w1 >> 16) & 0xFF),
                                  UInt8((w1 >> 8) & 0xFF), UInt8(w1 & 0xFF)]
                let data = Array(b.prefix(min(count, 6)))
                switch kind {
                case 0: out.append([0xF0] + data + [0xF7]); sysex = []
                case 1: sysex = [0xF0] + data
                case 2: sysex += data
                default:
                    if !sysex.isEmpty { out.append(sysex + data + [0xF7]) }
                    sysex = []
                }
            default:
                break // MIDI 2.0 / utility / data messages: not produced on a MIDI 1.0 port
            }
        }
        return out
    }
}

/// CoreMIDI: device lists, input from every source (plus a virtual "daW³" destination other apps can play into),
/// output to any destination. Messages are reported as complete MIDI 1.0 byte arrays (Web MIDI shape).
final class MIDIManager {
    static let shared = MIDIManager()
    static let virtualInputID = "daw3-virtual-in"

    /// (port id, bytes) — called on the main queue.
    var onMessage: ((String, [UInt8]) -> Void)?
    /// Called on the main queue when devices appear / disappear.
    var onStateChange: (() -> Void)?

    private(set) var started = false
    private var client = MIDIClientRef()
    private var inPort = MIDIPortRef()
    private var outPort = MIDIPortRef()
    private var virtualDest = MIDIEndpointRef()
    private var connected = Set<MIDIUniqueID>()
    private var sysexBuffers: [UInt32: [UInt8]] = [:] // touched only on CoreMIDI's receive thread
    private var ownEndpoints = Set<MIDIEndpointRef>()

    struct MIDIError: LocalizedError {
        let status: OSStatus
        let what: String
        var errorDescription: String? { "CoreMIDI \(what) failed (\(status))" }
    }

    func start() throws {
        if started { return }
        var status = MIDIClientCreateWithBlock("daW3" as CFString, &client) { [weak self] notification in
            let id = notification.pointee.messageID
            if id == .msgSetupChanged || id == .msgObjectAdded || id == .msgObjectRemoved || id == .msgPropertyChanged {
                DispatchQueue.main.async { self?.rescan(notify: true) }
            }
        }
        guard status == noErr else { throw MIDIError(status: status, what: "client") }
        status = MIDIInputPortCreateWithProtocol(client, "daW3 Input" as CFString, ._1_0, &inPort) { [weak self] list, refCon in
            let key = UInt32(truncatingIfNeeded: UInt(bitPattern: refCon))
            self?.receive(list, key: key, id: String(Int32(bitPattern: key)))
        }
        guard status == noErr else { throw MIDIError(status: status, what: "input port") }
        status = MIDIOutputPortCreate(client, "daW3 Output" as CFString, &outPort)
        guard status == noErr else { throw MIDIError(status: status, what: "output port") }
        // A virtual destination so sequencer apps (AUM, Xequence, …) can play daW³ directly.
        status = MIDIDestinationCreateWithProtocol(client, "daW³" as CFString, ._1_0, &virtualDest) { [weak self] list, _ in
            self?.receive(list, key: 0, id: MIDIManager.virtualInputID)
        }
        if status == noErr { ownEndpoints.insert(virtualDest) }
        started = true
        rescan(notify: false)
    }

    private func receive(_ list: UnsafePointer<MIDIEventList>, key: UInt32, id: String) {
        var messages: [[UInt8]] = []
        var buffer = sysexBuffers[key] ?? []
        for packet in list.unsafeSequence() {
            let count = Int(packet.pointee.wordCount)
            let words: [UInt32] = withUnsafeBytes(of: packet.pointee.words) { raw in
                Array(raw.bindMemory(to: UInt32.self).prefix(count))
            }
            messages += UMP.decode(words, sysex: &buffer)
        }
        sysexBuffers[key] = buffer
        guard !messages.isEmpty else { return }
        DispatchQueue.main.async { [weak self] in
            for m in messages { self?.onMessage?(id, m) }
        }
    }

    /// Connect any new sources; optionally tell JS the device list changed.
    func rescan(notify: Bool) {
        guard started else { return }
        var now = Set<MIDIUniqueID>()
        for i in 0..<MIDIGetNumberOfSources() {
            let src = MIDIGetSource(i)
            let uid = Self.uniqueID(src)
            now.insert(uid)
            if !connected.contains(uid) {
                let refCon = UnsafeMutableRawPointer(bitPattern: UInt(UInt32(bitPattern: uid)) | (1 << 40))
                if MIDIPortConnectSource(inPort, src, refCon) == noErr { connected.insert(uid) }
            }
        }
        connected.formIntersection(now)
        if notify { onStateChange?() }
    }

    /// { inputs: [port], outputs: [port] } in Web MIDI terms (inputs = CoreMIDI sources).
    func state() -> [String: Any] {
        var inputs: [[String: Any]] = (0..<MIDIGetNumberOfSources()).map { Self.describe(MIDIGetSource($0)) }
        if started && virtualDest != 0 {
            inputs.append(["id": Self.virtualInputID, "name": "daW³ (from other apps)", "manufacturer": "daW³", "version": "1"])
        }
        let outputs: [[String: Any]] = (0..<MIDIGetNumberOfDestinations()).compactMap { i in
            let d = MIDIGetDestination(i)
            return ownEndpoints.contains(d) ? nil : Self.describe(d)
        }
        return ["inputs": inputs, "outputs": outputs]
    }

    /// Send MIDI 1.0 bytes to the destination with Web MIDI port id `id`, `delayMs` from now.
    func send(id: String, bytes: [UInt8], delayMs: Double) throws {
        guard started else { throw MIDIError(status: -1, what: "send (not started)") }
        guard let uid = Int32(id), let dest = Self.endpoint(uniqueID: uid) else { throw MIDIError(status: -2, what: "send (unknown port \(id))") }
        let ts: MIDITimeStamp = delayMs > 0 ? mach_absolute_time() + Self.hostTicks(nanoseconds: UInt64(delayMs * 1_000_000)) : 0
        let messages = UMP.encode(bytes)
        var list = MIDIEventList()
        var packet: UnsafeMutablePointer<MIDIEventPacket> = MIDIEventListInit(&list, ._1_0)
        let capacity = MemoryLayout<MIDIEventList>.size
        for words in messages {
            var next: UnsafeMutablePointer<MIDIEventPacket>? = MIDIEventListAdd(&list, capacity, packet, ts, words.count, words)
            if next == nil { // list full: flush and start over
                MIDISendEventList(outPort, dest, &list)
                packet = MIDIEventListInit(&list, ._1_0)
                next = MIDIEventListAdd(&list, capacity, packet, ts, words.count, words)
            }
            if let next { packet = next }
        }
        let status = MIDISendEventList(outPort, dest, &list)
        guard status == noErr else { throw MIDIError(status: status, what: "send") }
    }

    // MARK: helpers

    static func uniqueID(_ obj: MIDIObjectRef) -> MIDIUniqueID {
        var uid: MIDIUniqueID = 0
        MIDIObjectGetIntegerProperty(obj, kMIDIPropertyUniqueID, &uid)
        return uid
    }

    static func string(_ obj: MIDIObjectRef, _ key: CFString) -> String {
        var out: Unmanaged<CFString>?
        guard MIDIObjectGetStringProperty(obj, key, &out) == noErr, let s = out?.takeRetainedValue() else { return "" }
        return s as String
    }

    static func describe(_ ep: MIDIEndpointRef) -> [String: Any] {
        var version: Int32 = 0
        MIDIObjectGetIntegerProperty(ep, kMIDIPropertyDriverVersion, &version)
        let display = string(ep, kMIDIPropertyDisplayName)
        return [
            "id": String(uniqueID(ep)),
            "name": display.isEmpty ? string(ep, kMIDIPropertyName) : display,
            "manufacturer": string(ep, kMIDIPropertyManufacturer),
            "version": String(version),
        ]
    }

    static func endpoint(uniqueID uid: MIDIUniqueID) -> MIDIEndpointRef? {
        var obj = MIDIObjectRef()
        var type = MIDIObjectType.other
        guard MIDIObjectFindByUniqueID(uid, &obj, &type) == noErr,
              type == .destination || type == .externalDestination else { return nil }
        return obj
    }

    static func hostTicks(nanoseconds: UInt64) -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return nanoseconds * UInt64(info.denom) / UInt64(info.numer)
    }
}
