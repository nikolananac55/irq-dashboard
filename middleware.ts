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

import { NextResponse, NextRequest } from "next/server";

// Protect everything except static assets, /login and /api
export const config = {
  matcher: ["/((?!_next|api|login|favicon.ico).*)"],
};

function getClientIP(req: NextRequest): string | null {
  const h = req.headers;
  const xff = h.get("x-forwarded-for");
  if (xff) {
    // first IP in x-forwarded-for chain
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const xrip = h.get("x-real-ip");
  if (xrip) return xrip;
  const cfip = h.get("cf-connecting-ip");
  if (cfip) return cfip;
  return null;
}

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Let /login and assets through
  if (
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  // Allowlisted IPs (comma-separated in env). Example: "174.94.76.46,76.69.249.185"
  const allowList = (process.env.ALLOWLIST_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const ip = getClientIP(req);
  const ipAllowed = !!ip && allowList.includes(ip);

  const authed = req.cookies.get("irq_auth")?.value === "1";

  if (authed || ipAllowed) {
    return NextResponse.next();
  }

  // Not authed and not allowlisted -> send to login with "next" param
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(pathname + (search || ""))}`;
  return NextResponse.redirect(url, { status: 307 });
}
