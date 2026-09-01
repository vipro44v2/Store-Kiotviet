import { cookies } from "next/headers";
import { z } from "zod";
import { challengeCookie, clearChallengeCookie, createTwoFactorChallenge, TWO_FACTOR_COOKIE, TWO_FACTOR_MAX_ATTEMPTS, verifyTwoFactorChallenge } from "@/lib/auth/challenge";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { verifyTotp } from "@/lib/auth/totp";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/security/rate-limit";
import { assertTrustedOrigin } from "@/lib/security/csrf";

const schema = z.object({ code: z.string().regex(/^\d{6}$/) });

export async function POST(request: Request) {
  const env = getEnv();
  const secure = env.NODE_ENV === "production";
  try {
    assertTrustedOrigin(request);
    const token = (await cookies()).get(TWO_FACTOR_COOKIE)?.value;
    const challenge = await verifyTwoFactorChallenge(token);
    if (!challenge) {
      const response = Response.json({ success: false, error: "Two-factor challenge is missing or expired" }, { status: 401 });
      response.headers.append("Set-Cookie", clearChallengeCookie(secure));
      return response;
    }
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!(await rateLimit(`2fa:${ip}:${challenge.username}`, TWO_FACTOR_MAX_ATTEMPTS, 300))) {
      const response = Response.json({ success: false, error: "Too many attempts" }, { status: 429 });
      response.headers.append("Set-Cookie", clearChallengeCookie(secure));
      return response;
    }
    const { code } = schema.parse(await request.json());
    if (!verifyTotp(code, env.ADMIN_TOTP_SECRET, { window: 1 })) {
      const failures = challenge.failures + 1;
      const response = Response.json({ success: false, error: "Invalid authentication code" }, { status: 401 });
      if (failures >= TWO_FACTOR_MAX_ATTEMPTS)
        response.headers.append("Set-Cookie", clearChallengeCookie(secure));
      else {
        const replacement = await createTwoFactorChallenge(challenge.username, failures, challenge.expiresAt);
        const remaining = Math.max(1, challenge.expiresAt - Math.floor(Date.now() / 1000));
        response.headers.append("Set-Cookie", challengeCookie(replacement, secure, remaining));
      }
      return response;
    }
    const session = await createSession(challenge.username);
    const response = Response.json({ success: true });
    response.headers.append("Set-Cookie", `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? "; Secure" : ""}`);
    response.headers.append("Set-Cookie", clearChallengeCookie(secure));
    return response;
  } catch {
    return Response.json({ success: false, error: "Two-factor verification failed" }, { status: 400 });
  }
}
