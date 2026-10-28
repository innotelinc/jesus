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
| Face ID / Touch ID unlock | Built. SCIF → *Require Face ID to unlock this line* keeps the line unregistered until `LocalAuthentication` recognizes you. Falls back to the device passcode when no face is enrolled. |

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
npx cap add ios                              # generates ios/ (gitignored)
npx cap sync ios
npm run prep                                 # copies the wrapper in, merges plists, patches AppDelegate
gem install xcodeproj                        # once
TEAM_ID=ABCDE12345 APP_BUNDLE_ID=us.innotel.scif APP_BUILD=1 npm run project
npm run open                                 # Xcode
```

`cap add ios` writes an empty template; everything SCIF needs is applied by the
last three commands rather than by clicking through Xcode, because the same
steps run in CI ([.github/workflows/ios.yml](../.github/workflows/ios.yml)) and a
step that only exists in someone's memory is a step that gets missed:

| Applied | By |
|---|---|
| the four Swift plugins, into the App target's sources | `scripts/ios-prep.mjs`, `scripts/ios-project.rb` |
| `UIBackgroundModes` (`voip`, `audio`, `remote-notification`), the camera/microphone/speech/Face ID usage strings, ATS | `scripts/ios-prep.mjs`, from [Info.additions.plist](scif/Info.additions.plist) |
| the push entitlement (`aps-environment`) | `scripts/ios-prep.mjs`, from [App.entitlements](scif/App.entitlements) |
| `ScifCallManager.shared.start()` in `didFinishLaunchingWithOptions` | `scripts/ios-prep.mjs` — a VoIP push that arrives before it runs is dropped |
| team, bundle id, version and build number, automatic signing | `scripts/ios-project.rb` |

The usage strings are not optional: without the `voip` background mode the push
arrives and the app is killed, without the microphone and speech strings those
APIs crash instead of prompting, and without `NSFaceIDUsageDescription` the Face
ID unlock fails instead of prompting.

Then run on a **device**, not the simulator — a VoIP push has no simulator
equivalent.

### TestFlight

The **iOS** workflow builds on a macOS runner (free for public repositories) and
uploads to TestFlight. It needs four repository secrets:

| Secret | Where it comes from |
|---|---|
| `APP_STORE_CONNECT_KEY_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API, the key's ID |
| `APP_STORE_CONNECT_ISSUER_ID` | the issuer UUID on the same page |
| `APP_STORE_CONNECT_KEY` | the `.p8` file's contents, downloaded once when the key is created |
| `APPLE_TEAM_ID` | Membership details, a 10-character id |

A variable `APP_BUNDLE_ID` overrides `us.innotel.scif`. The key needs **App
Manager** rights: signing is automatic, so the runner asks App Store Connect for
the certificate and profile it does not have rather than carrying a `.p12`.
The app record for the bundle id has to exist before the first upload, and
the build number is the workflow run number, so TestFlight never sees the same
build twice.

Run it from **Actions → iOS → Run workflow**, or push a tag `ios-v1.0.0`. It does
not run on every commit on purpose: without the secrets it can only fail.

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
| [scif/ScifCallManager.swift](scif/ScifCallManager.swift) | PushKit + CallKit, one owner of each |
| [scif/ScifCallPlugin.swift](scif/ScifCallPlugin.swift) | the `ScifCall` bridge: token, test ring, answer/end events |
| [scif/ScifSpeechPlugin.swift](scif/ScifSpeechPlugin.swift) | SFSpeechRecognizer for a WKWebView |
| [scif/ScifBiometricsPlugin.swift](scif/ScifBiometricsPlugin.swift) | Face ID / Touch ID unlock through LocalAuthentication |
| [scif/App.entitlements](scif/App.entitlements) | `aps-environment`, set to production for a TestFlight build |
| [scif/Info.additions.plist](scif/Info.additions.plist) | background modes and usage strings, merged into the generated Info.plist |
| [scripts/ios-prep.mjs](scripts/ios-prep.mjs) | applies the wrapper to a generated project |
| [scripts/ios-project.rb](scripts/ios-project.rb) | sources, entitlements, signing and versions, in the Xcode project |
| [../web/src/native.js](../web/src/native.js) | the page's half: register, react, prefer Apple's recognizer |
| [../web/src/biometrics.js](../web/src/biometrics.js) | the page's half of the unlock: ask, and say what the device can do |
