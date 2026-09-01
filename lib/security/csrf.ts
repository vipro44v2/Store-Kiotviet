import { getEnv, getPublicAppUrl } from "@/lib/env";
import { AuthenticationError } from "@/lib/errors";
export function assertTrustedOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const env = getEnv();
  const trustedOrigins = new Set([
    new URL(env.APP_URL).origin,
    new URL(getPublicAppUrl()).origin,
  ]);
  if (!origin || !trustedOrigins.has(new URL(origin).origin))
    throw new AuthenticationError("Invalid request origin");
}
