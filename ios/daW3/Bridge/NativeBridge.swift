import UIKit
import UniformTypeIdentifiers
import WebKit

/// The native half of window.daw3Native (JS half: daW3/Web/daw3-native.js).
/// JS -> native: webkit.messageHandlers.daw3.postMessage({ v: 1, cmd, args }) answered through the reply handler.
/// Native -> JS: batched events through window.__daw3NativeReceive([...]).
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = NativeBridge()
    static let handlerName = "daw3"
    static let protocolVersion = 1

    weak var webView: WKWebView?
    weak var presenter: UIViewController?

    private var pageReady = false
    private var pendingCommands: [[String: Any]] = []
    private var outbox: [[String: Any]] = []
    private var flushScheduled = false
    private var activePicker: DocumentPickerCoordinator?

    struct BridgeError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    override init() {
        super.init()
        MIDIManager.shared.onMessage = { [weak self] id, bytes in
            self?.emit(["type": "midi", "id": id, "data": bytes.map(Int.init)])
        }
        MIDIManager.shared.onStateChange = { [weak self] in
            var ev = MIDIManager.shared.state()
            ev["type"] = "midi-state"
            self?.emit(ev)
        }
        AudioSessionManager.shared.onEvent = { [weak self] event, info in
            self?.emit(["type": "audio", "event": event, "info": info])
        }
    }

    /// The page reloaded (or the web process restarted): commands wait for ready() again.
    func pageWillLoad() {
        pageReady = false
    }

    // MARK: JS -> native

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "daw3Native: malformed message (expected { v, cmd, args })")
            return
        }
        let args = body["args"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do {
                let result = try await self.handle(cmd, args)
                replyHandler(result ?? NSNull(), nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }

    /// Every command the JS bridge sends. Keep in sync with daw3-native.js (tests/ios-bridge.test.js checks it).
    func handle(_ cmd: String, _ args: [String: Any]) async throws -> Any? {
        switch cmd {
        case "info":
            let info = Bundle.main.infoDictionary ?? [:]
            return [
                "platform": "ios",
                "bridgeVersion": Self.protocolVersion,
                "version": info["CFBundleShortVersionString"] as? String ?? "",
                "build": info["CFBundleVersion"] as? String ?? "",
                "os": UIDevice.current.systemVersion,
                "model": UIDevice.current.model,
                "idiom": UIDevice.current.userInterfaceIdiom == .pad ? "pad" : "phone",
            ] as [String: Any]
        case "ready":
            pageReady = true
            let queued = pendingCommands
            pendingCommands.removeAll()
            for ev in queued { emit(ev) }
            return true
        case "openFiles":
            let types = Self.contentTypes(kind: args["kind"] as? String ?? "any")
            let urls = try await pickDocuments(types: types, multiple: args["multiple"] as? Bool ?? false)
            return urls.map { FileRegistry.shared.register($0) }
        case "readFile":
            guard let path = args["path"] as? String, let d = FileRegistry.shared.descriptor(forPath: path) else {
                throw BridgeError(message: "readFile: unknown path (only files picked or opened this session can be read)")
            }
            return d
        case "saveFile":
            let url = try writeTemp(args)
            return try await exportDocument(url)
        case "share":
            let url = try writeTemp(args)
            return try await shareDocument(url, title: args["title"] as? String)
        case "midi.access":
            try MIDIManager.shared.start()
            return MIDIManager.shared.state()
        case "midi.list":
            if !MIDIManager.shared.started { try MIDIManager.shared.start() }
            return MIDIManager.shared.state()
        case "midi.send":
            guard let id = args["id"] as? String, let data = args["data"] as? [NSNumber] else {
                throw BridgeError(message: "midi.send: expected { id, data: [bytes], delay }")
            }
            let delay = (args["delay"] as? NSNumber)?.doubleValue ?? 0
            try MIDIManager.shared.send(id: id, bytes: data.map { UInt8(truncatingIfNeeded: $0.intValue) }, delayMs: delay)
            return true
        case "audio.session":
            let mode = AudioSessionManager.Mode(rawValue: args["mode"] as? String ?? "playback") ?? .playback
            if let err = AudioSessionManager.shared.configure(mode: mode) { throw err }
            return mode.rawValue
        case "audio.route":
            return AudioSessionManager.shared.routeInfo()
        case "audio.preferred":
            return AudioSessionManager.shared.setPreferred(
                sampleRate: (args["sampleRate"] as? NSNumber)?.doubleValue,
                ioBufferDuration: (args["ioBufferDuration"] as? NSNumber)?.doubleValue)
        case "auv3.list":
            return AUv3Catalog.list(kind: args["kind"] as? String)
        default:
            throw BridgeError(message: "daw3Native: unknown command \(cmd)")
        }
    }

    // MARK: native -> JS

    /// Queue an event for JS; events are batched into one evaluateJavaScript per main-loop turn.
    func emit(_ event: [String: Any]) {
        outbox.append(event)
        guard !flushScheduled else { return }
        flushScheduled = true
        DispatchQueue.main.async { [weak self] in self?.flush() }
    }

    private func flush() {
        flushScheduled = false
        guard let webView, !outbox.isEmpty else { return }
        let batch = outbox
        outbox.removeAll()
        guard let json = try? JSONSerialization.data(withJSONObject: batch), let text = String(data: json, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__daw3NativeReceive && window.__daw3NativeReceive(\(text));", completionHandler: nil)
    }

    /// App command for the page (queued until the page called daw3Native.ready()).
    func sendCommand(_ cmd: String, payload: Any) {
        let ev: [String: Any] = ["type": "command", "cmd": cmd, "payload": payload]
        if pageReady { emit(ev) } else { pendingCommands.append(ev) }
    }

    /// Documents opened from Files / AirDrop / another app's "Open in…".
    func openDocuments(_ urls: [URL]) {
        let files = urls.map { url -> [String: Any] in
            let d = FileRegistry.shared.register(url)
            // LSSupportsOpeningDocumentsInPlace = NO: iOS copied the file into Documents/Inbox; we keep our own copy.
            if url.path.contains("/Inbox/") { try? FileManager.default.removeItem(at: url) }
            return d
        }
        sendCommand("open-files", payload: ["files": files])
    }

    // MARK: files

    static func contentTypes(kind: String) -> [UTType] {
        let project = UTType(exportedAs: "com.coralcoder.daw3.project", conformingTo: .json)
        switch kind {
        case "audio": return [.audio]
        case "project": return [project, .json]
        case "midi": return [.midi]
        default: return [project, .audio, .midi, .json, .data]
        }
    }

    private func writeTemp(_ args: [String: Any]) throws -> URL {
        let raw = (args["name"] as? String) ?? "untitled"
        let name = raw.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        guard let b64 = args["data"] as? String, let data = Data(base64Encoded: b64) else {
            throw BridgeError(message: "saveFile: data must be base64")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("export/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(name.isEmpty ? "untitled" : name)
        try data.write(to: url, options: .atomic)
        return url
    }

    private func requirePresenter() throws -> UIViewController {
        guard var vc = presenter ?? webView?.window?.rootViewController else { throw BridgeError(message: "no window to present from") }
        while let p = vc.presentedViewController, !p.isBeingDismissed { vc = p }
        return vc
    }

    private func pickDocuments(types: [UTType], multiple: Bool) async throws -> [URL] {
        let vc = try requirePresenter()
        return await withCheckedContinuation { cont in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = multiple
            let coordinator = DocumentPickerCoordinator { [weak self] urls in
                self?.activePicker = nil
                cont.resume(returning: urls)
            }
            activePicker = coordinator
            picker.delegate = coordinator
            vc.present(picker, animated: true)
        }
    }

    private func exportDocument(_ url: URL) async throws -> Any {
        let vc = try requirePresenter()
        let urls: [URL] = await withCheckedContinuation { cont in
            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            let coordinator = DocumentPickerCoordinator { [weak self] urls in
                self?.activePicker = nil
                cont.resume(returning: urls)
            }
            activePicker = coordinator
            picker.delegate = coordinator
            vc.present(picker, animated: true)
        }
        return urls.first?.lastPathComponent ?? NSNull()
    }

    private func shareDocument(_ url: URL, title: String?) async throws -> Bool {
        let vc = try requirePresenter()
        return await withCheckedContinuation { cont in
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let title, !title.isEmpty { sheet.setValue(title, forKey: "subject") }
            sheet.completionWithItemsHandler = { _, completed, _, _ in cont.resume(returning: completed) }
            if let pop = sheet.popoverPresentationController { // iPad
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.maxY - 80, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            vc.present(sheet, animated: true)
        }
    }
}

/// UIDocumentPickerDelegate that reports exactly once (picked URLs, or [] when cancelled).
final class DocumentPickerCoordinator: NSObject, UIDocumentPickerDelegate {
    private var done: (([URL]) -> Void)?
    init(_ done: @escaping ([URL]) -> Void) { self.done = done }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        done?(urls); done = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        done?([]); done = nil
    }
}
