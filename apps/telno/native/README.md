# SCIF for iOS — the native shell

A locked iPhone will not ring for a WebSocket the OS has suspended. This is the
smallest native wrapper that fixes that, using only Apple's own frameworks:

```
  caller ──► Asterisk ──► platform (Dial event) ──► APNs VoIP push
                                                        │
                                          PushKit wakes SCIF (locked)
                                                        │
                                              CallKit draws the call
                                                        │
                                  answer ──► app opens ──► web softphone joins
                                                          (WSS + DTLS-SRTP)
```

- **PushKit** is the only supported way to wake a suspended app for a call.
- **CallKit** is the only supported way to show the system call screen and own
  the audio route — iOS requires the two together and will stop delivering VoIP
  pushes to an app that shows a notification instead.
- **APNs** is free. There is no third-party push service, no certificate that
  expires in a year (a `.p8` key does not), and nothing per message.
- **SFSpeechRecognizer** gives the wrapped app the dictation the browser gets
  from the Web Speech API, which a WKWebView does not have.

The app is a shell around the softphone you already run: one build of the web
app, one place where the switch enforces encryption, caller ID and recording.

## What works, and what does not

| | State |
|---|---|
| A locked phone rings, with the caller's number, from CallKit | Built. Requires the `.p8` on the server and a device token registered. |
| Answering brings the app up and connects the line | Built. `watchCalls` in [native.js](../web/src/native.js) reconnects the softphone on `answered`. |
| Joining *that specific* inbound call after answering | **Not built.** See below. |
| Declining / ending from the CallKit screen | Built. The call is taken down; the switch sees the caller hang up. |
| Video flag on the call screen | Built (passthrough from the ring request). |
| Ringing in the simulator | Not a thing — VoIP push needs a real device. Use `Test ring` on a phone. |
| Voice auth (voiceprint) | Web-based, works in the shell too: the page records, the platform scores. No Apple entitlement involved. |

### The honest gap: answering a call that is already in the switch

CallKit answers the *app*, not the SIP dialog. By the time the user taps Accept,
Asterisk has been ringing the extension for a few seconds and the browser's SIP
registration was not there to take the INVITE. Two real ways forward:

1. **Park it (recommended).** Add a `Park`/`Queue` step to the dialplan for lines
   with push devices, ring the phone with the push, and have the app dial the
   parked slot after answering (`*8` style pickup). This is telephony work in
   [provision.js](../src/telephony/provision.js), not app work, and it is the
   cheapest correct fix.
2. **Hold the registration natively.** A native WebRTC/SIP stack (Linphone SDK,
   WebRTC.framework) that keeps the line registered while suspended. More app to
   maintain, but no switch change and no window where the call is orphaned.

Until one of those exists, a call answered on a locked phone reconnects the line
but the caller may have already gone. Test with the screen on before promising
this to anyone.

## What it costs

- Xcode and the Capacitor tooling: free.
- APNs: free.
- An Apple Developer Program membership: **needed in practice**. A free personal
  team can sideload a build, but it cannot use the Push Notifications capability
  (and builds expire in 7 days), so a VoIP push cannot be tested or shipped with
  it. If Xcode refuses to add Push Notifications to your personal team, that is
  why. TestFlight needs the paid program too.

## Build it

```bash
cd native
npm install
npm run origin -- https://telno.services     # or your host; ?window=1&scif=1 is added
npx cap add ios
npx cap sync ios
npx cap open ios
```

Then in Xcode, once:

1. **Signing & Capabilities** → your team, and change the bundle id if
   `us.innotel.scif` is taken (then set `APNS_BUNDLE_ID` on the server to match).
2. **+ Capability → Push Notifications** (this writes `aps-environment`).
3. **+ Capability → Background Modes** → tick *Audio, AirPlay and Picture in
   Picture*, *Voice over IP*, *Remote notifications*.
4. Copy the three Swift files in [ios/App/App](ios/App/App) into the App group
   (drag them in, "Copy items if needed", target App):
   `ScifCallManager.swift`, `ScifCallPlugin.swift`, `ScifSpeechPlugin.swift`.
5. Copy the keys from [Info.additions.plist](ios/App/App/Info.additions.plist)
   into `Info.plist`. They are not optional: without `voip` background mode the
   push arrives and the app is killed, and without the usage strings the
   microphone and speech APIs crash instead of prompting.
6. In the generated `AppDelegate.swift`, start the call manager once:

   ```swift
   func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
       ScifCallManager.shared.start()
       return true
   }
   ```

   Capacitor registers the plugins itself; nothing else to wire.
7. Run on a **device**, not the simulator.

The app opens the deployed softphone (`server.url`), so a change to the web app
needs no rebuild. `npm run origin -- <url>` rewrites that address, including the
`allowNavigation` list.

## Server side

Create a key in the Apple developer portal: **Certificates, Identifiers &
Profiles → Keys → +**, tick *Apple Push Notifications service (APNs)*, download
the `.p8` once, and note the Key ID. Team ID is on the account page.

Put the key on the data volume and set (compose or `.env`):

```
APNS_ENABLED=true
APNS_KEY_PATH=/data/secrets/AuthKey_ABC123DEFG.p8
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=TEAM123456
APNS_BUNDLE_ID=us.innotel.scif
APNS_ENVIRONMENT=development      # production for TestFlight and the store
```

Restart the container, then check:

```bash
curl -s https://<host>/api/softphone/status -H 'cookie: …' | jq .push
# { enabled: true, configured: true, problem: "", environment: "development", … }
```

`configured: false` carries the reason in `problem` — a missing key, a key that
is not ES256-capable, or a missing Key ID. The push sender signs its own JWT with
`node:crypto`; there is no dependency to install and no token to refresh by hand.

Never commit the `.p8`. It belongs next to the database on the volume, and
`APNS_KEY` (the key inline in the environment) exists only for hosts that have
nowhere to put a file.

## Proving it

1. Open SCIF on the phone, connect the line. The app posts its VoIP token to
   `POST /api/softphone/push/register`; the Voice card lists it under *Ring on a
   locked iPhone*.
2. Press **Test ring** in the Voice card. The phone should ring with the system
   call screen — lock it first; that is the whole point.
3. Call the line's DID. The desk phone and any open browser ring first
   (`PARKING_RING_SECONDS`, 12 by default); when nobody local answers, the call
   is parked in the line's lot and *that* is what rings the phone — the push
   carries the parking space (see `maybeRingForParkedCall`). Answering joins the
   call by dialing the space, so lock-screen answer reaches a caller who is
   already waiting rather than a switch that is still dialing.

Parking only applies to a line that has a phone registered: `Park()` in the
`extensions.conf` block for that extension, `res_parking.conf` for the lot, and
`POST /api/softphone/push/register` regenerates the switch config when the first
phone arrives. `GET /api/softphone/push` reports the lot and its spaces.

If nothing rings: `GET /api/softphone/push?extension=<ext>` shows each device's
last failure (`BadDeviceToken`, `DeviceTokenNotForTopic`, `Unregistered`). A
sandbox token pointed at production is the most common cause, and the row is
removed automatically when APNs reports it unregistered.

If the phone rings but the call is silent, the switch did not park: check
`parking show` in the Asterisk CLI. A lot with no spaces (or a `res_parking.conf`
this switch rejected) means `Park()` fails and there is nothing for the app to
dial.

## Distribution

- **TestFlight** is the fastest honest path: internal testers, no review.
- **App Store**: CallKit has explicit rules — the app must be a real calling app,
  not a wrapper with a call button. A remote-web-view shell plus CallKit is
  likely to be rejected under 4.2 (minimum functionality) and the CallKit
  guidelines. If the store matters, bundle the softphone into the app instead of
  loading it from `server.url`, and ship a native media stack so calls are
  handled in-app.

## Files

| File | What it is |
|---|---|
| [capacitor.config.json](capacitor.config.json) | app id, the deployment it opens, navigation allowlist |
| [ios/App/App/ScifCallManager.swift](ios/App/App/ScifCallManager.swift) | PushKit + CallKit, one owner of each |
| [ios/App/App/ScifCallPlugin.swift](ios/App/App/ScifCallPlugin.swift) | the `ScifCall` bridge: token, test ring, answer/end events |
| [ios/App/App/ScifSpeechPlugin.swift](ios/App/App/ScifSpeechPlugin.swift) | SFSpeechRecognizer for a WKWebView |
| [ios/App/App/App.entitlements](ios/App/App/App.entitlements) | `aps-environment` |
| [ios/App/App/Info.additions.plist](ios/App/App/Info.additions.plist) | background modes and usage strings to merge |
| [../web/src/native.js](../web/src/native.js) | the page's half: register, react, prefer Apple's recogniser |
