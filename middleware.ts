// middleware.ts
import { NextResponse, NextRequest } from "next/server";

function parseClientIp(req: NextRequest): string | null {
  // Vercel/Proxies usually set X-Forwarded-For: "client, proxy1, proxy2"
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.trim();

  // Last resort (often not useful behind proxies)
  // @ts-ignore (next/server types don't expose socket)
  return (req as any)?.ip || null;
}

function isPublicPath(pathname: string): boolean {
  // Allow public assets and Next internals
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname.startsWith("/public") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/robots.txt") ||
    pathname.startsWith("/sitemap.xml")
  ) {
    return true;
  }

  // Allow unauthenticated access to login endpoints
  if (pathname === "/login" || pathname === "/api/login") return true;

  return false;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public paths pass through
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // 1) IP allowlist from env: ALLOWED_IPS="174.94.76.46,76.69.249.185"
  const allowedIps = (process.env.ALLOWED_IPS || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  const clientIp = parseClientIp(req);
  if (clientIp && allowedIps.includes(clientIp)) {
    // Bypass auth if client IP is allowlisted
    return NextResponse.next();
  }

  // 2) Cookie-based auth (set by your login route/page)
  const authCookie = req.cookies.get("irq_auth")?.value;
  if (authCookie === "1") {
    return NextResponse.next();
  }

  // Not allowed → redirect to /login (preserve intended target as ?next=)
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname || "/");
  return NextResponse.redirect(url);
}

// Apply middleware to everything except:
export const config = {
  matcher: [
    // Run on all paths except the ones that *must* remain public.
    // We still guard inside isPublicPath(), but excluding here avoids extra work.
    "/((?!_next|static|public|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
