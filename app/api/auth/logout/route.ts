import { SESSION_COOKIE } from "@/lib/auth/session";
import { clearChallengeCookie } from "@/lib/auth/challenge";
import { getEnv } from "@/lib/env";
import { assertTrustedOrigin } from "@/lib/security/csrf";
export async function POST(request: Request) {
  try {
    assertTrustedOrigin(request);
    const response = Response.json({ success: true });
    response.headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    response.headers.append("Set-Cookie", clearChallengeCookie(getEnv().NODE_ENV === "production"));
    return response;
  } catch {
    return Response.json({ success: false }, { status: 403 });
  }
}
