// app/api/login/route.ts
export const runtime = "edge";

function text(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export async function POST(req: Request) {
  try {
    const { username, password } = await req.json();

    // ⚠️ If you want to switch to envs later:
    // const U = process.env.ADMIN_USER ?? "admin";
    // const P = process.env.ADMIN_PASS ?? "Welcome123!";
    const U = "admin";
    const P = "Welcome123!";

    if (username === U && password === P) {
      // 90 days
      const maxAge = 60 * 60 * 24 * 90;
      const cookie = [
        `irq_auth=1`,
        `Path=/`,
        `Max-Age=${maxAge}`,
        `HttpOnly`,
        `SameSite=Lax`,
        // "Secure" is required on Vercel (https); if testing ONLY on http://localhost you can temporarily remove this.
        `Secure`,
      ].join("; ");

      return text("OK", 200, { "Set-Cookie": cookie });
    }

    return text("Invalid credentials", 401);
  } catch (e: any) {
    return text(`Bad request: ${e?.message || "Unknown"}`, 400);
  }
}
