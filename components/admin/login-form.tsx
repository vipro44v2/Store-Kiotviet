"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: data.get("username"), password: data.get("password") }),
    });
    const payload = (await response.json()) as { error?: string; requires2fa?: boolean };
    setLoading(false);
    if (!response.ok || !payload.requires2fa) {
      setError(payload.error ?? "Login failed");
      return;
    }
    setStep("totp");
  }

  async function submitTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: data.get("code") }),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Verification failed");
      setLoading(false);
      return;
    }
    router.push("/admin");
    router.refresh();
  }

  if (step === "totp")
    return (
      <form className="login-form" onSubmit={submitTotp}>
        <label>
          6-digit authentication code
          <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} autoFocus required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button disabled={loading}>{loading ? "Verifying…" : "Verify"}</button>
      </form>
    );

  return (
    <form className="login-form" onSubmit={submitPassword}>
      <label>Username<input name="username" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <p className="form-error">{error}</p>}
      <button disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
