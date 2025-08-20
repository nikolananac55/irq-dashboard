import { NextResponse } from "next/server";

export async function GET() {
  const url = process.env.CSV_URL;
  if (!url) {
    return NextResponse.json({ error: "CSV_URL not set" }, { status: 500 });
  }
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  return new NextResponse(text, {
    status: 200,
    headers: { "Content-Type": "text/csv" },
  });
}
