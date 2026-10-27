import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { BrandMark, useBrand } from '../brand.jsx';
import { navigate } from '../router.jsx';
import { Button, Icon, Input } from '../ui.jsx';

const POINTS = [
  ['shield', 'One identity across PBX, numbers and directory'],
  ['numbers', 'Every number normalized to E.164 and de-duplicated'],
  ['globe', 'Six public hostnames served by the same registry'],
];

export default function Login() {
  const { login } = useAuth();
  const brand = useBrand();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate('/');
    } catch (err) {
      // A suspended account gets the real reason and the amount, not the
      // "wrong password" message that would send someone round in circles.
      if (err.status === 402) setError(err.message);
      else setError(err.status === 0 ? err.message : 'Email or password is incorrect.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <aside className="auth-art">
        <div className="row" style={{ gap: 10 }}>
          <span className="brand-mark" aria-hidden="true">
            <Icon name="phone" size={15} />
          </span>
          <BrandMark brand={brand} size={24} />
        </div>

        <div>
          <h1>Telephony, numbers and directory in one place.</h1>
          <div className="auth-points">
            {POINTS.map(([icon, text]) => (
              <div key={text}>
                <Icon name={icon} size={16} />
                <span>{text}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="tiny dim">
          {brand.vendor}: switch, control API and the worldwide phonebook registry in one database and one
          container.
        </p>
      </aside>

      <div className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit} noValidate>
          <div>
            <h2>Sign in</h2>
            <p className="tiny dim" style={{ marginTop: 2 }}>
              Operator access to the control plane.
            </p>
          </div>

          <Input
            label="Email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
          <Input
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••"
            error={error || undefined}
          />

          <Button type="submit" variant="primary" loading={busy} style={{ marginTop: 4 }}>
            Sign in
          </Button>

          <p className="tiny dim" style={{ marginTop: 6 }}>
            First boot creates an owner account — its password is written to the data volume, or set with
            <span className="mono"> ADMIN_PASSWORD</span>. Change it under <span className="mono">Account</span>
            once you are in.
          </p>
        </form>
      </div>
    </div>
  );
}
