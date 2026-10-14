import AVFoundation
import AudioToolbox

/// Discovery of installed Audio Unit (v3 app-extension and system) components — step 1 of AUv3 hosting
/// (see ios/README.md, "AUv3 hosting"). Hosting itself (instantiate, render, show UI) is not wired up yet.
enum AUv3Catalog {
    static let kinds: [(kind: String, type: OSType)] = [
        ("instrument", kAudioUnitType_MusicDevice),       // 'aumu'
        ("effect", kAudioUnitType_Effect),                // 'aufx'
        ("music-effect", kAudioUnitType_MusicEffect),     // 'aumf' (effect that takes MIDI)
        ("midi-processor", kAudioUnitType_MIDIProcessor), // 'aumi'
        ("generator", kAudioUnitType_Generator),          // 'augn'
    ]

    static func fourCC(_ v: OSType) -> String {
        let bytes = [UInt8((v >> 24) & 0xFF), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
        return String(bytes: bytes, encoding: .macOSRoman) ?? String(v)
    }

    /// kind: nil / "all" for every kind, else one of `kinds`.
    static func list(kind: String?) -> [[String: Any]] {
        let wanted = kinds.filter { kind == nil || kind == "all" || kind == "" || $0.kind == kind }
        var out: [[String: Any]] = []
        for (name, type) in wanted {
            let desc = AudioComponentDescription(componentType: type, componentSubType: 0, componentManufacturer: 0,
                                                 componentFlags: 0, componentFlagsMask: 0)
            for c in AVAudioUnitComponentManager.shared().components(matching: desc) {
                let d = c.audioComponentDescription
                out.append([
                    "name": c.name,
                    "manufacturer": c.manufacturerName,
                    "kind": name,
                    "typeName": c.typeName,
                    "type": fourCC(d.componentType),
                    "subtype": fourCC(d.componentSubType),
                    "manufacturerCode": fourCC(d.componentManufacturer),
                    "version": c.versionString,
                    "hasMIDIInput": c.hasMIDIInput,
                    "hasMIDIOutput": c.hasMIDIOutput,
                    "tags": c.allTagNames,
                    // v3 app extensions are out-of-process: kAudioComponentFlag_IsV3AudioUnit
                    "isV3": (d.componentFlags & AudioComponentFlags.isV3AudioUnit.rawValue) != 0,
                ])
            }
        }
        return out
    }
}
