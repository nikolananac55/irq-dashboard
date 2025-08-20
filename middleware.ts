// middleware.ts
import { NextRequest, NextResponse } from "next/server";

// Paths that never need auth (login page, auth API, static)
const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
];

const PUBLIC_PREFIXES = [
  "/_next/",        // Next.js assets
  "/static/",       // your static if any
  "/public/",       // just in case
  "/api/health",    // if you add a health endpoint later
];

const COOKIE_NAME = "irq_auth";

// Comma-separated list of allowed IPs, e.g. "1.2.3.4,5.6.7.8"
function getTrustedIPs(): string[] {
  const raw = process.env.TRUSTED_IPS || "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function getClientIP(req: NextRequest): string | null {
  // Vercel/Cloud providers set x-forwarded-for
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || null;
  // NextRequest.ip is often populated locally
  // @ts-ignore
  if (req.ip) return (req.ip as string) || null;
  return null;
}

function pathIsPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some(p => pathname.startsWith(p));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathIsPublic(pathname)) {
    return NextResponse.next();
  }

  // 1) Allow if coming from a trusted IP (auto-login by IP)
  const clientIP = getClientIP(req);
  const trusted = getTrustedIPs();
  if (clientIP && trusted.includes(clientIP)) {
    return NextResponse.next();
  }

  // 2) Allow if valid auth cookie present
  const token = req.cookies.get(COOKIE_NAME)?.value || "";
  if (token) {
    const ok = await verifyToken(token);
    if (ok) return NextResponse.next();
  }

  // 3) Otherwise → redirect to /login
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

// ---------- Token helpers (Edge-safe) ----------
type Payload = { u: string; exp: number }; // username + expiry (epoch seconds)

function b64u(input: ArrayBuffer | string) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let s = Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return s;
}

async function getKey() {
  const secret = process.env.AUTH_SECRET || "dev-secret-change-me";
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(payload: string) {
  const key = await getKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64u(sig);
}

async function verify(payload: string, signature: string) {
  const key = await getKey();
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    new TextEncoder().encode(payload)
  );
  return ok;
}

export async function createToken(username: string, days = 30) {
  const exp = Math.floor(Date.now() / 1000) + days * 24 * 3600;
  const body: Payload = { u: username, exp };
  const payload = b64u(JSON.stringify(body));
  const sig = await sign(payload);
  return `${payload}.${sig}`;
}

export async function verifyToken(token: string) {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  try {
    const ok = await verify(payload, sig);
    if (!ok) return false;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()) as Payload;
    if (!json?.exp || json.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
