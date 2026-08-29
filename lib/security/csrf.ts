import { getEnv } from "@/lib/env";
import { AuthenticationError } from "@/lib/errors";
export function assertTrustedOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).origin !== new URL(getEnv().APP_URL).origin)
    throw new AuthenticationError("Invalid request origin");
}
