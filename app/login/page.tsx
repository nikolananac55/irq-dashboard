// app/login/page.tsx
"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const sp = useSearchParams();
  const next = sp.get("next") || "/";
  const err = sp.get("err") === "1";

  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: "#f7f8fa" }}>
      <form
        method="POST"
        action="/api/auth"
        className="w-full max-w-sm rounded-2xl p-6 shadow-sm"
        style={{ background: "#fff", border: "1px solid #e5e7eb" }}
      >
        <h1 className="text-xl font-semibold mb-4">Sign in</h1>

        {err && (
          <div className="mb-3 text-sm rounded-lg px-3 py-2"
               style={{ color: "#dc2626", background: "rgba(220,38,38,0.08)", border: "1px solid #fecaca" }}>
            Invalid username or password.
          </div>
        )}

        <input type="hidden" name="next" value={next} />

        <label className="block text-sm mb-1 text-gray-600">Username</label>
        <input
          name="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="w-full mb-3 rounded-lg px-3 py-2 text-sm border"
          placeholder="admin"
        />

        <label className="block text-sm mb-1 text-gray-600">Password</label>
        <input
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full mb-4 rounded-lg px-3 py-2 text-sm border"
          placeholder="••••••••"
        />

        <button
          type="submit"
          className="w-full rounded-lg px-3 py-2 text-sm font-semibold"
          style={{ background: "#0f172a", color: "#fff" }}
        >
          Sign in
        </button>

        <p className="mt-3 text-xs text-gray-500">
          Access is restricted. If you should have access and can’t sign in, contact the owner.
        </p>
      </form>
    </div>
  );
}
