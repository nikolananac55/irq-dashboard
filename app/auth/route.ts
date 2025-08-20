// app/api/auth/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createToken } from "../../../middleware";

const COOKIE_NAME = "irq_auth";

// Hard-coded per your request. You can move to env later.
const ADMIN_USER = "admin";
const ADMIN_PASS = "Welcome123!";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const username = (form.get("username") || "").toString();
  const password = (form.get("password") || "").toString();
  const next = ((form.get("next") || "/") as string) || "/";

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = await createToken(username, 30); // 30 days
    const res = NextResponse.redirect(new URL(next, req.url));
    res.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });
    return res;
  }

  const bad = new URL("/login", req.url);
  bad.searchParams.set("err", "1");
  bad.searchParams.set("next", next);
  return NextResponse.redirect(bad);
}
