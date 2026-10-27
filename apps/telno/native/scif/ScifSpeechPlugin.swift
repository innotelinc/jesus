import Foundation
import Capacitor
import Speech
import AVFoundation

/**
 Dictation for the wrapped app.

 iOS has no Web Speech API inside a WKWebView, so the browser's recogniser — which
 is what the web softphone uses on a desktop — simply does not exist here. This
 plugin fills that gap with SFSpeechRecognizer, which is free, part of the OS and
 on most devices runs on-device for the languages that support it.

 JavaScript sees `Capacitor.Plugins.ScifSpeech`:

   available({ lang })   { supported, onDevice }
   recognize({ lang })   starts listening; events: partial, final, error
   stop()                stops listening

 The transcript is used for dialing by voice and for checking that the enrolled
 phrase was said. It is not the voiceprint: identity is decided by the platform
 from the audio, not by what Apple thinks the words were.
 */
@objc(ScifSpeechPlugin)
public class ScifSpeechPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ScifSpeechPlugin"
    public let jsName = "ScifSpeech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let engine = AVAudioEngine()

    @objc func available(_ call: CAPPluginCall) {
        let locale = Locale(identifier: call.getString("lang") ?? "en-US")
        let recognizer = SFSpeechRecognizer(locale: locale)
        call.resolve([
            "supported": recognizer?.isAvailable ?? false,
            "onDevice": recognizer?.supportsOnDeviceRecognition ?? false
        ])
    }

    @objc func recognize(_ call: CAPPluginCall) {
        let locale = Locale(identifier: call.getString("lang") ?? "en-US")
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self else { return }
            guard status == .authorized else {
                self.notifyListeners("error", data: ["message": "Speech recognition permission was refused"])
                return
            }
            DispatchQueue.main.async {
                do {
                    try self.start(locale: locale)
                    call.resolve()
                } catch {
                    self.notifyListeners("error", data: ["message": error.localizedDescription])
                    call.reject(error.localizedDescription)
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopListening()
        call.resolve()
    }

    private func start(locale: Locale) throws {
        stopListening()
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            throw NSError(domain: "SCIF", code: 1, userInfo: [NSLocalizedDescriptionKey: "That language is not available"])
        }
        self.recognizer = recognizer

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // On-device when the language allows it: a dialing phrase should not need
        // to leave the phone, and it keeps working offline.
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }

        engine.prepare()
        try engine.start()

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    self.notifyListeners("final", data: ["text": text])
                    self.stopListening()
                } else {
                    self.notifyListeners("partial", data: ["text": text])
                }
            }
            if let error, (self.task?.state != .completed) {
                self.notifyListeners("error", data: ["message": error.localizedDescription])
                self.stopListening()
            }
        }
    }

    private func stopListening() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
