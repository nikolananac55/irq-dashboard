"use client";

import React, { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export const dynamic = "force-dynamic";

function LoginInner() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        router.push(next);
      } else {
        const t = await res.text();
        setErr(t || "Login failed");
      }
    } catch (e: any) {
      setErr(e?.message || "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-2xl border p-5 shadow-sm"
        style={{ borderColor: "#e5e7eb" }}
      >
        <h1 className="text-lg font-semibold mb-4 text-slate-900">Sign in</h1>

        <label className="block text-sm mb-1 text-slate-700">Username</label>
        <input
          className="w-full rounded-lg border px-3 py-2 mb-3 text-slate-900 placeholder-slate-400"
          style={{ borderColor: "#e5e7eb", background: "#f7f8fa" }}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />

        <label className="block text-sm mb-1 text-slate-700">Password</label>
        <input
          type="password"
          className="w-full rounded-lg border px-3 py-2 mb-4 text-slate-900 placeholder-slate-400"
          style={{ borderColor: "#e5e7eb", background: "#f7f8fa" }}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        {err ? (
          <div className="text-sm mb-3" style={{ color: "#dc2626" }}>
            {err}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg px-3 py-2 text-white font-medium"
          style={{
            background: busy ? "#94a3b8" : "#0f172a",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <div className="text-xs mt-3 opacity-60 text-slate-600">
          You’ll stay signed in on this device.
        </div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading…</div>}>
      <LoginInner />
    </Suspense>
  );
}

