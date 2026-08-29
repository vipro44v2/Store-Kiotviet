"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
export function LoginForm() {
  const router = useRouter(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: data.get("username"),
        password: data.get("password"),
      }),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Login failed");
      setLoading(false);
      return;
    }
    router.push("/admin");
    router.refresh();
  }
  return (
    <form className="login-form" onSubmit={submit}>
      <label>
        Username
        <input name="username" autoComplete="username" required />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      {error && <p className="form-error">{error}</p>}
      <button disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
