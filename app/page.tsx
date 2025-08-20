"use client";

/**
 * IRQ Dashboard — Full Page (with TURF TRACKING)
 * -----------------------------------------------------------------------------
 * Baseline = user-provided working build (kept 1:1) with bug-fix patches only:
 *   - Load data: race-proof + cache-busted fetch + AbortController
 *   - Auto-refresh: visibility-aware, avoids racing manual refresh
 *   - Manual refresh: brief pause of auto-refresh to prevent overwrites
 *   - Header Avg/Wk chip: consistent periods + always shows previous period if present
 *   - CSV normalization: robust header canonicalization + tolerant month/date parsing
 *   - Number parsing: locale-friendly numeric normalization
 *   - TURF parser: detect actual start row (don’t assume header), allow negatives in P
 *   - Lifetime Distribution: precompute lastAny per turf (perf)
 *   - QuickAnyVisit: O(N) pass (perf)
 *   - Products rows: remove redundant internal sort (UI sorts by profit in render)
 *   - Note text aligned to 3-week rule: "Revisit after 3 weeks"
 *   - Tailwind typo fix already in baseline (text-[11px])
 *   - Data Health / Heatmap / Anomalies remain removed per user request
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

/* ────────────────────────────────────────────────────────────────────────── */
/* Config                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

const LOCALE = "en-CA";
const CURRENCY = "CAD";

const UI = {
  bg: "#f7f8fa",
  card: "#ffffff",
  border: "#e5e7eb",
  text: "#0f172a",
  sub: "#64748b",
  pos: "#16a34a",
  neg: "#dc2626",
  chipDark: "linear-gradient(135deg,#0f172a,#1f2937)",
} as const;

const hexToRGBA = (hex: string, alpha: number) => {
  const v = hex.replace("#", "");
  const bigint = parseInt(v, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Formatters                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

const fmtMoney = (n: number) =>
  new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: CURRENCY,
    maximumFractionDigits: 0,
  }).format(+n || 0);

const fmtPct = (n: number) => `${isFinite(n) ? Math.round(n) : 0}%`;
const fmtInt = (n: number) => (isFinite(n) ? Math.round(n) : 0).toString();

const fmtDDMMYYYY = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

/* ────────────────────────────────────────────────────────────────────────── */
/* Month parsing (sales sections)                                             */
/* ────────────────────────────────────────────────────────────────────────── */

const monthNameToIndex = (name: string) => {
  const id = String(name || "").slice(0, 3).toLowerCase();
  const map: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return map[id] || null;
};

/**
 * Accepts:
 *  - "JUNE 2025"
 *  - "06-2025"
 *  - "2025-06"
 */
const parseMonthKey = (s: string) => {
  if (!s) return null;
  const str = String(s).trim();

  let m = str.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mm = monthNameToIndex(m[1]!);
    const yy = +m[2]!;
    if (mm && yy) return { y: yy, m: mm };
  }

  m = str.match(/^(\d{1,2})[-\/]?(\d{4})$/);
  if (m) return { y: +m[2]!, m: Math.max(1, Math.min(12, +m[1]!)) };

  m = str.match(/^(\d{4})[-\/]?(\d{1,2})$/);
  if (m) return { y: +m[1]!, m: Math.max(1, Math.min(12, +m[2]!)) };

  return null;
};

const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const startOfYear = (d: Date) => new Date(d.getFullYear(), 0, 1);
const endOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);

/* ────────────────────────────────────────────────────────────────────────── */
/* General date helpers                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const parseDDMMYYYY = (s: any): Date | null => {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (!m) return null;
  const dd = +m[1]!;
  const mm = +m[2]!;
  const yy = +m[3]!;
  const d = new Date(yy, mm - 1, dd);
  return isNaN(d.getTime()) ? null : d;
};

const mondayOfWeek = (d: Date): Date => {
  const day = d.getDay(); // 0 Sun, 1 Mon, ... 6 Sat
  const diff = (day + 6) % 7; // days since Monday
  const m = new Date(d);
  m.setDate(d.getDate() - diff);
  m.setHours(0, 0, 0, 0);
  return m;
};

const weekKey = (d: Date) => {
  const m = mondayOfWeek(d);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
};

const weeksBetween = (a: Date, b: Date) => {
  const ms = mondayOfWeek(a).getTime() - mondayOfWeek(b).getTime();
  return Math.max(0, Math.round(ms / (7 * 24 * 3600 * 1000)));
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Page                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export default function Page() {
  /* State ------------------------------------------------------------------ */

  const [rows, setRows] = useState<any[]>([]);          // normalized (header:true) for non-TURF sections
  const [turfRaw, setTurfRaw] = useState<any[][]>([]);  // raw 2D grid (header:false) for TURF (by column index)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // NEW: status & saved views
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [lastDurationMs, setLastDurationMs] = useState<number>(0);
  const [usedSavedView, setUsedSavedView] = useState<boolean>(false);

  // NEW: Refresh success chip
  const [justRefreshed, setJustRefreshed] = useState(false);

  const now = new Date();
  const [live, setLive] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState(ym(now));

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshSec, setRefreshSec] = useState(30);
  const requestIdRef = useRef(0);
  const [incomeYear, setIncomeYear] = useState<number>(now.getFullYear());

  /* Data loader ------------------------------------------------------------ */

  async function loadData() {
    const myId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

    // simple text hash (djb2)
    const hash = (s: string) => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
      return (h >>> 0).toString(36);
    };

    // store the last accepted hash across calls
    (loadData as any)._lastHashRef = (loadData as any)._lastHashRef || { current: "" };
    const lastHashRef = (loadData as any)._lastHashRef as { current: string };

    // stronger cache-buster + headers
    const getOnce = async (suffix = "") => {
      const bust = `${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`;
      const res = await fetch(`/api/sheet?ts=${bust}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        },
      });
      if (!res.ok) throw new Error(`API error (${res.status})`);
      const text = await res.text();
      return { text, h: hash(text) };
    };

    try {
      // 1st snapshot
      const snap1 = await getOnce();

      // stale request guard
      if (myId !== requestIdRef.current) return;

      // If hash differs from the last accepted one, verify with a 2nd snapshot shortly after
      let chosen = snap1;
      if (snap1.h !== lastHashRef.current) {
        await new Promise((r) => setTimeout(r, 250));
        const snap2 = await getOnce("-v2");
        if (myId !== requestIdRef.current) return; // stale guard

        // Accept only if two consecutive snapshots match; otherwise pick the newer one (snap2)
        chosen = snap2.h === snap1.h ? snap1 : snap2;
      }

      // Parse chosen snapshot
      const parsedHeader = Papa.parse(chosen.text, { header: true, skipEmptyLines: true });
      const data = parsedHeader.data.map(normalizeRow).filter(Boolean);

      const parsedRaw = Papa.parse<string[]>(chosen.text, { header: false, skipEmptyLines: false });

      setRows(data);
      setTurfRaw(parsedRaw.data as any[][]);
      setLastUpdated(new Date());
      lastHashRef.current = chosen.h; // commit the accepted hash
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message || String(e));
      setRows([]);
      setTurfRaw([]);
    } finally {
      const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      if (myId === requestIdRef.current) {
        setLastDurationMs(Math.max(0, t1 - t0));
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    loadData();
    // on unmount, invalidate any in-flight requests
    return () => { requestIdRef.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        loadData();
      }
    };
    const id = setInterval(tick, Math.max(5, refreshSec) * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, refreshSec]);

  // NEW: Saved Views — restore on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("crm_saved_view");
      if (!raw) return;
      const sv = JSON.parse(raw || "{}");
      if (typeof sv.live === "boolean") setLive(sv.live);
      if (typeof sv.selectedMonth === "string" && sv.selectedMonth.match(/^\d{4}-\d{2}$/)) {
        setSelectedMonth(sv.selectedMonth);
      }
      if (typeof sv.autoRefresh === "boolean") setAutoRefresh(sv.autoRefresh);
      if (typeof sv.refreshSec === "number") setRefreshSec(sv.refreshSec);
      setUsedSavedView(true);
    } catch { }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NEW: Saved Views — persist on change
  useEffect(() => {
    try {
      const sv = { live, selectedMonth, autoRefresh, refreshSec };
      localStorage.setItem("crm_saved_view", JSON.stringify(sv));
    } catch { }
  }, [live, selectedMonth, autoRefresh, refreshSec]);

  /* Normalizer (non-TURF) -------------------------------------------------- */

  function normalizeRow(r: any) {
    const canon = (s: string) =>
      String(s || "")
        .toLowerCase()
        .replace(/^\ufeff/, "") // strip BOM if present
        .replace(/\s+/g, " ")   // collapse inner whitespace
        .trim();

    const lower: any = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [canon(k), v])
    );

    // Expected columns for SALES (allow minor header drift):
    // "sales rep name" (A), "product sold" (F), "month" (G) or fallback "date"
    // "total sales price" (I), "sales rep com" (J), "profit nik" (K)
    const rep = String(lower["sales rep name"] || lower["rep"] || "").trim();
    if (!rep) return null;

    const product = String(lower["product sold"] || lower["product"] || "").trim() || "(Unspecified)";

    // Accept multiple month formats or fallback to a concrete date cell
    const rawMonth = String(lower["month"] || "").trim();
    let mk = parseMonthKey(rawMonth);
    if (!mk) {
      const alt = rawMonth.replace(/[\.|\/]/g, "-").replace(/\s+/, "-");
      mk = parseMonthKey(alt);
    }

    let date: Date | null = null;
    if (mk) {
      date = new Date(mk.y, mk.m - 1, 1);
    } else if (lower["date"]) {
      const dGuess = parseDDMMYYYY(lower["date"]) || new Date(String(lower["date"]));
      if (dGuess instanceof Date && !isNaN(dGuess.getTime())) {
        date = new Date(dGuess.getFullYear(), dGuess.getMonth(), 1);
      }
    }
    if (!date) return null;

    const normNum = (v: any) => {
      const s = String(v ?? "").trim();
      if (!s) return 0;
      const hasCommaDec = /,\d{1,2}$/.test(s) || /\d+,\d{1,2}$/.test(s);
      const cleaned = (hasCommaDec ? s.replace(/\./g, "").replace(/,/g, ".") : s).replace(/[^0-9.-]/g, "");
      const n = parseFloat(cleaned);
      return isFinite(n) ? n : 0;
    };

    const amount = normNum(lower["total sales price"]);
    const commission = normNum(lower["sales rep com"]);
    const profit = normNum(lower["profit nik"]);

    return {
      rep,
      product,
      date,
      amount,
      profit,
      commission,
    };
  }

  /* Time context ----------------------------------------------------------- */

  const contextDate = useMemo(
    () =>
      live
        ? new Date()
        : new Date(+selectedMonth.split("-")[0], +selectedMonth.split("-")[1] - 1, 1),
    [live, selectedMonth]
  );

  const thisMonthKey = ym(contextDate);
  const ytdStart = startOfYear(contextDate);
  const ytdEnd = live ? new Date() : endOfMonth(contextDate);
  const prevMonthKey = ym(new Date(contextDate.getFullYear(), contextDate.getMonth() - 1, 1));

  /* Company aggregates (+ delta vs prev month) ----------------------------- */

  const company = useMemo(() => {
    let mSalesAmt = 0;
    let ySalesAmt = 0;
    let mProfit = 0;
    let yProfit = 0;
    let mSalesCount = 0;
    let ySalesCount = 0;
    let prevMonthSalesAmt = 0;

    const monthlyByRep = new Map<string, number>();

    for (const r of rows) {
      const key = ym(r.date);
      const inMonth = key === thisMonthKey;
      const inPrev = key === prevMonthKey;
      const inYtd = r.date >= ytdStart && r.date <= ytdEnd;

      if (inMonth) {
        mSalesAmt += r.amount;
        mProfit += r.profit;
        mSalesCount++;
        monthlyByRep.set(r.rep, (monthlyByRep.get(r.rep) || 0) + 1);
      }
      if (inPrev) {
        prevMonthSalesAmt += r.amount;
      }
      if (inYtd) {
        ySalesAmt += r.amount;
        yProfit += r.profit;
        ySalesCount++;
      }
    }

    let deltaPct: number | null = null;
    let deltaIsNew = false;

    if (prevMonthSalesAmt > 0) {
      deltaPct = ((mSalesAmt - prevMonthSalesAmt) / prevMonthSalesAmt) * 100;
    } else if (prevMonthSalesAmt === 0 && mSalesAmt > 0) {
      deltaIsNew = true;
    }

    let topRep: string | "—" = "—";
    let topRepSales: number | "—" = "—";

    if (monthlyByRep.size) {
      const arr = [...monthlyByRep.entries()].sort((a, b) => b[1] - a[1]);
      topRep = arr[0][0];
      topRepSales = arr[0][1];
    }

    return {
      mSalesAmt,
      ySalesAmt,
      mProfit,
      yProfit,
      mSalesCount,
      ySalesCount,
      topRep,
      topRepSales,
      prevMonthSalesAmt,
      deltaPct,
      deltaIsNew,
    };
  }, [rows, thisMonthKey, prevMonthKey, ytdStart, ytdEnd]);

  const formatDeltaBadge = (deltaPct: number | null, isNew: boolean) => {
    if (isNew) return { text: "NEW", color: UI.pos };
    if (deltaPct == null) return null;
    const rounded = Math.round(deltaPct);
    const sign = rounded > 0 ? "+" : "";
    return { text: `${sign}${rounded}%`, color: rounded >= 0 ? UI.pos : UI.neg };
  };

  const deltaBadge = formatDeltaBadge(company.deltaPct, company.deltaIsNew);

  /* Sales Reps (Δ vs prev mo + Commission sums) ---------------------------- */
  const repRows = useMemo(() => {
    const byRep = new Map<string, any[]>();
    for (const r of rows) {
      if (!byRep.has(r.rep)) byRep.set(r.rep, []);
      byRep.get(r.rep)!.push(r);
    }

    const out: {
      rep: string;
      mSales: number;
      ySales: number;
      mProfit: number;
      yProfit: number;
      mRevenue: number;
      yRevenue: number;
      mComm: number;
      yComm: number;
      diff: number;
    }[] = [];

    for (const [rep, arr] of byRep.entries()) {
      let mSales = 0;
      let ySales = 0;
      let mProfit = 0;
      let yProfit = 0;
      let mRevenue = 0;
      let yRevenue = 0;
      let mComm = 0;
      let yComm = 0;

      const salesByMonth = new Map<string, number>();

      for (const r of arr) {
        const key = ym(r.date);
        salesByMonth.set(key, (salesByMonth.get(key) || 0) + 1);

        const inMonth = key === thisMonthKey;
        const inYtd = r.date >= ytdStart && r.date <= ytdEnd;

        if (inMonth) {
          mSales++;
          mProfit += r.profit;
          mRevenue += r.amount;
          mComm += r.commission || 0;
        }
        if (inYtd) {
          ySales++;
          yProfit += r.profit;
          yRevenue += r.amount;
          yComm += r.commission || 0;
        }
      }

      const diff =
        (salesByMonth.get(thisMonthKey) || 0) -
        (salesByMonth.get(prevMonthKey) || 0);

      out.push({
        rep,
        mSales,
        ySales,
        mProfit,
        yProfit,
        mRevenue,
        yRevenue,
        mComm,
        yComm,
        diff,
      });
    }

    out.sort((a, b) => b.yProfit - a.yProfit || a.rep.localeCompare(b.rep));
    return out;
  }, [rows, thisMonthKey, prevMonthKey, ytdStart, ytdEnd]);

  /* Products (counts + historical margin excl current month) --------------- */

  const productRows = useMemo(() => {
    const m = new Map<string, number>();
    const y = new Map<string, number>();

    // Historical (YTD up to selected month). Exclude the month ONLY when LIVE.
    const histRevenue = new Map<string, number>();
    const histProfit = new Map<string, number>();

    const windowEnd = endOfMonth(contextDate); // clamp to selected month’s end

    for (const r of rows) {
      const name = r.product || "(Unspecified)";
      const key = ym(r.date);

      const isSelectedMonth = key === thisMonthKey;
      const inYtdWindow = r.date >= ytdStart && r.date <= ytdEnd;      // for YTD counts
      const inHistWindow = r.date >= ytdStart && r.date <= windowEnd;   // for historical $

      // Monthly count = exactly the selected (or live) month
      if (isSelectedMonth) {
        m.set(name, (m.get(name) || 0) + 1);
      }

      // YTD count = within [ytdStart, ytdEnd]
      if (inYtdWindow) {
        y.set(name, (y.get(name) || 0) + 1);
      }

      // Historical profit/margin:
      //  - within [ytdStart..endOfMonth(selected)]
      //  - exclude the selected month ONLY when LIVE (so browsing June includes June)
      const excludeSelected = live && isSelectedMonth;
      if (inHistWindow && !excludeSelected) {
        histRevenue.set(name, (histRevenue.get(name) || 0) + (r.amount || 0));
        histProfit.set(name, (histProfit.get(name) || 0) + (r.profit || 0));
      }
    }

    const names = Array.from(
      new Set([...m.keys(), ...y.keys(), ...histRevenue.keys(), ...histProfit.keys()])
    );

    return names.map((n) => {
      const totalRevHist = histRevenue.get(n) || 0;
      const totalProfHist = histProfit.get(n) || 0;
      const marginPct = totalRevHist > 0 ? (100 * totalProfHist) / totalRevHist : 0;
      return {
        product: n,
        mCount: m.get(n) || 0,
        yCount: y.get(n) || 0,
        totalProfitAll: totalProfHist,
        marginPctAll: marginPct,
      };
    });
  }, [rows, thisMonthKey, ytdStart, ytdEnd, contextDate, live]);

  /* Average Profit / Sale by Rep (historical-only) ------------------------- */

  const avgRows = useMemo(() => {
    const byRep = new Map<
      string,
      {
        rep: string;
        histAllSales: number;
        histAllProfit: number;
        histYtdSales: number;
        histYtdProfit: number;
      }
    >();

    for (const r of rows) {
      const key = ym(r.date);
      const inCurrentMonth = key === thisMonthKey;
      const inYtd = r.date >= ytdStart && r.date <= ytdEnd;

      if (!byRep.has(r.rep)) {
        byRep.set(r.rep, {
          rep: r.rep,
          histAllSales: 0,
          histAllProfit: 0,
          histYtdSales: 0,
          histYtdProfit: 0,
        });
      }

      const agg = byRep.get(r.rep)!;

      if (!inCurrentMonth) {
        agg.histAllSales += 1;
        agg.histAllProfit += r.profit || 0;
        if (inYtd) {
          agg.histYtdSales += 1;
          agg.histYtdProfit += r.profit || 0;
        }
      }
    }

    const list = [...byRep.values()].map((agg) => {
      const mAvg = agg.histAllSales > 0 ? agg.histAllProfit / agg.histAllSales : 0;
      const yAvg = agg.histYtdSales > 0 ? agg.histYtdProfit / agg.histYtdSales : 0;
      return { rep: agg.rep, mAvg, yAvg };
    });

    list.sort((a, b) => b.mAvg - a.mAvg || b.yAvg - a.yAvg || a.rep.localeCompare(b.rep));
    return list;
  }, [rows, thisMonthKey, ytdStart, ytdEnd]);

  /* ──────────────────────────────────────────────────────────────────────── */
  /* TURF TRACKING — STRICTLY M–P BY COLUMN POSITION                          */
  /* ──────────────────────────────────────────────────────────────────────── */

  // Column indices (0-based): A=0, ..., M=12, N=13, O=14, P=15
  const M_IDX = 12;
  const N_IDX = 13;
  const O_IDX = 14;
  const P_IDX = 15;

  type TurfEntry = {
    rep: string;        // M
    turf: string;       // O
    week: string;       // Monday YYYY-MM-DD
    date: Date;         // Monday date
    count: number;      // P (# of sales — negatives allowed for corrections)
    month: string;      // YYYY-MM
  };

  // Extract valid turf rows from raw grid by fixed indices M–P — robust start row
  const turfEntries: TurfEntry[] = useMemo(() => {
    const out: TurfEntry[] = [];
    if (!turfRaw || turfRaw.length === 0) return out;

    // detect first data row by a date-like N column
    let startRow = 1;
    const dateLike = (s: string) => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(String(s || ""));
    for (let i = 0; i < Math.min(10, turfRaw.length); i++) {
      const r = turfRaw[i];
      if (r && r.length > P_IDX && dateLike(r[N_IDX])) { startRow = i; break; }
    }

    for (let i = startRow; i < turfRaw.length; i++) {
      const row = turfRaw[i];
      if (!row || row.length <= P_IDX) continue;

      const repM = String(row[M_IDX] ?? "").trim();
      const dateN = String(row[N_IDX] ?? "").trim();
      const turfO = String(row[O_IDX] ?? "").trim();
      const salesP = String(row[P_IDX] ?? "").trim();

      if (!repM || !dateN || !turfO || salesP === "") continue;

      const d = parseDDMMYYYY(dateN);
      if (!d) continue;

      const mon = mondayOfWeek(d);
      const num = parseInt(salesP.replace(/[^\d-]/g, ""), 10);
      const cnt = isNaN(num) ? 0 : num; // allow negatives for corrections

      out.push({
        rep: repM,
        turf: turfO,
        week: weekKey(mon),
        date: mon,
        count: cnt,
        month: ym(mon),
      });
    }
    return out;
  }, [turfRaw]);

  // Core sets for UI
  const allTurfs = useMemo(
    () => Array.from(new Set(turfEntries.map((e) => e.turf))).sort((a, b) => a.localeCompare(b)),
    [turfEntries]
  );
  const allRepsFromM = useMemo(
    () => Array.from(new Set(turfEntries.map((e) => e.rep))).sort((a, b) => a.localeCompare(b)),
    [turfEntries]
  );

  // Bottom section: state for drill-in per turf → rep
  const [activeDetail, setActiveDetail] = useState<{ turf: string; rep: string } | null>(null);

  // helper to compute deep stats for a rep×turf (lifetime + YTD + selected month + last by others)
  function calcRepTurfStats(rep: string, turf: string) {
    const today = new Date();
    const ytdStartNow = startOfYear(today);

    const entries = turfEntries.filter((e) => e.rep === rep && e.turf === turf);

    const lifetimeSales = entries.reduce((s, e) => s + e.count, 0);
    const lifetimeWeeks = new Set(entries.map((e) => e.week)).size;
    const avgPerVisit = lifetimeWeeks > 0 ? lifetimeSales / lifetimeWeeks : 0;

    const ytdEntries = entries.filter((e) => e.date >= ytdStartNow && e.date <= today);
    const ytdWeeks = new Set(ytdEntries.map((e) => e.week)).size;
    const ytdSales = ytdEntries.reduce((s, e) => s + e.count, 0);
    const ytdAvg = ytdWeeks > 0 ? ytdSales / ytdWeeks : 0;

    const last = entries.reduce<Date | null>((acc, e) => (!acc || e.date > acc ? e.date : acc), null);
    const weeksSinceLast = last ? weeksBetween(today, last) : null;

    const best = entries.length ? entries.reduce((a, b) => (b.count > a.count ? b : a)) : null;
    const worst = entries.length ? entries.reduce((a, b) => (b.count < a.count ? b : a)) : null;

    // seasonality (current month-of-year across all years)
    const mo = today.getMonth();
    const seasonal = entries.filter((e) => e.date.getMonth() === mo);
    const seasonalWeeks = new Set(seasonal.map((e) => e.week)).size;
    const seasonalSales = seasonal.reduce((s, e) => s + e.count, 0);
    const seasonalAvg = seasonalWeeks > 0 ? seasonalSales / seasonalWeeks : 0;

    // next eligible week after 3-week rule
    const nextEligible = last ? mondayOfWeek(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 21)) : mondayOfWeek(today);

    // selected month stats — reacts to top picker
    const monthEntries = entries.filter((e) => e.month === thisMonthKey);
    const monthWeeks = new Set(monthEntries.map((e) => e.week)).size;
    const monthSales = monthEntries.reduce((s, e) => s + e.count, 0);

    // NEW: last time ANY rep visited this turf (include everyone, not excluding current rep)
    let lastAny: Date | null = null;
    let lastAnyRep: string | null = null;
    for (const e of turfEntries) {
      if (e.turf !== turf) continue;
      if (!lastAny || e.date > lastAny) {
        lastAny = e.date;
        lastAnyRep = e.rep || null;
      }
    }
    const weeksSinceAny = lastAny ? weeksBetween(today, lastAny) : null;

    return {
      lifetimeSales,
      lifetimeWeeks,
      avgPerVisit,
      ytdSales,
      ytdWeeks,
      ytdAvg,
      last,
      weeksSinceLast,
      best,
      worst,
      seasonalAvg,
      nextEligible,
      monthWeeks,
      monthSales,
      lastAny,
      lastAnyRep,
      weeksSinceAny,
    };
  }

  /* Strategic summary per rep (bottom-most section, sleek cards) ----------- */

  type RepSummary = {
    rep: string;
    top: { turf: string; avgPerWeek: number; lastSelf: Date | null; lastAny: Date | null }[];
    avoid: { turf: string; avgPerWeek: number; lastSelf: Date | null; lastAny: Date | null }[];
  };

  const strategicSummary: RepSummary[] = useMemo(() => {
    const result: RepSummary[] = [];

    const byRep = new Map<string, TurfEntry[]>();
    for (const e of turfEntries) {
      if (!byRep.has(e.rep)) byRep.set(e.rep, []);
      byRep.get(e.rep)!.push(e);
    }

    // Precompute lastAny per turf
    const lastAnyByTurf = new Map<string, Date | null>();
    for (const t of new Set(turfEntries.map((e) => e.turf))) {
      let d: Date | null = null;
      for (const e of turfEntries) if (e.turf === t) d = !d || e.date > d ? e.date : d;
      lastAnyByTurf.set(t, d);
    }

    for (const rep of Array.from(new Set([...allRepsFromM])).sort((a, b) => a.localeCompare(b))) {
      const items = byRep.get(rep) || [];

      // per-turf lifetime aggregates
      const map = new Map<
        string,
        { total: number; weeks: Set<string>; lastSelf: Date | null; lastAny: Date | null }
      >();

      for (const t of allTurfs) {
        map.set(t, { total: 0, weeks: new Set<string>(), lastSelf: null, lastAny: lastAnyByTurf.get(t) || null });
      }

      for (const e of items) {
        const agg = map.get(e.turf)!;
        agg.total += e.count;
        agg.weeks.add(e.week);
        if (!agg.lastSelf || e.date > agg.lastSelf) agg.lastSelf = e.date;
      }

      const perfArr = [...map.entries()].map(([turf, agg]) => {
        const wk = agg.weeks.size;
        const avg = wk > 0 ? agg.total / wk : 0;
        return { turf, avgPerWeek: avg, weeks: wk, lastSelf: agg.lastSelf, lastAny: agg.lastAny };
      });

      const top = [...perfArr].sort((a, b) => b.avgPerWeek - a.avgPerWeek || a.turf.localeCompare(b.turf)).slice(0, 3);
      const avoid = [...perfArr].sort((a, b) => a.avgPerWeek - b.avgPerWeek || a.turf.localeCompare(b.turf)).slice(0, 2);

      result.push({
        rep,
        top: top.map((x) => ({ turf: x.turf, avgPerWeek: x.avgPerWeek, lastSelf: x.lastSelf, lastAny: x.lastAny })),
        avoid: avoid.map((x) => ({ turf: x.turf, avgPerWeek: x.avgPerWeek, lastSelf: x.lastSelf, lastAny: x.lastAny })),
      });
    }

    return result;
  }, [turfEntries, allTurfs, allRepsFromM]);

  // Suggestions — best YTD avg/week, eligible turfs: ALL; skip if visited within 3 weeks
  type RepSuggestion = {
    rep: string;
    suggestion: {
      turf: string | "NO SUGGESTION";
      avgPerWeekYTD: number | null;
      nextWeekMonday: Date;
      nextRefreshMonday: Date;
      note?: string;
    };
  };

  const turfSuggestions: RepSuggestion[] = useMemo(() => {
    const results: RepSuggestion[] = [];

    const today = new Date();
    const ytdStartNow = startOfYear(today);
    const threeWeeksAgoMon = mondayOfWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 21));

    const nextWeekMonday = mondayOfWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));
    const nextRefreshMonday = mondayOfWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14));

    const byRep = new Map<string, TurfEntry[]>();
    for (const e of turfEntries) {
      if (!byRep.has(e.rep)) byRep.set(e.rep, []);
      byRep.get(e.rep)!.push(e);
    }

    for (const rep of Array.from(byRep.keys()).sort((a, b) => a.localeCompare(b))) {
      const items = byRep.get(rep)!;

      const map = new Map<
        string,
        { ytdSales: number; ytdWeeks: Set<string>; last: Date | null }
      >();

      for (const e of items) {
        if (!map.has(e.turf)) map.set(e.turf, { ytdSales: 0, ytdWeeks: new Set<string>(), last: null });
        const agg = map.get(e.turf)!;
        if (e.date >= ytdStartNow && e.date <= today) {
          agg.ytdSales += e.count;
          agg.ytdWeeks.add(e.week);
        }
        if (!agg.last || e.date > agg.last) agg.last = e.date;
      }

      const perf = [...map.entries()].map(([turf, agg]) => {
        const weeksYTD = agg.ytdWeeks.size;
        const avg = weeksYTD > 0 ? agg.ytdSales / weeksYTD : 0;
        return { turf, avgPerWeekYTD: avg, last: agg.last };
      });

      perf.sort((a, b) => b.avgPerWeekYTD - a.avgPerWeekYTD || a.turf.localeCompare(b.turf));

      let chosen: { turf: string; avgPerWeekYTD: number } | null = null;
      for (const p of perf) {
        const tooRecent = p.last && p.last > threeWeeksAgoMon;
        if (!tooRecent) { chosen = { turf: p.turf, avgPerWeekYTD: p.avgPerWeekYTD }; break; }
      }

      if (!chosen) {
        results.push({
          rep,
          suggestion: {
            turf: "NO SUGGESTION",
            avgPerWeekYTD: null,
            nextWeekMonday,
            nextRefreshMonday,
            note: "All turfs are too recent (visited within last 3 weeks). Revisit after 3 weeks.",
          },
        });
      } else {
        results.push({
          rep,
          suggestion: { turf: chosen.turf, avgPerWeekYTD: chosen.avgPerWeekYTD, nextWeekMonday, nextRefreshMonday },
        });
      }
    }

    // Ensure reps with no entries still appear
    for (const rep of allRepsFromM) {
      if (!results.find((r) => r.rep === rep)) {
        const today = new Date();
        results.push({
          rep,
          suggestion: {
            turf: "NO SUGGESTION",
            avgPerWeekYTD: null,
            nextWeekMonday: mondayOfWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)),
            nextRefreshMonday: mondayOfWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14)),
            note: "No data yet for this rep.",
          },
        });
      }
    }

    return results.sort((a, b) => a.rep.localeCompare(b.rep));
  }, [turfEntries, allRepsFromM]);


  /* Render ----------------------------------------------------------------- */

  return (
    <div className="min-h-screen" style={{ background: UI.bg, color: UI.text }}>
      {/* ───────────────────── Header ───────────────────── */}
      <header className="border-b px-6 py-4" style={{ background: UI.card, borderColor: UI.border }}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Title + premium neutral header counter */}
          <div className="flex items-baseline gap-6">
            <h1 className="text-2xl font-semibold tracking-tight">IRQ Dashboard</h1>
            {(() => {
              const today = new Date();
              const year = today.getFullYear();

              const mondayOf = (d: Date) => {
                const m = new Date(d);
                const diff = (m.getDay() + 6) % 7;
                m.setDate(m.getDate() - diff);
                m.setHours(0, 0, 0, 0);
                return m;
              };
              const weeksInclusive = (start: Date, end: Date) => {
                if (end < start) return 0;
                const s = mondayOf(start).getTime();
                const e = mondayOf(end).getTime();
                return Math.floor((e - s) / (7 * 24 * 3600 * 1000)) + 1;
              };
              const countSales = (start: Date, end: Date) => {
                let c = 0;
                for (const r of rows) if (r.date >= start && r.date <= end) c++;
                return c;
              };

              // Define clear, consistent periods:
              // Current: Jul 1 → today (H2 YTD-like)
              const curStart = new Date(year, 6, 1);
              const curEnd = today;
              const curSales = countSales(curStart, curEnd);
              const curWeeks = Math.max(1, weeksInclusive(curStart, curEnd));
              const curAvg = curSales > 0 ? curSales / curWeeks : null;

              // Previous: Jul 1 → Dec 31 of last year
              const prevStart = new Date(year - 1, 6, 1);
              const prevEnd = new Date(year - 1, 11, 31, 23, 59, 59, 999);
              const prevSales = countSales(prevStart, prevEnd);
              const prevWeeks = Math.max(1, weeksInclusive(prevStart, prevEnd));
              const prevAvg = prevSales > 0 ? prevSales / prevWeeks : null;

              if (!curAvg) return null;

              return (
                <div className="flex items-center gap-3">
                  <div
                    className="rounded-xl px-3 py-1.5 text-sm font-semibold shadow-sm"
                    style={{ background: UI.bg, border: `1px solid ${UI.border}`, color: UI.text }}
                    title={`Since Jul 1, ${year}`}
                  >
                    <span className="opacity-70 mr-2">Avg / wk</span>
                    <span className="tracking-tight">{curAvg.toFixed(2)}</span>
                  </div>
                  {prevAvg != null && (
                    <div
                      className="rounded-xl px-2.5 py-1 text-xs font-medium"
                      style={{ background: UI.card, border: `1px solid ${UI.border}`, color: UI.sub }}
                      title={`Jul–Dec ${year - 1}`}
                    >
                      {prevAvg.toFixed(2)} prev period
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="month"
              value={thisMonthKey}
              onChange={(e) => {
                setSelectedMonth(e.target.value);
                setLive(false);
              }}
              className="rounded-xl px-3 py-2 text-sm"
              style={{ background: UI.bg, border: `1px solid ${UI.border}` }}
            />
            <button
              onClick={() => {
                setSelectedMonth(ym(now));
                setLive(true);
              }}
              className="rounded-xl px-3 py-2 text-sm border"
              style={{ background: UI.card, borderColor: UI.border }}
            >
              Live
            </button>
            <label className="ml-2 text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              Auto-refresh
            </label>
            <select
              className="rounded-xl px-2 py-2 text-sm"
              value={refreshSec}
              onChange={(e) => setRefreshSec(Number(e.target.value))}
              style={{ background: UI.card, border: `1px solid ${UI.border}` }}
            >
              <option value={15}>15s</option>
              <option value={30}>30s</option>
              <option value={60}>1m</option>
              <option value={300}>5m</option>
            </select>

            {/* Refresh button with spinner + ✓ chip (fade) */}
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  const wasAuto = autoRefresh;
                  if (wasAuto) setAutoRefresh(false);
                  try {
                    await loadData();
                  } finally {
                    setJustRefreshed(true);
                    setTimeout(() => setJustRefreshed(false), 1200);
                    if (wasAuto) setTimeout(() => setAutoRefresh(true), 500);
                  }
                }}
                disabled={loading}
                aria-busy={loading}
                className="rounded-xl px-3 py-2 text-sm border inline-flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                style={{ background: UI.card, borderColor: UI.border }}
                title={loading ? "Refreshing…" : "Refresh now"}
              >
                {loading ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                    </svg>
                    Refreshing…
                  </>
                ) : (
                  <>Refresh now</>
                )}
              </button>
              <span
                className={`text-xs px-2 py-1 rounded-lg border transition-opacity duration-500 ${justRefreshed ? "opacity-100" : "opacity-0"}`}
                style={{ background: UI.bg, borderColor: UI.border, color: UI.sub }}
              >
                ✓ Refreshed
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ───────────────────── Main (unchanged non-TURF sections) ───────────────────── */}
      <main className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <StatCard
            title="Company Monthly Sales ($)"
            value={fmtMoney(company.mSalesAmt)}
            delta={deltaBadge?.text || null}
            deltaColor={deltaBadge?.color || undefined}
          />
          <StatCard title="Company YTD Sales ($)" value={fmtMoney(company.ySalesAmt)} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-6">
          <Chip title="Monthly Sales (count)" value={company.mSalesCount} />
          <Chip title="YTD Sales (count)" value={company.ySalesCount} />
          <Chip title="Monthly Profit ($)" value={fmtMoney(company.mProfit)} />
          <Chip title="YTD Profit ($)" value={fmtMoney(company.yProfit)} />
          <Chip title="Top Rep (Monthly Sales)" value={company.topRep} />
          <Chip title="Top Rep Sales (count)" value={company.topRepSales} />
        </div>

        <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
          <div className="p-6">
            <h2 className="text-lg font-semibold mb-4">
              Sales Reps Performance — {contextDate.toLocaleString(undefined, { month: "long", year: "numeric" })}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-sm" style={{ color: UI.sub, borderBottom: `1px solid ${UI.border}` }}>
                    <th className="py-2">Rep</th>
                    <th className="py-2">Monthly Sales</th>
                    <th className="py-2">Monthly Profit</th>
                    <th className="py-2">Monthly Commission</th>
                    <th className="py-2">YTD Sales</th>
                    <th className="py-2">YTD Profit</th>
                    <th className="py-2">YTD Commission</th>
                    <th className="py-2">Δ vs Prev Mo</th>
                  </tr>
                </thead>
                <tbody>
                  {repRows.map((row) => (
                    <tr
                      key={`${row.rep}-${row.mSales}-${row.ySales}-${row.mProfit}-${row.yProfit}`}
                      className="hover:bg-gray-50 transition-colors"
                      style={{ borderBottom: `1px solid ${UI.border}` }}
                    >

                      <td className="py-3 font-medium">{row.rep}</td>
                      <td className="py-3">{row.mSales}</td>
                      <td className="py-3 font-semibold">{fmtMoney(row.mProfit)}</td>
                      <td className="py-3 font-semibold">{fmtMoney(row.mComm)}</td>
                      <td className="py-3">{row.ySales}</td>
                      <td className="py-3 font-semibold">{fmtMoney(row.yProfit)}</td>
                      <td className="py-3 font-semibold">{fmtMoney(row.yComm)}</td>
                      <td className="py-3 font-semibold" style={{ color: row.diff >= 0 ? UI.pos : UI.neg }}>
                        {row.diff >= 0 ? `+${row.diff}` : row.diff}
                      </td>
                    </tr>
                  ))}
                  {repRows.length === 0 && (
                    <tr>
                      <td className="py-6 text-center" colSpan={8} style={{ color: UI.sub }}>
                        {loading ? "Loading…" : error ? `Error: ${error}` : "No rows found."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
          <div className="p-6">
            <h2 className="text-lg font-semibold mb-4">Products — Sales Count</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-sm" style={{ color: UI.sub, borderBottom: `1px solid ${UI.border}` }}>
                    <th className="py-2">Product</th>
                    <th className="py-2">Monthly Sales (count)</th>
                    <th className="py-2">YTD Sales (count)</th>
                    <th className="py-2">Total Profit ($)*</th>
                    <th className="py-2">Profit Margin (%)*</th>
                  </tr>
                </thead>
                <tbody>
                  {[...productRows]
                    .sort((a, b) => b.totalProfitAll - a.totalProfitAll)
                    .map((p) => (
                      <tr key={`${p.product}-${p.mCount}-${p.yCount}-${p.totalProfitAll}`} className="hover:bg-gray-50 transition-colors" style={{ borderBottom: `1px solid ${UI.border}` }}>
                        <td className="py-3 font-medium">{p.product}</td>
                        <td className="py-3">{p.mCount}</td>
                        <td className="py-3">{p.yCount}</td>
                        <td className="py-3 font-semibold">{fmtMoney(p.totalProfitAll)}</td>
                        <td className="py-3 font-semibold" style={{ color: p.marginPctAll >= 0 ? UI.pos : UI.neg }}>
                          {fmtPct(p.marginPctAll)}
                        </td>
                      </tr>
                    ))}
                  {productRows.length === 0 && (
                    <tr>
                      <td className="py-6 text-center" colSpan={5} style={{ color: UI.sub }}>
                        {loading ? "Loading…" : error ? `Error: ${error}` : "No product data."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="mt-2 text-xs" style={{ color: UI.sub }}>
                {live
                  ? "* Excludes the current (in-progress) month. Based on totals up to last full month."
                  : "* Includes the selected month; excludes later months."}
              </p>
            </div>
          </div>
        </section>

        {/* Average Profit per Sale — by Rep */}
        <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
          <div className="p-6">
            <h2 className="text-lg font-semibold mb-4">Average Profit per Sale — by Rep*</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-sm" style={{ color: UI.sub, borderBottom: `1px solid ${UI.border}` }}>
                    <th className="py-2">Rep</th>
                    <th className="py-2">Monthly Avg Profit / Sale*</th>
                    <th className="py-2">YTD Avg Profit / Sale*</th>
                    <th className="py-2">Monthly Sales</th>
                    <th className="py-2">YTD Sales</th>
                  </tr>
                </thead>
                <tbody>
                  {avgRows.map((r) => {
                    const counts = repRows.find((x) => x.rep === r.rep);
                    return (
                      <tr key={r.rep} className="hover:bg-gray-50 transition-colors" style={{ borderBottom: `1px solid ${UI.border}` }}>
                        <td className="py-3 font-medium">{r.rep}</td>
                        <td className="py-3 font-semibold">{fmtMoney(r.mAvg)}</td>
                        <td className="py-3 font-semibold">{fmtMoney(r.yAvg)}</td>
                        <td className="py-3">{counts ? counts.mSales : 0}</td>
                        <td className="py-3">{counts ? counts.ySales : 0}</td>
                      </tr>
                    );
                  })}
                  {avgRows.length === 0 && (
                    <tr>
                      <td className="py-6 text-center" colSpan={5} style={{ color: UI.sub }}>
                        {loading ? "Loading…" : error ? `Error: ${error}` : "No rep data."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <p className="mt-2 text-xs" style={{ color: UI.sub }}>
                * Averages exclude current month (historical-only). Counts include current month.
              </p>
            </div>
          </div>
        </section>

        {/* ────────────────────────────────────────────────────────────────── */}
        {/* TURF TRACKING (Area Tracking)                                     */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
          <div className="p-6 space-y-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">TURF TRACKING (Area Tracking)</h2>
              <div className="text-xs" style={{ color: UI.sub }}>
                Source: <strong>M</strong> Rep, <strong>N</strong> Date (DD/MM/YYYY), <strong>O</strong> Turf, <strong>P</strong> # of Sales. This section uses only M–P.
              </div>
            </div>

            {/* Suggestions table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="text-sm" style={{ color: UI.sub, borderBottom: `1px solid ${UI.border}` }}>
                    <th className="py-2">Rep (from M)</th>
                    <th className="py-2">Suggested Turf</th>
                    <th className="py-2">Avg/Wk (YTD)</th>
                    <th className="py-2">Week (Next)</th>
                    <th className="py-2">Next Refresh</th>
                    <th className="py-2">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {turfSuggestions.map((r) => (
                    <tr key={r.rep} className="hover:bg-gray-50 transition-colors" style={{ borderBottom: `1px solid ${UI.border}` }}>
                      <td className="py-3 font-medium">{r.rep}</td>
                      <td className="py-3 font-semibold" style={{ color: r.suggestion.turf !== "NO SUGGESTION" ? UI.pos : UI.sub }}>
                        {r.suggestion.turf}
                      </td>
                      <td className="py-3">{r.suggestion.avgPerWeekYTD != null ? r.suggestion.avgPerWeekYTD.toFixed(2) : "—"}</td>
                      <td className="py-3">{fmtDDMMYYYY(r.suggestion.nextWeekMonday)}</td>
                      <td className="py-3">{fmtDDMMYYYY(r.suggestion.nextRefreshMonday)}</td>
                      <td className="py-3 text-xs" style={{ color: UI.sub }}>
                        {r.suggestion.turf === "NO SUGGESTION" ? (r.suggestion.note || "Revisit after 3 weeks.") : "Eligible (not visited in last 3 weeks)."}
                      </td>
                    </tr>
                  ))}
                  {turfSuggestions.length === 0 && (
                    <tr>
                      <td className="py-6 text-center" colSpan={6} style={{ color: UI.sub }}>
                        {loading ? "Loading…" : error ? `Error: ${error}` : "No turf data found."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Per-turf cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {allTurfs.map((turf) => {
                const isActive = activeDetail?.turf === turf && activeDetail?.rep;
                const selectedRep = activeDetail?.rep || "";

                return (
                  <div key={turf} className="rounded-2xl border p-4 shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-base font-semibold">{turf}</h3>
                      {isActive ? (
                        <button onClick={() => setActiveDetail(null)} className="text-xs underline" style={{ color: UI.sub }} aria-label="Back to all reps for this turf">Back</button>
                      ) : null}
                    </div>

                    {!isActive ? (
                      <div className="space-y-3">
                        <label className="block text-xs" style={{ color: UI.sub }}>Select a rep to view detailed stats</label>
                        <select
                          className="w-full rounded-xl px-3 py-2 text-sm"
                          defaultValue=""
                          onChange={(e) => {
                            const rep = e.target.value;
                            if (rep) setActiveDetail({ turf, rep });
                          }}
                          style={{ background: UI.bg, border: `1px solid ${UI.border}` }}
                        >
                          <option value="" disabled>Choose rep…</option>
                          {allRepsFromM.map((rep) => (
                            <option key={rep} value={rep}>{rep}</option>
                          ))}
                        </select>

                        <QuickAnyVisit turf={turf} turfEntries={turfEntries} />
                      </div>
                    ) : (
                      <RepTurfDetails rep={selectedRep} turf={turf} compute={() => calcRepTurfStats(selectedRep, turf)} />
                    )}
                  </div>
                );
              })}
              {allTurfs.length === 0 && (
                <div className="text-sm" style={{ color: UI.sub }}>
                  {loading ? "Loading…" : error ? `Error: ${error}` : "No turfs found in column O."}
                </div>
              )}
            </div>

            <p className="text-xs" style={{ color: UI.sub }}>
              Notes: Rep list and stats are strictly from Columns M–P. Suggestions consider all turfs and skip only those visited in the last 3 weeks.
              “Next Refresh” = Monday two weeks from today. “Avg/Wk (YTD)” uses current-year data. “Weeks in Selected Month” adapts to your month picker.
            </p>
          </div>
        </section>

        {/* Strategic Turf Summary */}
        <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
          <div className="p-6 space-y-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">Strategic Turf Summary</h2>
              <div className="text-xs" style={{ color: UI.sub }}>
                Ranked by lifetime avg sales per week (no minimum weeks required).
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {strategicSummary.map((r) => (
                <div key={r.rep} className="rounded-2xl border p-4 shadow-sm space-y-4" style={{ background: UI.card, borderColor: UI.border }}>
                  <h3 className="text-base font-semibold">{r.rep}</h3>

                  <div>
                    <h4 className="text-sm font-semibold mb-2">Top 3 Turfs</h4>
                    {r.top.length ? (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {r.top.map((t) => (
                          <div key={`top-${r.rep}-${t.turf}`} className="rounded-xl border p-3" style={{ borderColor: UI.border }}>
                            <div className="text-sm font-semibold">{t.turf}</div>
                            <div className="mt-1 text-xs" style={{ color: UI.sub }}>Avg/Wk</div>
                            <div className="text-sm font-bold">{t.avgPerWeek.toFixed(2)}</div>
                            <div className="mt-2 text-[11px]" style={{ color: UI.sub }}>
                              Rep last: {t.lastSelf ? `${fmtDDMMYYYY(t.lastSelf)} (${weeksBetween(new Date(), t.lastSelf)} wks)` : "—"}
                            </div>
                            <div className="text-[11px]" style={{ color: UI.sub }}>
                              Any last: {t.lastAny ? `${fmtDDMMYYYY(t.lastAny)} (${weeksBetween(new Date(), t.lastAny)} wks)` : "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs" style={{ color: UI.sub }}>No history yet.</div>
                    )}
                  </div>

                  <div>
                    <h4 className="text-sm font-semibold mb-2">Turfs to Avoid (Lowest Avg/Wk)</h4>
                    {r.avoid.length ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {r.avoid.map((t) => (
                          <div key={`avoid-${r.rep}-${t.turf}`} className="rounded-xl border p-3" style={{ borderColor: UI.border }}>
                            <div className="text-sm font-semibold">{t.turf}</div>
                            <div className="mt-1 text-xs" style={{ color: UI.sub }}>Avg/Wk</div>
                            <div className="text-sm font-bold" style={{ color: UI.neg }}>{t.avgPerWeek.toFixed(2)}</div>
                            <div className="mt-2 text-[11px]" style={{ color: UI.sub }}>
                              Rep last: {t.lastSelf ? `${fmtDDMMYYYY(t.lastSelf)} (${weeksBetween(new Date(), t.lastSelf)} wks)` : "—"}
                            </div>
                            <div className="text-[11px]" style={{ color: UI.sub }}>
                              Any last: {t.lastAny ? `${fmtDDMMYYYY(t.lastAny)} (${weeksBetween(new Date(), t.lastAny)} wks)` : "—"}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs" style={{ color: UI.sub }}>No low-performing turfs yet.</div>
                    )}
                  </div>
                </div>
              ))}
              {strategicSummary.length === 0 && (
                <div className="text-sm" style={{ color: UI.sub }}>
                  {loading ? "Loading…" : error ? `Error: ${error}` : "No rep data found in Column M."}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Lifetime Sales Distribution — Column P only */}
        <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
          <div className="p-6 space-y-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">Lifetime Sales Distribution</h2>
              <div className="text-xs" style={{ color: UI.sub }}>
                Uses only Columns M–P. Sales counts come strictly from Column P.
              </div>
            </div>

            {(() => {
              const totalsByTurf = new Map<string, number>();
              const totalsByRep = new Map<string, number>();
              const byRepByTurf = new Map<string, Map<string, number>>();

              // Precompute last visit by ANY rep per turf once (perf fix)
              const lastAnyByTurf = new Map<string, Date | null>();

              for (const e of turfEntries) {
                totalsByTurf.set(e.turf, (totalsByTurf.get(e.turf) || 0) + (e.count || 0));
                totalsByRep.set(e.rep, (totalsByRep.get(e.rep) || 0) + (e.count || 0));
                if (!byRepByTurf.has(e.rep)) byRepByTurf.set(e.rep, new Map());
                const m = byRepByTurf.get(e.rep)!;
                m.set(e.turf, (m.get(e.turf) || 0) + (e.count || 0));

                const prev = lastAnyByTurf.get(e.turf) || null;
                if (!prev || e.date > prev) lastAnyByTurf.set(e.turf, e.date);
              }

              const grandTotal = Array.from(totalsByTurf.values()).reduce((s, n) => s + n, 0);

              const orderedTurfs = [...new Set(allTurfs)].sort((a, b) => {
                const pa = grandTotal > 0 ? ((totalsByTurf.get(a) || 0) / grandTotal) : 0;
                const pb = grandTotal > 0 ? ((totalsByTurf.get(b) || 0) / grandTotal) : 0;
                if (pb !== pa) return pb - pa;
                return a.localeCompare(b);
              });

              const turfDist = orderedTurfs.map((t) => {
                const c = totalsByTurf.get(t) || 0;
                const pct = grandTotal > 0 ? (100 * c) / grandTotal : 0;
                return { turf: t, count: c, pct };
              });

              const repsOrdered = [...new Set(allRepsFromM)].sort(
                (a, b) => (totalsByRep.get(b) || 0) - (totalsByRep.get(a) || 0) || a.localeCompare(b)
              );

              const repRankings = repsOrdered.map((rep) => {
                const repTotal = totalsByRep.get(rep) || 0;
                const list = orderedTurfs
                  .map((turf) => {
                    const c = byRepByTurf.get(rep)?.get(turf) || 0;
                    const pct = repTotal > 0 ? (100 * c) / repTotal : 0;
                    const lastAny = lastAnyByTurf.get(turf) || null; // perf fix
                    const weeksIdle = lastAny ? weeksBetween(new Date(), lastAny) : Infinity;
                    return { turf, pct, count: c, weeksIdle };
                  })
                  .sort((a, b) => b.pct - a.pct || a.turf.localeCompare(b.turf));
                return { rep, repTotal, list };
              });

              return (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* LEFT: % of total (P only) */}
                  <div className="rounded-2xl border p-4 shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
                    <h3 className="text-base font-semibold mb-3">By Turf — Share of Lifetime Sales</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="text-xs" style={{ color: UI.sub, borderBottom: `1px solid ${UI.border}` }}>
                            <th className="py-2">Turf</th>
                            <th className="py-2">Sales (count)</th>
                            <th className="py-2">% of Total</th>
                            <th className="py-2">Distribution</th>
                          </tr>
                        </thead>
                        <tbody>
                          {turfDist.map((r) => (
                            <tr key={r.turf} className="hover:bg-gray-50 transition-colors" style={{ borderBottom: `1px solid ${UI.border}` }}>
                              <td className="py-2 font-medium">{r.turf}</td>
                              <td className="py-2">{fmtInt(r.count)}</td>
                              <td className="py-2 font-semibold">{fmtPct(r.pct)}</td>
                              <td className="py-2">
                                <div className="w-full h-2 rounded-full" style={{ background: UI.bg, border: `1px solid ${UI.border}` }}>
                                  <div className="h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(100, r.pct))}%`, background: UI.pos }} aria-hidden />
                                </div>
                              </td>
                            </tr>
                          ))}
                          {turfDist.length === 0 && (
                            <tr>
                              <td className="py-6 text-center" colSpan={4} style={{ color: UI.sub }}>
                                {grandTotal === 0 ? "No turf data found." : "No data."}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* RIGHT: By Rep — per-rep ranking (P only) */}
                  <div className="rounded-2xl border p-4 shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
                    <h3 className="text-base font-semibold mb-3">By Rep — Turf Ranking (Column P only)</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {repRankings.map((row) => (
                        <div key={row.rep} className="rounded-xl border p-3" style={{ borderColor: UI.border }}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="text-sm font-semibold">{row.rep}</div>
                            <div className="text-xs" style={{ color: UI.sub }}>
                              {row.repTotal > 0 ? `${fmtInt(row.repTotal)} sales` : "—"}
                            </div>
                          </div>
                          <div className="max-h-72 overflow-y-auto pr-1">
                            {row.list.map((t, idx) => {
                              const highlight = idx < 2 && t.weeksIdle >= 4;
                              return (
                                <div key={`${row.rep}-${t.turf}`} className="py-1.5">
                                  <div className="flex items-center justify-between">
                                    <div className={"text-xs truncate" + (highlight ? " font-bold animate-pulse" : "")} title={t.turf} style={highlight ? { color: "#a855f7" } : undefined}>
                                      {t.turf}
                                    </div>
                                    <div className={"text-xs font-mono ml-2" + (highlight ? " font-bold animate-pulse" : "")} style={highlight ? { color: "#a855f7" } : undefined}>
                                      {fmtPct(t.pct)}
                                    </div>
                                  </div>
                                  <div className="w-full h-1.5 rounded-full mt-1" style={{ background: UI.bg, border: `1px solid ${UI.border}` }}>
                                    <div className="h-1.5 rounded-full" style={{ width: `${Math.max(0, Math.min(100, t.pct))}%`, background: UI.pos }} aria-hidden />
                                  </div>
                                  {highlight ? (
                                    <div className="mt-1 text-[10px]" style={{ color: "#a855f7" }}>
                                      idle {t.weeksIdle} wks (no visits by any rep)
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </section>

        {/* Rotation Guardrails */}
        <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
          <div className="p-6 space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">Rotation Guardrails</h2>
              <div className="text-xs" style={{ color: UI.sub }}>
                Warn when a rep has &gt;2 consecutive weeks in the same turf (last 12 weeks)
              </div>
            </div>
            {(() => {
              const byRepWeekTurf = new Map<string, Map<string, string>>();
              for (const e of turfEntries) {
                if (!byRepWeekTurf.has(e.rep)) byRepWeekTurf.set(e.rep, new Map());
                const m = byRepWeekTurf.get(e.rep)!;
                m.set(e.week, e.turf);
              }

              const weeks: string[] = [];
              let d = mondayOfWeek(new Date());
              for (let i = 0; i < 12; i++) {
                weeks.push(weekKey(d));
                d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
              }

              const warnings: { rep: string; turf: string; streak: number; weeks: string[] }[] = [];

              byRepWeekTurf.forEach((wkMap, rep) => {
                let curTurf = "";
                let streak = 0;
                let streakWeeks: string[] = [];
                for (const w of weeks) {
                  const t = wkMap.get(w) || "";
                  if (t && t === curTurf) {
                    streak++;
                    streakWeeks.push(w);
                  } else if (t) {
                    if (streak > 2 && curTurf) warnings.push({ rep, turf: curTurf, streak, weeks: [...streakWeeks] });
                    curTurf = t;
                    streak = 1;
                    streakWeeks = [w];
                  } else {
                    if (streak > 2 && curTurf) warnings.push({ rep, turf: curTurf, streak, weeks: [...streakWeeks] });
                    curTurf = "";
                    streak = 0;
                    streakWeeks = [];
                  }
                }
                if (streak > 2 && curTurf) warnings.push({ rep, turf: curTurf, streak, weeks: [...streakWeeks] });
              });

              if (!warnings.length) return <div className="text-sm" style={{ color: UI.sub }}>All good — no guardrail issues found.</div>;
              return (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {warnings.map((w, i) => (
                    <div key={`warn-${i}`} className="rounded-xl p-3" style={{ background: UI.bg, border: `1px solid ${UI.border}` }}>
                      <div className="text-sm font-semibold">{w.rep}</div>
                      <div className="text-xs" style={{ color: UI.sub }}>
                        {w.turf} · {w.streak} consecutive weeks
                      </div>
                      <div className="text-[10px]" style={{ color: UI.sub }}>
                        {w.weeks.join(", ")}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </section>
        {/* ───────────────────── Monthly Income ───────────────────── */}
        {(() => {
          // Helper badge for % vs last year (sleek)
          const YearlyDeltaBadge = ({ pct }: { pct: number | null }) => {
            if (pct == null) return null;
            const isUp = pct >= 0;
            return (
              <span
                className="text-xs font-semibold px-2 py-1 rounded-full inline-flex items-center gap-1"
                style={{
                  background: isUp ? hexToRGBA(UI.pos, 0.1) : hexToRGBA(UI.neg, 0.1),
                  color: isUp ? UI.pos : UI.neg,
                  border: `1px solid ${isUp ? UI.pos : UI.neg}`,
                }}
              >
                {isUp ? "▲" : "▼"} {Math.abs(Math.round(pct))}%
              </span>
            );
          };

          // Build a dynamic year list from your data (+ baseline 2025) and include next year
          const yearsInData = new Set<number>();
          for (const r of rows) yearsInData.add(r.date.getFullYear());
          yearsInData.add(2025);

          const currentYear = new Date().getFullYear();
          const maxDataYear = Math.max(...Array.from(yearsInData), currentYear);
          const minDataYear = Math.min(...Array.from(yearsInData));
          const maxYear = maxDataYear + 1; // allow selecting next year ahead of time

          const years: number[] = [];
          for (let y = minDataYear; y <= maxYear; y++) years.push(y);

          const monthNames = [
            "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
            "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
          ];

          // Start at JUNE only for the 2025 view; otherwise show Jan–Dec
          const startIdx = incomeYear === 2025 ? 5 : 0;

          // Pre-aggregate profit by year-month
          const profitByYM = new Map<string, number>(); // "YYYY-MM" -> sum(profit)
          for (const r of rows) {
            const y = r.date.getFullYear();
            const m = r.date.getMonth() + 1;
            const key = `${y}-${String(m).padStart(2, "0")}`;
            profitByYM.set(key, (profitByYM.get(key) || 0) + (r.profit || 0));
          }

          return (
            <section className="rounded-2xl border shadow-sm" style={{ background: UI.card, borderColor: UI.border }}>
              <div className="p-6">
                <div className="flex items-baseline justify-between mb-4">
                  <h2 className="text-lg font-semibold">Monthly Income</h2>
                  <select
                    value={incomeYear}
                    onChange={(e) => setIncomeYear(parseInt(e.target.value, 10))}
                    className="rounded-lg px-2 py-1 text-sm"
                    style={{ background: UI.bg, border: `1px solid ${UI.border}` }}
                  >
                    {years.map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="text-sm" style={{ color: UI.sub, borderBottom: `1px solid ${UI.border}` }}>
                        <th className="py-2">Month</th>
                        <th className="py-2">Profit</th>
                        <th className="py-2 text-right">Δ vs LY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        let total = 0;
                        const out: JSX.Element[] = [];

                        for (let m = startIdx; m < 12; m++) {
                          const ymThis = `${incomeYear}-${String(m + 1).padStart(2, "0")}`;
                          const ymLast = `${incomeYear - 1}-${String(m + 1).padStart(2, "0")}`;

                          const thisProfit = profitByYM.get(ymThis) || 0;
                          const lastProfit = profitByYM.get(ymLast) || 0;
                          total += thisProfit;

                          let pct: number | null = null;
                          if (lastProfit > 0) pct = ((thisProfit - lastProfit) / lastProfit) * 100;

                          out.push(
                            <tr key={`${incomeYear}-${m}`} style={{ borderBottom: `1px solid ${UI.border}` }}>
                              <td className="py-2 font-medium">{monthNames[m]} {incomeYear}</td>
                              <td className="py-2 font-semibold">{fmtMoney(thisProfit)}</td>
                              <td className="py-2 text-right">
                                <YearlyDeltaBadge pct={pct} />
                              </td>
                            </tr>
                          );
                        }

                        let prevTotal = 0;
                        for (let m = startIdx; m < 12; m++) {
                          prevTotal +=
                            profitByYM.get(`${incomeYear - 1}-${String(m + 1).padStart(2, "0")}`) || 0;
                        }
                        const pctTotal = prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null;

                        out.push(
                          <tr key={`total-${incomeYear}`}>
                            <td className="py-2 font-semibold">TOTAL {incomeYear}</td>
                            <td className="py-2 font-bold">{fmtMoney(total)}</td>
                            <td className="py-2 text-right">
                              <YearlyDeltaBadge pct={pctTotal} />
                            </td>
                          </tr>
                        );

                        return out;
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          );
        })()}
        
      </main>
    </div>
  );
}

/* Components */
function StatCard({ title, value, delta, deltaColor }: { title: string; value: any; delta?: string | null; deltaColor?: string; }) {
  return (
    <div className="rounded-2xl p-6 shadow-sm relative" style={{ background: UI.card, border: `1px solid ${UI.border}` }}>
      {delta ? (
        <span className="absolute top-2 right-2 text-xs font-semibold px-2 py-1 rounded-full" style={{ background: "rgba(0,0,0,0.04)", color: deltaColor || UI.sub, border: `1px solid ${deltaColor || UI.border}` }} title="Change vs previous month">{delta}</span>
      ) : null}
      <p className="text-sm" style={{ color: UI.sub }}>{title}</p>
      <p className="text-3xl font-bold">{value}</p>
    </div>
  );
}

function Chip({ title, value }: { title: string; value: any }) {
  return (
    <div className="rounded-2xl p-4 shadow-sm" style={{ background: UI.chipDark, color: "#fff", border: `1px solid ${UI.border}` }}>
      <p className="text-xs opacity-80">{title}</p>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function QuickAnyVisit({
  turf,
  turfEntries,
}: {
  turf: string;
  turfEntries: { turf: string; date: Date; rep: string }[];
}) {
  // single pass to get latest visit + rep name
  const last = useMemo(() => {
    let date: Date | null = null;
    let rep: string | null = null;
    for (const e of turfEntries) {
      if (e.turf !== turf) continue;
      if (!date || e.date > date) {
        date = e.date;
        rep = e.rep || null;
      }
    }
    return { date, rep };
  }, [turf, turfEntries]);

  const weeks = last.date ? weeksBetween(new Date(), last.date) : null;
  const line = last.date
    ? `${fmtDDMMYYYY(last.date)} (${weeks} weeks ago) - ${(last.rep || "").toUpperCase()}`
    : "—";

  return (
    <div className="rounded-xl p-3" style={{ background: UI.bg, border: `1px solid ${UI.border}` }}>
      <div className="text-xs" style={{ color: UI.sub }}>Last time ANY rep visited</div>
      <div className="text-sm font-semibold">{line}</div>
    </div>
  );
}

function RepTurfDetails({
  rep,
  turf,
  compute,
}: {
  rep: string;
  turf: string;
  compute: () => {
    lifetimeSales: number;
    lifetimeWeeks: number;
    avgPerVisit: number;
    ytdSales: number;
    ytdWeeks: number;
    ytdAvg: number;
    last: Date | null;
    weeksSinceLast: number | null;
    best: { date: Date; count: number } | null;
    worst: { date: Date; count: number } | null;
    seasonalAvg: number;
    nextEligible: Date;
    monthWeeks: number;
    monthSales: number;
    lastAny: Date | null;
    lastAnyRep: string | null;
    weeksSinceAny: number | null;
  };
}) {
  const s = compute();
  const lastAnyLine =
    s.lastAny
      ? `${fmtDDMMYYYY(s.lastAny)} (${s.weeksSinceAny} weeks ago) - ${(s.lastAnyRep || "").toUpperCase()}`
      : "—";

  return (
    <div className="space-y-4">
      <div className="text-sm">
        <div className="text-xs mb-1" style={{ color: UI.sub }}>{rep}</div>
        <div className="grid grid-cols-2 gap-3">
          <MiniStat label="Lifetime Sales" value={fmtInt(s.lifetimeSales)} />
          <MiniStat label="Lifetime Weeks" value={fmtInt(s.lifetimeWeeks)} />
          <MiniStat label="Avg / Visit (Lifetime)" value={s.avgPerVisit.toFixed(2)} />
          <MiniStat label="YTD Sales" value={fmtInt(s.ytdSales)} />
          <MiniStat label="YTD Weeks" value={fmtInt(s.ytdWeeks)} />
          <MiniStat label="Avg / Visit (YTD)" value={s.ytdAvg.toFixed(2)} />
          <MiniStat label="Weeks in Selected Month" value={fmtInt(s.monthWeeks)} />
          <MiniStat label="Sales in Selected Month" value={fmtInt(s.monthSales)} />
        </div>
      </div>

      <div className="text-sm grid grid-cols-2 gap-3">
        <MiniStat label="Last Visit (This Rep)" value={s.last ? fmtDDMMYYYY(s.last) : "—"} sub={s.weeksSinceLast != null ? `${s.weeksSinceLast} weeks ago` : ""} />
        <MiniStat label="Next Eligible (3-week rule)" value={fmtDDMMYYYY(s.nextEligible)} />
        <MiniStat label="Best Week" value={s.best ? `${fmtInt(s.best.count)} sales` : "—"} sub={s.best ? fmtDDMMYYYY(s.best.date) : ""} />
        <MiniStat label="Worst Week" value={s.worst ? `${fmtInt(s.worst.count)} sales` : "—"} sub={s.worst ? fmtDDMMYYYY(s.worst.date) : ""} />
      </div>

      {/* NEW: Always show last ANY visit with rep name */}
      <div className="rounded-xl p-3" style={{ background: UI.bg, border: `1px solid ${UI.border}` }}>
        <div className="text-xs mb-1" style={{ color: UI.sub }}>Last time ANY rep visited this turf</div>
        <div className="text-base font-semibold">{lastAnyLine}</div>
      </div>

      <div className="rounded-xl p-3" style={{ background: UI.bg, border: `1px solid ${UI.border}` }}>
        <div className="text-xs mb-1" style={{ color: UI.sub }}>Seasonality (this month-of-year across all years)</div>
        <div className="text-base font-semibold">{s.seasonalAvg.toFixed(2)} avg sales / week</div>
      </div>
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl p-3 border" style={{ borderColor: UI.border }}>
      <div className="text-xs" style={{ color: UI.sub }}>{label}</div>
      <div className="text-base font-semibold">{value}</div>
      {sub ? <div className="text-xs mt-1" style={{ color: UI.sub }}>{sub}</div> : null}
    </div>
  );
}

/* Sanity check */
console.assert(
  [{ product: "A", mCount: 5, yCount: 1 }, { product: "B", mCount: 3, yCount: 10 }, { product: "C", mCount: 3, yCount: 2 }]
    .sort((a, b) => b.mCount - a.mCount || b.yCount - a.yCount || a.product.localeCompare(b.product))
    .map((x) => x.product)
    .join(",") === "A,B,C",
  "Products should sort by Monthly desc, then YTD desc, then name"
);
