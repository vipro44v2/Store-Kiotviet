import { verifyCredential } from "@/lib/auth/password";
import { challengeCookie, createTwoFactorChallenge } from "@/lib/auth/challenge";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/security/rate-limit";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { AuthenticationError } from "@/lib/errors";
import { z } from "zod";

const schema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) });

export async function POST(request: Request) {
  try {
    assertTrustedOrigin(request);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!(await rateLimit(`login:${ip}`, 5, 300)))
      return Response.json({ success: false, error: "Too many attempts" }, { status: 429 });
    const input = schema.parse(await request.json());
    const env = getEnv();
    const usernameValid = verifyCredential(input.username, env.ADMIN_USERNAME);
    const passwordValid = verifyCredential(input.password, env.ADMIN_PASSWORD);
    if (!usernameValid || !passwordValid)
      return Response.json({ success: false, error: "Invalid credentials" }, { status: 401 });
    if (!env.ADMIN_TOTP_SECRET)
      return Response.json({ success: false, error: "Two-factor authentication is not configured" }, { status: 503 });
    const token = await createTwoFactorChallenge(input.username);
    const response = Response.json({ success: true, requires2fa: true });
    response.headers.append("Set-Cookie", challengeCookie(token, env.NODE_ENV === "production"));
    return response;
  } catch (error) {
    const reason = error instanceof AuthenticationError
      ? "invalid_origin"
      : error instanceof z.ZodError
        ? "invalid_request"
        : error instanceof Error && error.message.includes("SESSION_SECRET")
          ? "session_configuration"
          : "unexpected_error";
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorType = /^[A-Za-z][A-Za-z0-9]*Error$/.test(errorName)
      ? errorName
      : "UnknownError";
    let origin = "missing";
    try {
      const value = request.headers.get("origin");
      if (value) origin = new URL(value).origin;
    } catch {
      origin = "invalid";
    }
    let host = "invalid";
    try {
      host = new URL(request.url).host;
    } catch {}
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Admin login failed",
      reason,
      errorType,
      origin,
      host,
    })}\n`);
    return Response.json({ success: false, error: "Login failed" }, { status: 400 });
  }
}
