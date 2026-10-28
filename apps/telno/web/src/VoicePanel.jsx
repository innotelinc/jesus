import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Badge, Button, Card, Empty, Input, Switch, useToast } from './ui';
import { recognitionSupported, startDictation } from './speech';
import { recordedWav } from './wav';

/**
 * The voice half of SCIF: a voiceprint on this line, and the check that can be
 * required before the line hands out SIP credentials.
 *
 * The microphone capture is the browser's; the decision is the platform's. This
 * component records, uploads and reports — it never decides that a voice matched.
 */
export default function VoicePanel({ extension, onTicket }) {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [phrase, setPhrase] = useState('my voice unlocks this line');
  const [samples, setSamples] = useState([]);
  const [heard, setHeard] = useState('');
  const [result, setResult] = useState(null);
  const [push, setPush] = useState(null);
  const [error, setError] = useState('');
  const stopSpeech = useRef(null);

  const load = useCallback(async () => {
    if (!extension) return;
    try {
      const [voice, devices] = await Promise.all([
        api.get(`/voice/status?extension=${encodeURIComponent(extension)}`),
        api.get(`/softphone/push?extension=${encodeURIComponent(extension)}`),
      ]);
      setStatus(voice);
      setPush(devices);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [extension]);

  useEffect(() => {
    setStatus(null);
    setSamples([]);
    setResult(null);
    setHeard('');
    load();
  }, [load]);

  useEffect(() => () => stopSpeech.current?.(), []);

  const enrolled = !!status?.voiceprint?.enrolled;
  const seconds = Math.min(6, Math.max(2, status?.sample?.minSeconds ? status.sample.minSeconds + 2 : 4));

  /** Record one take and decode it to WAV. The recorder is stopped by timer. */
  const record = async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot reach the microphone');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    try {
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(
        (candidate) => window.MediaRecorder?.isTypeSupported?.(candidate)
      );
      const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      const done = new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      });
      // Say the phrase out loud while it is recording, so the transcript can be
      // compared with the enrolled phrase afterwards.
      if (status?.recognition && recognitionSupported()) {
        stopSpeech.current = startDictation({
          onText: (text) => setHeard(text),
          onError: () => {},
        });
      }
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      recorder.stop();
      stopSpeech.current?.();
      stopSpeech.current = null;
      const blob = await done;
      const wav = await recordedWav(blob, { maxSeconds: status?.sample?.maxSeconds || 20 });
      if (wav.seconds < (status?.sample?.minSeconds || 1)) throw new Error('That take was too short');
      return wav;
    } finally {
      stream.getTracks().forEach((track) => track.stop());
    }
  };

  const addSample = async () => {
    setBusy('record');
    setError('');
    try {
      const wav = await record();
      setSamples((current) => [...current, wav.base64]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const enroll = async () => {
    setBusy('enroll');
    setError('');
    try {
      const data = await api.post('/voice/enroll', {
        extension,
        phrase,
        samples,
      });
      setSamples([]);
      setResult({
        ok: true,
        score: data.voiceprint?.consistency,
        message: `Enrolled from ${data.voiceprint?.samples} recording(s).`,
      });
      toast.success('Voiceprint enrolled', 'The line can now require a voice check before it connects.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const verify = async () => {
    setBusy('verify');
    setError('');
    setResult(null);
    try {
      const wav = await record();
      const data = await api.post('/voice/verify', { extension, audio: wav.base64, heard });
      setResult({
        ok: data.ok,
        score: data.score,
        message: data.ok
          ? `Matched at ${data.score} (needs ${data.threshold}).`
          : `That did not match: ${data.score}, needs ${data.threshold}. ${data.phraseMatch === false ? 'The phrase was different too.' : ''}`,
      });
      if (data.ok && data.ticket) {
        onTicket?.(data.ticket);
        toast.success('Voice check passed', 'The line will open with this check.');
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const requireCheck = async (value) => {
    setBusy('require');
    setError('');
    try {
      const data = await api.post('/voice/require', { extension, enabled: value });
      setStatus((current) => ({ ...current, gate: data.gate }));
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      setBusy('');
    }
  };

  const forget = async () => {
    if (!window.confirm('Remove the voiceprint on this line? The line will stop requiring one.')) return;
    setBusy('forget');
    try {
      await api.del(`/voice?extension=${encodeURIComponent(extension)}`);
      setSamples([]);
      setResult(null);
      toast.success('Voiceprint removed');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const ringNow = async () => {
    setBusy('ring');
    setError('');
    try {
      const data = await api.post('/softphone/push/ring', { extension });
      if (data.sent) toast.success('Ring sent', `${data.sent} device(s) notified.`);
      else setError(data.hint || data.results?.[0]?.reason || 'No device was reached');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  if (!extension) {
    return (
      <Card title="Voice" subtitle="Pick a line first">
        <Empty icon="mic" title="No line selected">
          A voiceprint belongs to a line.
        </Empty>
      </Card>
    );
  }

  return (
    <Card
      title="Voice"
      subtitle="A voiceprint on this line, and a check before it connects"
      actions={
        <Badge tone={status?.gate?.enforced ? 'success' : 'neutral'} dot={status?.gate?.enforced ? 'live' : undefined}>
          {status?.gate?.enforced ? 'Required' : enrolled ? 'Enrolled' : 'Not enrolled'}
        </Badge>
      }
    >
      <div className="stack">
        {error ? (
          <p className="tiny" style={{ color: 'var(--danger)', margin: 0 }}>
            {error}
          </p>
        ) : null}

        {!status ? (
          <p className="tiny dim">Reading this line…</p>
        ) : (
          <>
            <Input
              label="Phrase to say"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              hint="Record it two to five times. The phrase is checked with speech recognition; the voiceprint decides the identity."
              disabled={busy === 'enroll'}
            />

            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <Button size="sm" variant="ghost" icon="mic" loading={busy === 'record'} onClick={addSample}>
                Record a take
              </Button>
              <span className="tiny dim">
                {samples.length} recorded · {seconds}s each
                {samples.length < 2 ? ' · two needed' : ''}
              </span>
              {samples.length ? (
                <Button size="sm" variant="ghost" onClick={() => setSamples([])}>
                  Clear
                </Button>
              ) : null}
            </div>

            <div className="row wrap" style={{ gap: 8 }}>
              <Button
                size="sm"
                variant="primary"
                icon="shield"
                loading={busy === 'enroll'}
                disabled={samples.length < 2 || busy === 'enroll'}
                onClick={enroll}
              >
                {enrolled ? 'Replace voiceprint' : 'Enroll voiceprint'}
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="mic"
                loading={busy === 'verify'}
                disabled={!enrolled || busy === 'verify'}
                onClick={verify}
              >
                Check my voice
              </Button>
              {enrolled ? (
                <Button size="sm" variant="ghost" icon="trash" loading={busy === 'forget'} onClick={forget}>
                  Forget
                </Button>
              ) : null}
            </div>

            {result ? (
              <div className="panel" style={{ padding: 10 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'Pass' : 'No match'}</Badge>
                  <span className="tiny">{result.message}</span>
                </div>
              </div>
            ) : null}

            <Switch
              checked={!!status.gate?.required}
              onChange={requireCheck}
              label="Require this check before the line connects"
              disabled={!enrolled || busy === 'require' || !status.available}
            />
            <p className="tiny dim" style={{ margin: 0 }}>
              {status.gate?.enforced
                ? 'A softphone session needs a passed check from the last few minutes. The ticket is single use.'
                : enrolled
                  ? 'Enrolled. Turn the switch on to make the session wait for a check.'
                  : 'Enroll first — a line that requires a print it does not have would lock itself out.'}
            </p>

            {status.recent?.length ? (
              <div className="stack" style={{ gap: 4 }}>
                <div className="tiny dim">Recent checks</div>
                {status.recent.slice(0, 4).map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <span className="tiny dim">{entry.outcome}</span>
                    <span className="tiny mono">{entry.score?.toFixed?.(3) ?? entry.score}</span>
                    <span className="tiny dim">{new Date(entry.at).toLocaleString('en-US')}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {!status.recognition ? (
              <p className="tiny dim" style={{ margin: 0 }}>
                Speech recognition is switched off on this platform (VOICE_RECOGNITION_ENABLED=false). The
                voiceprint still works; the phrase check is skipped.
              </p>
            ) : !recognitionSupported() ? (
              <p className="tiny dim" style={{ margin: 0 }}>
                This browser has no speech recognition, so the phrase is not checked here — the voiceprint still is.
              </p>
            ) : null}

            <div className="panel" style={{ padding: 10 }}>
              <div className="row wrap" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>Ring on a locked iPhone</div>
                  <div className="tiny dim">
                    {push?.status?.enabled
                      ? push?.devices?.length
                        ? `${push.devices.length} device(s) registered · ${push.status.environment}`
                        : 'No phone registered yet — install the SCIF app and sign in on this line'
                      : 'Apple push is off on this platform (APNS_ENABLED=false)'}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="phone"
                  loading={busy === 'ring'}
                  disabled={!push?.status?.enabled || !push?.devices?.length}
                  onClick={ringNow}
                >
                  Test ring
                </Button>
              </div>
              {push?.status?.problem && push.status.enabled ? (
                <p className="tiny" style={{ color: 'var(--warning)', margin: '6px 0 0' }}>
                  {push.status.problem}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
