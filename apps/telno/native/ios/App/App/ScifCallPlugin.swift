import Foundation
import Capacitor
import UIKit

/**
 The bridge between the web softphone and the native call screen.

 JavaScript sees this as `Capacitor.Plugins.ScifCall`:

   register()                      start PushKit/CallKit, resolve the token
   token()                         the current VoIP token, "" until one arrives
   state()                         { token, ringing }
   ring({ from, display, video })  show a test call through CallKit
   endCall({ id })                 take a ringing call down

 and it receives events: `token`, `incomingCall`, `answered`, `ended`.

 Nothing is decided here. Which line the token belongs to, and whether it may
 ring, is the platform's answer — the app only carries the identifiers.
 */
@objc(ScifCallPlugin)
public class ScifCallPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "ScifCallPlugin"
    public let jsName = "ScifCall"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "token", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCall", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        let manager = ScifCallManager.shared
        manager.onToken = { [weak self] token in
            self?.notifyListeners("token", data: ["token": token])
        }
        manager.onIncoming = { [weak self] call in
            self?.notifyListeners("incomingCall", data: call)
        }
        manager.onAnswered = { [weak self] callId in
            self?.notifyListeners("answered", data: ["id": callId])
        }
        manager.onEnded = { [weak self] callId, reason in
            self?.notifyListeners("ended", data: ["id": callId, "reason": reason])
        }
    }

    @objc func register(_ call: CAPPluginCall) {
        ScifCallManager.shared.start()
        call.resolve([
            "token": ScifCallManager.shared.tokenHex,
            "callKit": true,
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            // The platform has to know which APNs the token belongs to: a debug
            // build is signed against the sandbox and a TestFlight build is not.
            "debug": ScifCallPlugin.isDebugBuild
        ])
    }

    @objc func token(_ call: CAPPluginCall) {
        call.resolve(["token": ScifCallManager.shared.tokenHex])
    }

    @objc func state(_ call: CAPPluginCall) {
        call.resolve([
            "token": ScifCallManager.shared.tokenHex,
            "ringing": ScifCallManager.shared.ringing,
            "bundleId": Bundle.main.bundleIdentifier ?? "",
            "debug": ScifCallPlugin.isDebugBuild
        ])
    }

    static var isDebugBuild: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    @objc func ring(_ call: CAPPluginCall) {
        guard let from = call.getString("from"), !from.isEmpty else {
            call.reject("ring needs a number to show")
            return
        }
        let id = call.getString("id") ?? UUID().uuidString
        ScifCallManager.shared.report(call: [
            "id": id,
            "from": from,
            "display": call.getString("display") ?? from,
            "video": call.getBool("video") ?? false
        ])
        call.resolve(["id": id])
    }

    @objc func endCall(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ScifCallManager.shared.ringing
        guard !id.isEmpty else {
            call.reject("No call is ringing")
            return
        }
        ScifCallManager.shared.endCall(id: id)
        call.resolve(["id": id])
    }
}
