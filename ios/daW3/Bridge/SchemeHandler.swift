import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the bundled web app at daw3://localhost/… so ES modules, fetch(), AudioWorklet modules and
/// localStorage / IndexedDB all work offline with a stable origin. Also serves files the user picked or opened
/// (/__files/<token>/<name>) so the page can fetch() their bytes without base64 round-trips.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "daw3"
    static let host = "localhost"
    static var origin: String { "\(scheme)://\(host)" }

    let root: URL
    private var stopped = Set<ObjectIdentifier>()
    private let lock = NSLock()

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    /// Bundle folder holding index.html, src/, styles/, vendor/, icons/ (copied by ios/scripts/bundle-web.sh).
    static var bundledWebRoot: URL {
        Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        lock.lock(); stopped.remove(id); lock.unlock()
        guard let url = task.request.url else { return fail(task, 400) }
        let resolved = resolve(url)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            guard let fileURL = resolved, let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
                return self.finish(task, id: id, status: 404, mime: "text/plain", data: Data("Not found: \(url.path)".utf8))
            }
            self.finish(task, id: id, status: 200, mime: Self.mimeType(for: fileURL), data: data)
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        lock.lock(); stopped.insert(ObjectIdentifier(task)); lock.unlock()
    }

    /// URL -> file inside the web root (or a registered user file); nil when outside / missing.
    func resolve(_ url: URL) -> URL? {
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        if path.hasPrefix("/__files/") {
            let parts = path.split(separator: "/", omittingEmptySubsequences: true)
            guard parts.count >= 2 else { return nil }
            return FileRegistry.shared.url(forToken: String(parts[1]))
        }
        let candidate = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard candidate.path.hasPrefix(root.path + "/") || candidate.path == root.path else { return nil }
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDir) else { return nil }
        return isDir.boolValue ? candidate.appendingPathComponent("index.html") : candidate
    }

    private func finish(_ task: WKURLSchemeTask, id: ObjectIdentifier, status: Int, mime: String, data: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.lock.lock(); let isStopped = self.stopped.remove(id) != nil; self.lock.unlock()
            if isStopped { return }
            guard let url = task.request.url else { return }
            let headers = [
                "Content-Type": mime,
                "Content-Length": String(data.count),
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache",
            ]
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            task.didReceive(response)
            task.didReceive(data)
            task.didFinish()
        }
    }

    private func fail(_ task: WKURLSchemeTask, _ code: Int) {
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL))
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs", "cjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "txt", "strudel", "md": return "text/plain; charset=utf-8"
        case "wav": return "audio/wav"
        case "mp3": return "audio/mpeg"
        case "ogg": return "audio/ogg"
        case "m4a": return "audio/mp4"
        case "mid", "midi": return "audio/midi"
        case "daw3": return "application/json"
        default:
            return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}

/// Files the user picked / opened this session, addressable by token (and by the `path` string handed to JS).
final class FileRegistry {
    static let shared = FileRegistry()
    private var byToken: [String: URL] = [:]
    private let lock = NSLock()

    /// Copies `url` into the app's temporary folder (picker copies and Inbox files are short-lived) and registers it.
    func register(_ url: URL, copy: Bool = true) -> [String: Any] {
        let token = UUID().uuidString.lowercased()
        var stored = url
        if copy {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("files/\(token)", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dest = dir.appendingPathComponent(url.lastPathComponent)
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if (try? FileManager.default.copyItem(at: url, to: dest)) != nil { stored = dest }
        }
        lock.lock(); byToken[token] = stored; lock.unlock()
        return Self.descriptor(token: token, url: stored)
    }

    func url(forToken token: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        return byToken[token]
    }

    /// `path` strings look like "files/<token>/<name>".
    func descriptor(forPath path: String) -> [String: Any]? {
        let parts = path.split(separator: "/")
        guard parts.count >= 2, parts[0] == "files", let url = url(forToken: String(parts[1])) else { return nil }
        return Self.descriptor(token: String(parts[1]), url: url)
    }

    static func descriptor(token: String, url: URL) -> [String: Any] {
        let name = url.lastPathComponent
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "file"
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return [
            "name": name,
            "path": "files/\(token)/\(name)",
            "url": "\(SchemeHandler.origin)/__files/\(token)/\(encoded)",
            "size": size,
        ]
    }
}
