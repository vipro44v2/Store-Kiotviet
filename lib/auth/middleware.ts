import { AuthenticationError } from "@/lib/errors";
import { isAuthenticated } from "./session";
export async function requireAdmin(): Promise<void> {
  if (!(await isAuthenticated())) throw new AuthenticationError();
}

export function adminApiErrorResponse(
  error: unknown,
  fallback: string,
  fallbackStatus = 400,
): Response {
  if (error instanceof AuthenticationError)
    return Response.json(
      { success: false, error: "Authentication required" },
      { status: 401 },
    );
  return Response.json(
    { success: false, error: error instanceof Error ? error.message : fallback },
    { status: fallbackStatus },
  );
}
