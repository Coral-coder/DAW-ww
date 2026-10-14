import UIKit
import WebKit

/// Full-screen WKWebView running daW³ Pocket from the app bundle (daw3://localhost/).
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    /// The live instance (tests reach the web view through it).
    static weak var current: WebViewController?

    private(set) var webView: WKWebView!
    /// True once the first navigation finished.
    private(set) var didFinishLoad = false

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(root: SchemeHandler.bundledWebRoot), forURLScheme: SchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.websiteDataStore = .default() // persistent localStorage / IndexedDB (autosaves, recent songs)

        let ucc = config.userContentController
        if let url = Bundle.main.url(forResource: "daw3-native", withExtension: "js"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            ucc.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        } else {
            NSLog("[daw3] daw3-native.js missing from the bundle")
        }
        // Pocket is the iOS layout: default the remembered layout choice to Pocket (the in-app menu can still switch).
        ucc.addUserScript(WKUserScript(source: "try{if(!localStorage.getItem('daw3-layout'))localStorage.setItem('daw3-layout','pocket')}catch(e){}",
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(NativeBridge.shared, contentWorld: .page, name: NativeBridge.handlerName)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x0e / 255, green: 0x0f / 255, blue: 0x14 / 255, alpha: 1)
        if #available(iOS 16.4, *) { webView.isInspectable = true } // Safari ▸ Develop ▸ <device> ▸ daW³
        self.webView = webView
        view = webView
        NativeBridge.shared.webView = webView
        NativeBridge.shared.presenter = self
        WebViewController.current = self
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        load()
    }

    static var startURL: URL {
        // iPhone: always Pocket. iPad: Pocket by default (remembered choice wins), desktop layout available.
        let query = UIDevice.current.userInterfaceIdiom == .phone ? "?mobile=1" : ""
        return URL(string: "\(SchemeHandler.origin)/index.html\(query)")!
    }

    func load() {
        NativeBridge.shared.pageWillLoad()
        didFinishLoad = false
        webView.load(URLRequest(url: Self.startURL))
    }

    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        didFinishLoad = true
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == SchemeHandler.scheme || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            return decisionHandler(.allow)
        }
        // External links (About ▸ source code, docs): Safari.
        if action.navigationType == .linkActivated || action.targetFrame == nil {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow) // subframes / fetches of remote content
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("[daw3] web content process terminated — reloading")
        load()
    }

    // MARK: WKUIDelegate

    /// window.open / target=_blank -> Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
        return nil
    }

    /// Microphone for recording / humming: iOS shows its own permission prompt (NSMicrophoneUsageDescription).
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .microphone ? .grant : .prompt)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}
