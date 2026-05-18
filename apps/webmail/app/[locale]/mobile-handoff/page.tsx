"use client";

import { useState, useMemo, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Smartphone, AlertCircle, Loader2 } from "lucide-react";

// Only redirect back to the official mobile-app scheme. Without this guard
// the page becomes an open redirector that funnels arbitrary credentials to
// any URL an attacker chooses.
const ALLOWED_REDIRECT_PREFIX = "bulwarkmobile://";

export default function MobileHandoffPage() {
  const searchParams = useSearchParams();
  const redirectUri = searchParams.get("redirect_uri") ?? "";
  const state = searchParams.get("state") ?? "";

  const redirectOk = useMemo(
    () => redirectUri.startsWith(ALLOWED_REDIRECT_PREFIX),
    [redirectUri],
  );

  const [serverUrl, setServerUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = serverUrl.trim() && username.trim() && password;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const trimmedServerUrl = serverUrl.trim().replace(/\/+$/, "");
      const verifyRes = await fetch("/api/auth/mobile-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverUrl: trimmedServerUrl,
          username: username.trim(),
          password,
        }),
      });
      const verifyJson = await verifyRes.json().catch(() => ({}));
      if (!verifyRes.ok) {
        setError(verifyJson.error || "Sign-in failed");
        setBusy(false);
        return;
      }

      // Build the callback URL with credentials in the fragment so they
      // don't end up in HTTP referrer logs along the way.
      const verifiedUrl = (verifyJson.serverUrl as string) || trimmedServerUrl;
      const fragment = new URLSearchParams({
        server_url: verifiedUrl,
        username: username.trim(),
        password,
        state,
      });
      window.location.href = `${redirectUri}#${fragment.toString()}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  };

  if (!redirectOk) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="max-w-md rounded-lg border border-border bg-card p-6 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-destructive" />
          <h1 className="mt-3 text-lg font-semibold text-foreground">Invalid request</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The mobile app sent an unrecognized callback URL. Update the app and try again.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div className="flex flex-col items-center text-center">
          <Smartphone className="h-8 w-8 text-primary" />
          <h1 className="mt-3 text-lg font-semibold text-foreground">
            Sign in to Bulwark Mobile
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter your credentials. They'll be handed off to the app and you'll be returned automatically.
          </p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">JMAP server URL</span>
          <Input
            type="url"
            placeholder="https://mail.example.com"
            autoComplete="url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            required
            disabled={busy}
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Email or username</span>
          <Input
            type="email"
            placeholder="you@example.com"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            disabled={busy}
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Password</span>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={busy}
          />
        </label>

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <Button type="submit" size="lg" className="w-full" disabled={!canSubmit || busy}>
          {busy ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Signing in…
            </>
          ) : (
            "Sign in and return to app"
          )}
        </Button>
      </form>
    </main>
  );
}
