import { SESSION_COOKIE } from "@/lib/auth/session";
import { assertTrustedOrigin } from "@/lib/security/csrf";
export async function POST(request: Request) {
  try {
    assertTrustedOrigin(request);
    const response = Response.json({ success: true });
    response.headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    return response;
  } catch {
    return Response.json({ success: false }, { status: 403 });
  }
}
