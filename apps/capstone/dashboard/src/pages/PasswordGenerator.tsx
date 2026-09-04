import { useState, useCallback } from 'react';
import Button from '../components/Button';
import { cn } from '../lib/utils';

function entropyScore(length: number, upper: boolean, lower: boolean, numbers: boolean, symbols: boolean) {
  let pool = 0;
  if (lower) pool += 26;
  if (upper) pool += 26;
  if (numbers) pool += 10;
  if (symbols) pool += 32;
  if (pool === 0) return 0;
  return length * Math.log2(pool);
}

function strengthLabel(entropy: number) {
  if (entropy < 40) return { label: 'Weak', color: 'text-danger', bar: 'bg-danger', bg: 'bg-danger/10' };
  if (entropy < 60) return { label: 'Fair', color: 'text-warning', bar: 'bg-warning', bg: 'bg-warning/10' };
  if (entropy < 80) return { label: 'Strong', color: 'text-info', bar: 'bg-info', bg: 'bg-info/10' };
  return { label: 'Very strong', color: 'text-success', bar: 'bg-success', bg: 'bg-success/10' };
}

function generatePassword(length: number, upper: boolean, lower: boolean, numbers: boolean, symbols: boolean, excludeAmbiguous: boolean) {
  const lowerChars = 'abcdefghijklmnopqrstuvwxyz';
  const upperChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numberChars = '0123456789';
  const symbolChars = '!@#$%^&*()_+-=[]{}|;:,.<>?';
  const ambiguous = '0O1lI';

  const pool: string[] = [];
  if (lower) pool.push(...lowerChars.split(''));
  if (upper) pool.push(...upperChars.split(''));
  if (numbers) pool.push(...numberChars.split(''));
  if (symbols) pool.push(...symbolChars.split(''));

  if (excludeAmbiguous) {
    const filtered = pool.filter(char => !ambiguous.includes(char));
    filtered.length ? (pool.length = 0, pool.push(...filtered)) : null;
  }

  if (pool.length === 0) return 'aB3!@#';

  let password = '';
  for (let i = 0; i < length; i++) {
    password += pool[Math.floor(Math.random() * pool.length)];
  }

  if (!upper && !lower && !numbers && !symbols) return password;

  if (!upper) {
    password = password.replace(/[A-Z]/g, _char => lowerChars[Math.floor(Math.random() * 26)]);
  }
  if (!lower) {
    password = password.replace(/[a-z]/g, _char => upperChars[Math.floor(Math.random() * 26)]);
  }
  if (!numbers) {
    password = password.replace(/[0-9]/g, _char => symbolChars[Math.floor(Math.random() * symbolChars.length)]);
  }
  if (!symbols) {
    password = password.replace(/[^a-zA-Z0-9]/g, _char => lowerChars[Math.floor(Math.random() * 26)]);
  }

  return password;
}

const SYMBOLS = '!@#$%^&*()_+-=[]{}|;:,.<>?';

export default function PasswordGenerator() {
  const [length, setLength] = useState(16);
  const [upper, setUpper] = useState(true);
  const [lower, setLower] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [symbols, setSymbols] = useState(false);
  const [excludeAmbiguous, setExcludeAmbiguous] = useState(false);
  const [password, setPassword] = useState(() => generatePassword(length, upper, lower, numbers, symbols, excludeAmbiguous));
  const [copied, setCopied] = useState(false);
  const [multipleCount, setMultipleCount] = useState(1);
  const [multiplePasswords, setMultiplePasswords] = useState<string[]>([]);

  const regenerate = useCallback(() => {
    const next = generatePassword(length, upper, lower, numbers, symbols, excludeAmbiguous);
    setPassword(next);
  }, [length, upper, lower, numbers, symbols, excludeAmbiguous]);

  const copyPassword = () => {
    navigator.clipboard.writeText(password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const generateMultiple = () => {
    const pws = Array.from({ length: multipleCount }, () => generatePassword(length, upper, lower, numbers, symbols, excludeAmbiguous));
    setMultiplePasswords(pws);
  };

  const copyMultiple = () => {
    navigator.clipboard.writeText(multiplePasswords.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const entropy = entropyScore(length, upper, lower, numbers, symbols);
  const strength = strengthLabel(entropy);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Password Generator</h1>
          <p className="mt-1 text-sm text-muted-foreground">Generate secure, configurable passwords for service accounts and secrets.</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Password length</label>
              <span className="text-sm font-mono font-semibold">{length}</span>
            </div>
            <input
              type="range"
              min={4}
              max={64}
              value={length}
              onChange={e => {
                const next = parseInt(e.target.value, 10);
                setLength(next);
                setPassword(generatePassword(next, upper, lower, numbers, symbols, excludeAmbiguous));
              }}
              className="w-full h-2 accent-primary cursor-pointer"
              aria-label="Password length"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>4</span>
              <span>32</span>
              <span>64</span>
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Character sets</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { label: 'Uppercase (A-Z)', checked: upper, onChange: () => setUpper(!upper), onGen: () => setUpper(!upper) },
                { label: 'Lowercase (a-z)', checked: lower, onChange: () => setLower(!lower), onGen: () => setLower(!lower) },
                { label: 'Numbers (0-9)', checked: numbers, onChange: () => setNumbers(!numbers), onGen: () => setNumbers(!numbers) },
                { label: 'Symbols (!@#$…)', checked: symbols, onChange: () => setSymbols(!symbols), onGen: () => setSymbols(!symbols) },
              ].map(opt => (
                <label key={opt.label} className="inline-flex items-center gap-2 cursor-pointer rounded-lg border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted/40">
                <input
                  type="checkbox"
                  checked={opt.checked}
                  onChange={() => {
                    const next = !opt.checked;
                    if (next) opt.onGen();
                  }}
                  className="h-4 w-4 rounded border input accent-primary"
                />
                  {opt.label}
                </label>
              ))}
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer rounded-lg border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted/40">
              <input
                type="checkbox"
                checked={excludeAmbiguous}
                onChange={e => {
                  setExcludeAmbiguous(e.target.checked);
                  setPassword(generatePassword(length, upper, lower, numbers, symbols, excludeAmbiguous));
                }}
                className="h-4 w-4 rounded border input accent-primary"
              />
              Exclude ambiguous (0O1lI)
            </label>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Symbols (optional)</h3>
            <div className="flex flex-wrap gap-1 text-xs font-mono text-muted-foreground">
              {SYMBOLS.split('').map(symbol => (
                <span key={symbol} className="rounded bg-muted px-1 py-0.5">{symbol}</span>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="default" size="sm" onClick={regenerate}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M1 4v6h6" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>
              Generate
            </Button>
            <Button variant="outline" size="sm" onClick={copyPassword} className={cn(copied ? 'text-success' : '')}>
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Generated password</h2>
            <div className={cn('mt-2 flex items-center justify-between gap-2 rounded-2xl border bg-card p-4 shadow-sm', strength.bg)}>
              <div className="flex-1 font-mono text-base break-all select-all">
                {password}
              </div>
              <button
                onClick={copyPassword}
                className="shrink-0 rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                aria-label="Copy password"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              </button>
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Strength</h2>
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">{strength.label}</span>
                <span className={cn('font-mono', strength.color)}>{entropy.toFixed(1)} bits</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full transition-all', strength.bar)}
                  style={{ width: `${Math.min(100, (entropy / 80) * 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Weak</span>
                <span>Fair</span>
                <span>Strong</span>
                <span>Very strong</span>
              </div>
            </div>
          </div>

          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Generate multiple</h2>
            <div className="mt-2 flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                Count
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={multipleCount}
                  onChange={e => setMultipleCount(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
                  className="h-8 w-16 rounded-md border bg-background px-2 py-1 text-sm text-center font-mono focus:border-primary focus:outline-none"
                  aria-label="Number of passwords to generate"
                />
              </label>
              <Button variant="outline" size="sm" onClick={generateMultiple}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                Generate {multipleCount}
              </Button>
              <Button variant="ghost" size="sm" onClick={copyMultiple} disabled={multiplePasswords.length === 0}>
                Copy all
              </Button>
            </div>
          </div>

          {multiplePasswords.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Generated passwords</h2>
              <div className="max-h-60 overflow-y-auto rounded-lg border bg-card p-3 font-mono text-xs space-y-1">
                {multiplePasswords.map((pw, i) => (
                  <div key={i} className="flex items-center justify-between gap-2">
                    <span className="truncate select-all">{pw}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(pw).then(() => setCopied(true)).catch(() => {});
                        setTimeout(() => setCopied(false), 2000);
                      }}
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label="Copy password"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
