// app/api/sheet/route.ts

export const runtime = "edge"; // fast on Vercel

function textResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export async function GET() {
  const url = process.env.SHEET_CSV_URL;

  if (!url) {
    return textResponse("ERROR: Missing SHEET_CSV_URL env var in Vercel → Settings → Environment Variables.", 500);
  }

  try {
    // Try fetch from Edge
    const res = await fetch(url, { cache: "no-store" });

    if (!res.ok) {
      return textResponse(`ERROR: Upstream fetch failed (${res.status}) for ${url}`, 502);
    }

    // Basic content check
    const contentType = res.headers.get("content-type") || "";
    const body = await res.text();
    if (!body.trim()) {
      return textResponse(`ERROR: Upstream returned empty body for ${url}`, 502);
    }

    // Return as CSV. Your client already parses CSV.
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "no-store, max-age=0",
        // expose type for debugging:
        "X-Upstream-Content-Type": contentType,
      },
    });
  } catch (err: any) {
    return textResponse(`ERROR: Fetch threw: ${err?.message || String(err)}`, 500);
  }
}
