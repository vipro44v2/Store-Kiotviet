import { AuthenticationError } from "@/lib/errors";
import { isAuthenticated } from "./session";
export async function requireAdmin(): Promise<void> { if (!(await isAuthenticated())) throw new AuthenticationError(); }
