import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { verifyCredential } from "@/lib/auth/password";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/security/rate-limit";
import { assertTrustedOrigin } from "@/lib/security/csrf";
import { z } from "zod";
const schema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(500),
});
export async function POST(request: Request) {
  try {
    assertTrustedOrigin(request);
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown";
    if (!(await rateLimit(`login:${ip}`, 5, 300)))
      return Response.json(
        { success: false, error: "Too many attempts" },
        { status: 429 },
      );
    const input = schema.parse(await request.json()),
      env = getEnv();
    if (
      !verifyCredential(input.username, env.ADMIN_USERNAME) ||
      !verifyCredential(input.password, env.ADMIN_PASSWORD)
    )
      return Response.json(
        { success: false, error: "Invalid credentials" },
        { status: 401 },
      );
    const token = await createSession(input.username);
    const response = Response.json({ success: true });
    response.headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${env.NODE_ENV === "production" ? "; Secure" : ""}`,
    );
    return response;
  } catch {
    return Response.json(
      { success: false, error: "Login failed" },
      { status: 400 },
    );
  }
}
