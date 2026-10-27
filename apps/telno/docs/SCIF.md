# SCIF — the secure line

SCIF is the secure profile of a Telno line, plus an installable app that opens
straight into it. It is deliberately specific about what it protects, because a
security feature nobody can verify is worse than none.

```
Install:  open https://<your host>/softphone?window=1&scif=1
          Chrome / Edge  → Install app
          iOS Safari     → Share → Add to Home Screen
          Android Chrome → ⋮ → Install app
```

The installed app opens with `scif=1`, arms the line on first connect, and keeps
one SIP registration while you use the console or any other tab.

## What SCIF actually enforces

| Promise | Where it is enforced | What it means |
|---|---|---|
| Encrypted media | `pjsip.conf` endpoint is `media_encryption=dtls`, `webrtc=yes`; the browser hangs up if DTLS-SRTP is not established within 7s | Audio and video between this browser and the switch are SRTP. The switch refuses a plaintext endpoint entirely. |
| Never recorded | Generated dialplan carries no `MixMonitor` for a SCIF line, even when the voice agent says record | A call on this line is not mixed to disk on the platform. The switch, not the UI, is the guarantee. |
| Caller ID withheld, or presented as a chosen number | `callerid=` on **both** the desk endpoint and the WebRTC endpoint | Applies to every device on the line, including a handset, and survives a browser restart. |
| Masked voice | AudioWorklet on the outgoing microphone before the peer connection | Pitch shift (lower/higher) or a ring-modulated "robot" voice. The far end and the switch only ever receive the masked audio. |
| Masked text and voicemail identity | `maskText` on the line; redaction in `/api/messages` and `/api/voicemails` | Phone numbers become `+1 ••• ••• ••77`, emails `s•••@example.com`. The raw rows stay in the database; the API is what redacts. |

## Voice on the line

Two different things, deliberately kept apart:

**Recognition** turns speech into text, in the client. In a browser that is the
Web Speech API (Chrome, Edge, Safari); a WKWebView has none, so the native app
exposes Apple's `SFSpeechRecognizer` through `ScifSpeech` and
[speech.js](../web/src/speech.js) prefers it. It powers *Say it* on the dialpad:
"call one oh one" becomes `101` in the field, so a misheard word is visible
before it becomes a call. Free, on-device where the language allows, and no
audio leaves the page for it — the model is the OS's.

**Authentication** decides whether the person speaking is the line's owner. That
cannot be a client decision, so the page records a WAV and `POST /voice/verify`;
[voiceprint.js](../src/lib/voiceprint.js) computes a 36-number cepstral vector
plus the pitch the voice sat at and compares it with the enrolled print. A pass
issues a single-use ticket, and a line with the check switched on refuses to mint
a softphone session without one.

So yes — voice authentication works from the web page. What it is *not*:

- **not a password replacement.** It is one factor, and it is weakest against a
  good recording of the owner;
- **not portable across microphones without re-enrolling.** The cepstral mean is
  normalised, but a headset and a laptop array still differ; enroll where you
  take calls, or re-enroll when you change.
- **not tuned by us on your voice.** The default threshold (0.82) sits between
  the synthetic voices used in the test suite by a wide margin; a real voice
  varies more. The enrollment screen reports how alike the takes were, so a
  threshold that is too tight is visible immediately.

Set it per line from **Softphone → SCIF**, or `POST /api/softphone/scif`. Staff
and customers use the same route; the ownership check is the same one a softphone
session uses.

## What it does **not** do — read this before promising it to anyone

- **No end-to-end encryption.** Encryption is per hop: browser → switch, then
  switch → trunk. A call that reaches the PSTN is unencrypted on that last leg,
  because ordinary phones have no SRTP. You cannot have "my side encrypted" for
  a call: SRTP is negotiated by both ends or not at all. What SCIF can do — and
  does — is refuse to place the call unless *your* leg is encrypted and your
  caller ID is withheld.
- **SMS and MMS are not secure in the same way.** They leave through a provider
  HTTP API and travel the carrier network in the clear. Masking hides addresses
  and numbers in the platform UI; it does not encrypt the SMS. Sealed messaging
  between two SCIF users would need a key exchange and is not built yet.
- **Email is not encrypted.** Notice and invoice mail goes over SMTP with the
  provider's TLS. S/MIME or PGP would be the next step; nothing here does it.
- **Video is encrypted, and that is all it is.** The camera and screen share use
  the same DTLS-SRTP transport, with the same last-leg caveat.
- **Wi-Fi and Bluetooth direct messaging are not implemented.** Bluetooth Mesh,
  Wi-Fi Direct and Airdrop-style transfer need a native transport layer and the
  OS permission model; a PWA cannot provide them.
- **Voice recognition is dictation, not a transcript service.** The softphone
  turns what you say into digits to dial, and checks the phrase you enrolled.
  It runs in the client (Web Speech API, or SFSpeechRecognizer in the native
  app), which is why it costs nothing per minute and works offline in the shell.
  Voicemail transcripts are still whatever the voice agent produced; nothing here
  transcribes a recording on the server.
- **A voiceprint is a second factor, not a biometric lock.** It is computed from
  the audio on the platform (MFCC statistics plus pitch) and compared by cosine
  similarity. That catches "this is not the person who enrolled" well enough to
  gate a phone line; it is not a trained speaker-recognition network and should
  not be the only thing protecting something that matters. The threshold is
  measured, not magic: see `VOICEPRINT_THRESHOLD`.
- **Masking is not anonymisation.** It redacts identifiers, it does not defeat a
  determined analysis of writing style or call timing.

## iOS and Android

Today the app installs as a PWA. On both platforms it gets its own icon, its own
window, the microphone, and (on Android) the audio route picker. Limitations to
be honest about:

- **iOS** suspends background WebRTC shortly after the screen locks. A call in
  progress continues on the lock screen for a while, but a registered-but-idle
  line will not ring reliably in the background without CallKit and PushKit.
- **Android** keeps a foreground tab registered more reliably, but the OS may
  still kill the browser process; the softphone reconnects on its own when it
  comes back.
- Neither store is involved: nothing to review, nothing to sideload.

**Native wrapper — built for iOS.** [../native](../native/README.md) is a
Capacitor shell with PushKit and CallKit, so the line rings on a locked iPhone.
The platform sends the VoIP push (`src/lib/push.js`), the app reports it to
CallKit, and answering brings the app forward to join over the same SRTP path as
the browser. Two honest limits, both in that README:

- answering from the lock screen joins the call because the switch parks it: a
  line with a registered phone rings the desk and any open browser for
  `PARKING_RING_SECONDS`, then parks the caller in the lot and pushes the phone
  with the space number. Answering dials that space. A native WebRTC stack would
  remove the extra step, not the need for one;
- Push Notifications needs a paid Apple Developer Program membership in practice,
  even though Xcode and signing a debug build do not.

Android has no equivalent here yet; the PWA keeps working.


## Verifying it yourself

- `GET /api/system/config-preview?file=pjsip.conf` — the `callerid=` line for
  your endpoint and `media_encryption=dtls`.
- `GET /api/system/config-preview?file=extensions.conf` — the
  `; SCIF lines never record: …` banner and the absence of `MixMonitor` for that
  line's DID.
- A live call: **Media** reads `DTLS-SRTP`. If it does not, SCIF ends the call.
- `POST /api/softphone/scif` with `voiceMask: "low"` and talk — the far end hears
  a different voice, and the browser's own local playback (muted) is unaffected.
