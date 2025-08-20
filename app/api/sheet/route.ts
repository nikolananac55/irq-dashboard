// app/api/sheet/route.ts

export const runtime = "edge"; // fast + works great on Vercel

export async function GET() {
  const url = process.env.SHEET_CSV_URL;

  if (!url) {
    return new Response("Missing SHEET_CSV_URL environment variable", { status: 500 });
  }

  try {
    // No caching; always fetch fresh CSV
    const upstream = await fetch(url, { cache: "no-store" });

    if (!upstream.ok) {
      return new Response(`Upstream fetch failed (${upstream.status})`, { status: 502 });
    }

    const text = await upstream.text();

    // Return as CSV to the client
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (err: any) {
    return new Response(`Fetch error: ${err?.message || String(err)}`, { status: 500 });
  }
}
