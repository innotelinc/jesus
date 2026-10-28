import Foundation
import Capacitor
import LocalAuthentication

/**
 Unlock with a face or a fingerprint.

 The line can be set to stay dark until Face ID recognizes the person holding
 the phone, which is the one security step iOS will not let a web page do: a
 browser tab cannot ask for a face, and a browser-stored secret is readable by
 anything running on the page. LocalAuthentication is free, part of the OS, and
 handled entirely by the Secure Enclave — this plugin never sees biometric data,
 only Apple's verdict.

 JavaScript sees `Capacitor.Plugins.ScifBiometrics`:

   available()                             { supported, biometryType, label, reason }
   authenticate({ reason, allowPasscode })  { ok, method } — or a rejection

 `authenticate` prefers the enrolled face/finger; when the device has none, or
 Apple declines the request, it falls back to the device passcode if
 `allowPasscode` is set. That fallback is deliberate: a phone with no enrolled
 face must not leave a line permanently locked out, and Apple's own passcode is
 still a gate the person holding the phone has to pass.
 */
@objc(ScifBiometricsPlugin)
public class ScifBiometricsPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ScifBiometricsPlugin"
    public let jsName = "ScifBiometrics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise)
    ]

    @objc func available(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        let supported = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        call.resolve([
            "supported": supported,
            "biometryType": ScifBiometricsPlugin.name(for: context.biometryType),
            "label": ScifBiometricsPlugin.label(for: context.biometryType),
            // canEvaluatePolicy is false when nothing is enrolled, so an
            // unsupported answer here usually means "no face set up yet".
            "reason": supported ? "" : (error?.localizedDescription ?? "No face or fingerprint is enrolled on this device")
        ])
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Unlock this line"
        let allowPasscode = call.getBool("allowPasscode") ?? true

        let context = LAContext()
        context.localizedFallbackTitle = allowPasscode ? "Use Passcode" : ""

        var error: NSError?
        var policy: LAPolicy = .deviceOwnerAuthenticationWithBiometrics
        if !context.canEvaluatePolicy(policy, error: &error) {
            guard allowPasscode, context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
                call.reject(error?.localizedDescription ?? "This device cannot unlock the line")
                return
            }
            policy = .deviceOwnerAuthentication
        }

        // Which policy actually ran decides what the page reports back, and the
        // two are not the same promise: a passcode is not a face.
        let asked = context.biometryType
        let usedPasscode = policy == .deviceOwnerAuthentication

        DispatchQueue.main.async {
            context.evaluatePolicy(policy, localizedReason: reason) { success, authError in
                DispatchQueue.main.async {
                    if success {
                        call.resolve([
                            "ok": true,
                            "method": usedPasscode ? "passcode" : ScifBiometricsPlugin.name(for: asked)
                        ])
                    } else {
                        // A cancel is a cancel, not a failure to report as scary.
                        let cancelled = (authError as? LAError)?.code == .userCancel
                            || (authError as? LAError)?.code == .systemCancel
                        call.reject(cancelled ? "Unlock cancelled" : (authError?.localizedDescription ?? "Not unlocked"))
                    }
                }
            }
        }
    }

    static func name(for type: LABiometryType) -> String {
        switch type {
        case .faceID: return "face"
        case .touchID: return "touch"
        default: return "biometric"
        }
    }

    static func label(for type: LABiometryType) -> String {
        switch type {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "Biometric unlock"
        }
    }
}
