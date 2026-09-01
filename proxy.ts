import { NextResponse, type NextRequest } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth/session";

export async function proxy(request: NextRequest) {
  const authenticated = await verifySession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (request.nextUrl.pathname === "/admin/login")
    return authenticated
      ? NextResponse.redirect(new URL("/admin", request.url))
      : NextResponse.next();
  if (!authenticated && request.nextUrl.pathname.startsWith("/api/admin"))
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401 },
    );
  if (!authenticated)
    return NextResponse.redirect(new URL("/admin/login", request.url));
  return NextResponse.next();
}
export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
