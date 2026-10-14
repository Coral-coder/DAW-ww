import CoreMIDI
import WebKit
import XCTest
@testable import daW3

/// Runs inside the app (hosted unit tests): the real WKWebView, scheme handler, bridge and CoreMIDI.
@MainActor
final class AppLaunchTests: XCTestCase {
    private func webView(timeout: TimeInterval = 90) async throws -> WKWebView {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let vc = WebViewController.current, vc.didFinishLoad, let wv = vc.webView {
                if let ok = try? await wv.callAsyncJavaScript("return !!(window.daw3 && window.daw3.store && window.daw3.actions)",
                                                              contentWorld: .page) as? Bool, ok {
                    return wv
                }
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        let diag = try? await WebViewController.current?.webView.callAsyncJavaScript(
            "return document.getElementById('app')?.textContent?.slice(0, 300) || document.readyState", contentWorld: .page)
        XCTFail("daW³ did not start within \(Int(timeout))s (page: \(String(describing: diag)))")
        throw XCTSkip("web app not ready")
    }

    private func js(_ wv: WKWebView, _ body: String) async throws -> Any? {
        try await wv.callAsyncJavaScript(body, contentWorld: .page)
    }

    private func poll(_ wv: WKWebView, _ body: String, timeout: TimeInterval = 10) async throws -> Any? {
        let deadline = Date().addingTimeInterval(timeout)
        var last: Any?
        while Date() < deadline {
            last = try await js(wv, body)
            if let b = last as? Bool, b { return last }
            if let s = last as? String, !s.isEmpty { return last }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return last
    }

    func testAppBootsPocketWithNativeBridge() async throws {
        let wv = try await webView()
        let platform = try await js(wv, "return window.daw3 && window.daw3Native.platform") as? String
        XCTAssertEqual(platform, "ios")
        let pocket = try await js(wv, "return document.documentElement.classList.contains('pocket')") as? Bool
        XCTAssertEqual(pocket, true, "iPhone should start in the Pocket layout")
        let native = try await poll(wv, "return document.documentElement.dataset.native || ''", timeout: 30) as? String
        XCTAssertEqual(native, "ios", "Pocket installs its native command handlers")
        let info = try await js(wv, "return await window.daw3Native.info()") as? [String: Any]
        XCTAssertEqual(info?["platform"] as? String, "ios")
        let hasMidi = try await js(wv, "return typeof navigator.requestMIDIAccess === 'function'") as? Bool
        XCTAssertEqual(hasMidi, true)
    }

    func testAUv3DiscoveryAndAudioRoute() async throws {
        let wv = try await webView()
        let count = try await js(wv, "const l = await window.daw3Native.auv3.list(); return Array.isArray(l) ? l.length : -1") as? Int
        XCTAssertNotNil(count)
        XCTAssertGreaterThanOrEqual(count ?? -1, 0)
        let category = try await js(wv, "return (await window.daw3Native.audio.route()).category") as? String
        XCTAssertNotNil(category)
    }

    func testUMPRoundTrip() {
        var sx: [UInt8] = []
        let msgs: [[UInt8]] = [[0x90, 60, 100], [0xC3, 5], [0xF8], [0xF0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xF7], [0xF0, 0x7E, 0xF7]]
        for m in msgs {
            let words = UMP.encode(m).flatMap { $0 }
            XCTAssertEqual(UMP.decode(words, sysex: &sx), [m], "round trip \(m)")
        }
    }

    /// Virtual CoreMIDI source -> navigator.requestMIDIAccess polyfill -> onmidimessage; and output.send -> virtual destination.
    func testWebMIDIShimWithVirtualCoreMIDIEndpoints() async throws {
        let wv = try await webView()

        var client = MIDIClientRef()
        guard MIDIClientCreateWithBlock("daW3 Tests" as CFString, &client, nil) == noErr else {
            throw XCTSkip("CoreMIDI is unavailable in this simulator")
        }
        var source = MIDIEndpointRef()
        XCTAssertEqual(MIDISourceCreateWithProtocol(client, "daW3 Test Source" as CFString, ._1_0, &source), noErr)
        let received = Received()
        var dest = MIDIEndpointRef()
        XCTAssertEqual(MIDIDestinationCreateWithProtocol(client, "daW3 Test Dest" as CFString, ._1_0, &dest) { list, _ in
            var sx: [UInt8] = []
            for packet in list.unsafeSequence() {
                let n = Int(packet.pointee.wordCount)
                let words: [UInt32] = withUnsafeBytes(of: packet.pointee.words) { Array($0.bindMemory(to: UInt32.self).prefix(n)) }
                received.append(UMP.decode(words, sysex: &sx))
            }
        }, noErr)
        defer {
            MIDIEndpointDispose(source)
            MIDIEndpointDispose(dest)
            MIDIClientDispose(client)
        }

        let setup = try await poll(wv, """
            const acc = await navigator.requestMIDIAccess();
            const inp = [...acc.inputs.values()].find((i) => i.name.includes('daW3 Test Source'));
            const out = [...acc.outputs.values()].find((o) => o.name.includes('daW3 Test Dest'));
            if (!inp || !out) return false;
            window.__midiGot = [];
            inp.onmidimessage = (e) => window.__midiGot.push(Array.from(e.data));
            window.__midiOut = out;
            return 'ok';
            """, timeout: 15)
        guard (setup as? String) == "ok" else {
            let names = try? await js(wv, "const a = await navigator.requestMIDIAccess(); return JSON.stringify({ i: [...a.inputs.values()].map((p) => p.name), o: [...a.outputs.values()].map((p) => p.name) })")
            return XCTFail("virtual endpoints not visible to the Web MIDI shim: \(String(describing: names))")
        }

        // CoreMIDI -> JS
        var list = MIDIEventList()
        var packet: UnsafeMutablePointer<MIDIEventPacket> = MIDIEventListInit(&list, ._1_0)
        let words = UMP.encode([0x90, 60, 100]).flatMap { $0 }
        packet = MIDIEventListAdd(&list, MemoryLayout<MIDIEventList>.size, packet, 0, words.count, words)
        _ = packet
        XCTAssertEqual(MIDIReceivedEventList(source, &list), noErr)
        let got = try await poll(wv, "return window.__midiGot.length ? JSON.stringify(window.__midiGot) : ''") as? String
        XCTAssertEqual(got, "[[144,60,100]]")

        // JS -> CoreMIDI
        _ = try await js(wv, "window.__midiOut.send([0x80, 64, 0]); return true")
        let deadline = Date().addingTimeInterval(10)
        while received.messages.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertEqual(received.messages, [[0x80, 64, 0]])
    }
}

final class Received: @unchecked Sendable {
    private let lock = NSLock()
    private var store: [[UInt8]] = []
    func append(_ m: [[UInt8]]) { lock.lock(); store += m; lock.unlock() }
    var messages: [[UInt8]] { lock.lock(); defer { lock.unlock() }; return store }
}
