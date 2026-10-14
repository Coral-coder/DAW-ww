import AVFoundation

/// AVAudioSession policy for daW³: `.playback` (plays with the silent switch on, keeps playing when the phone is
/// locked thanks to UIBackgroundModes=audio, interrupts other apps' audio — no .mixWithOthers), switching to
/// `.playAndRecord` while the microphone is open (recording audio, humming to notes).
final class AudioSessionManager {
    enum Mode: String { case playback, record }

    static let shared = AudioSessionManager()
    private(set) var mode: Mode = .playback
    /// (event, info) -> forwarded to JS as { type: 'audio', event, info }.
    var onEvent: ((String, [String: Any]) -> Void)?
    private var observers: [NSObjectProtocol] = []

    private init() {
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { [weak self] note in
            guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            switch type {
            case .began:
                self.onEvent?("interruption-began", [:])
            case .ended:
                let opts = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map(AVAudioSession.InterruptionOptions.init(rawValue:)) ?? []
                try? session.setActive(true)
                self.onEvent?("interruption-ended", ["shouldResume": opts.contains(.shouldResume)])
            @unknown default: break
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
            self?.onEvent?("route-change", ["reason": reason, "route": self?.routeInfo() ?? [:]])
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.configure(mode: self.mode)
            self.onEvent?("interruption-ended", ["reset": true])
        })
    }

    @discardableResult
    func configure(mode: Mode) -> Error? {
        let session = AVAudioSession.sharedInstance()
        do {
            switch mode {
            case .playback:
                try session.setCategory(.playback, mode: .default, options: [])
            case .record:
                try session.setCategory(.playAndRecord, mode: .default,
                                        options: [.defaultToSpeaker, .allowBluetoothA2DP])
            }
            try session.setActive(true)
            self.mode = mode
            return nil
        } catch {
            NSLog("[daw3] audio session \(mode.rawValue): \(error)")
            return error
        }
    }

    /// Preferred hardware settings — honoured by USB / Lightning audio interfaces where supported.
    func setPreferred(sampleRate: Double?, ioBufferDuration: Double?) -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        if let sr = sampleRate, sr > 0 { try? session.setPreferredSampleRate(sr) }
        if let io = ioBufferDuration, io > 0 { try? session.setPreferredIOBufferDuration(io) }
        return routeInfo()
    }

    func routeInfo() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        let port: (AVAudioSessionPortDescription) -> [String: Any] = { p in
            ["name": p.portName, "type": p.portType.rawValue, "uid": p.uid,
             "channels": p.channels?.count ?? 0]
        }
        return [
            "category": session.category.rawValue,
            "mode": mode.rawValue,
            "sampleRate": session.sampleRate,
            "ioBufferDuration": session.ioBufferDuration,
            "outputLatency": session.outputLatency,
            "inputLatency": session.inputLatency,
            "inputs": session.currentRoute.inputs.map(port),
            "outputs": session.currentRoute.outputs.map(port),
            "availableInputs": (session.availableInputs ?? []).map(port),
        ]
    }
}
