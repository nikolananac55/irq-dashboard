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

