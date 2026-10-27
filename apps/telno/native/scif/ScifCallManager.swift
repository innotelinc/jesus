import Foundation
import AVFoundation
import CallKit
import PushKit
import UIKit

/**
 The two Apple frameworks a line needs to ring on a locked iPhone.

 PushKit is how the platform reaches a suspended app at all: a VoIP push wakes
 it for a few seconds, which is exactly long enough to tell CallKit there is a
 call. CallKit is the only supported way to draw the system call screen and take
 over the audio route, and iOS requires the two to be used together — a VoIP push
 that does not report a call to CallKit is a bug the OS will eventually kill the
 app for.

 The manager is a singleton because PushKit and CallKit both want exactly one
 owner each. It holds no media: answering brings the app forward, and the
 softphone that is already in the web view joins the call over SRTP.
 */
@objc(ScifCallManager)
public final class ScifCallManager: NSObject, PKPushRegistryDelegate, CXProviderDelegate {

    @objc public static let shared = ScifCallManager()

    private var registry: PKPushRegistry?
    private var provider: CXProvider?

    /// CallKit is driven by transactions requested through a controller, not by
    /// the provider directly: ending a call is a CXEndCallAction handed to this.
    private let callController = CXCallController()

    /// Calls CallKit is showing, by our own id, plus the mapping to its UUIDs.
    private var pending: [String: [String: Any]] = [:]
    private var uuidToCall: [UUID: String] = [:]
    private var callToUuid: [String: UUID] = [:]

    /// The VoIP token, as hex. The web side posts this to the platform.
    @objc public private(set) var tokenHex: String = ""

    /// The call currently being offered, so a second push does not stack rings.
    @objc public private(set) var ringing: String = ""

    var onToken: ((String) -> Void)?
    var onIncoming: (([String: Any]) -> Void)?
    var onAnswered: ((String) -> Void)?
    var onEnded: ((String, String) -> Void)?

    /**
     Registering is idempotent and safe to call from a push, a plugin method or
     launch: the two frameworks are created once and reused.
     */
    @objc public func start() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.start() }
            return
        }
        if registry == nil {
            let registry = PKPushRegistry(queue: .main)
            registry.delegate = self
            registry.desiredPushTypes = [.voIP]
            self.registry = registry
        }
        if provider == nil {
            let configuration = CXProviderConfiguration()
            configuration.supportsVideo = true
            configuration.maximumCallGroups = 1
            configuration.maximumCallsPerCallGroup = 1
            configuration.supportedHandleTypes = [.phoneNumber, .generic]
            let provider = CXProvider(configuration: configuration)
            provider.setDelegate(self, queue: .main)
            self.provider = provider
        }
    }

    /* ------------------------------------------------------------- PushKit */

    public func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let hex = credentials.token.map { String(format: "%02x", $0) }.joined()
        tokenHex = hex
        onToken?(hex)
    }

    public func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        let call = payload.dictionaryPayload["call"] as? [String: Any] ?? [:]
        // CallKit must be told before this returns, or iOS treats the push as a
        // missed call and may stop delivering them.
        report(call: call)
        completion()
    }

    public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        tokenHex = ""
        onToken?("")
    }

    /* ------------------------------------------------------------ CallKit */

    /**
     Show an incoming call. Called from PushKit, and from the plugin so the line
     can be proved end to end without waiting for a real call.
     */
    @objc public func report(call: [String: Any]) {
        start()
        guard let provider else { return }

        let id = (call["id"] as? String) ?? UUID().uuidString
        let from = (call["from"] as? String) ?? ""
        let display = (call["display"] as? String) ?? (from.isEmpty ? "Unknown caller" : from)
        let video = (call["video"] as? Bool) ?? false

        let handle = CXHandle(type: from.isEmpty ? .generic : .phoneNumber, value: from.isEmpty ? display : from)
        let update = CXCallUpdate()
        update.remoteHandle = handle
        update.localizedCallerName = display
        update.hasVideo = video
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = true

        let uuid = UUID()
        pending[id] = call
        uuidToCall[uuid] = id
        callToUuid[id] = uuid
        ringing = id
        onIncoming?(call)

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            guard let self else { return }
            if let error {
                NSLog("SCIF: CallKit refused the call: %@", error.localizedDescription)
                self.forget(callId: id)
                self.ringing = ""
                self.onEnded?(id, "failed")
            }
        }
    }

    /** Hang up from the app's side, e.g. the caller gave up. */
    @objc public func endCall(id: String, reason: String = "remoteEnded") {
        guard let uuid = callToUuid[id] else { return }
        let ended = CXEndCallAction(call: uuid)
        callController.request(CXTransaction(action: ended)) { error in
            if let error {
                NSLog("SCIF: CallKit refused to end the call: %@", error.localizedDescription)
            }
        }
        forget(callId: id)
        ringing = ""
        onEnded?(id, reason)
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        guard let id = uuidToCall[action.callUUID] else {
            action.fail()
            return
        }
        ringing = ""
        // The user has taken the call; the app comes forward and the softphone
        // joins it. CallKit owns the audio session from here.
        onAnswered?(id)
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        guard let id = uuidToCall[action.callUUID] else {
            action.fail()
            return
        }
        ringing = ""
        forget(callId: id)
        onEnded?(id, "declined")
        action.fulfill()
    }

    public func providerDidReset(_ provider: CXProvider) {
        pending.removeAll()
        uuidToCall.removeAll()
        callToUuid.removeAll()
        ringing = ""
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // Voice chat mode, speaker by default: a phone held to an ear and a phone
        // on a desk both need this to sound like a call.
        do {
            try audioSession.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker]
            )
            try audioSession.setActive(true)
        } catch {
            NSLog("SCIF: audio session could not start: %@", error.localizedDescription)
        }
    }

    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
    }

    /* ------------------------------------------------------------- helpers */

    private func forget(callId: String) {
        pending.removeValue(forKey: callId)
        if let uuid = callToUuid.removeValue(forKey: callId) {
            uuidToCall.removeValue(forKey: uuid)
        }
    }
}
