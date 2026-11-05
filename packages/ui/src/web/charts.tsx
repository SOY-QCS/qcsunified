"use client";
/**
 * Small, dependency-free charts for the dashboard and the portal (plain SVG + HTML).
 * Rules: thin marks, 2px gaps between stacked segments, 4px rounded tops on the baseline, recessive grid,
 * a hover tooltip on every mark, a legend whenever there are 2+ series, and a "Show as table" view for every chart.
 * Service colours are fixed per service (never by rank) and were checked for colour-blind separation.
 */
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";

const INK = { primary: "#1a1a1a", secondary: "#55524d", muted: "#8a857e", grid: "#ebe6df", surface: "#ffffff" };
const SEQ = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#104281"];   // one hue, light → dark

import { FORMATS, SERVICE_SERIES, fmtInt, type FmtName } from "./format";

/** "Nice" axis maximum and 3–4 ticks. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

const box: CSSProperties = { position: "relative", width: "100%" };
const tipStyle: CSSProperties = {
  position: "absolute", pointerEvents: "none", background: "#fff", border: "1px solid #e6e1da", borderRadius: 8, padding: "6px 10px",
  fontSize: 12, color: INK.primary, boxShadow: "0 4px 14px rgba(0,0,0,.08)", whiteSpace: "nowrap", zIndex: 5, transform: "translate(-50%, calc(-100% - 8px))",
};

function Legend({ series }: { series: readonly { key: string; label: string; color: string }[] }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: INK.secondary, marginBottom: 6 }}>
      {series.map((s) => <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, display: "inline-block" }} />{s.label}</span>)}
    </div>
  );
}

function TableView({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details style={{ marginTop: 6 }}>
      <summary style={{ cursor: "pointer", fontSize: 12, color: INK.muted }}>Show as table</summary>
      <div style={{ overflowX: "auto" }}><table style={{ fontSize: 13 }}><thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
    </details>
  );
}

/** Rounded-top bar segment (only the top corners are rounded; the base sits square on the axis or the segment below). */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export interface StackRow { label: string; title?: string; values: Record<string, number> }

/** Stacked columns over time (e.g. orders per day by service). */
export function StackedBars({ rows, series, format: fmtName = "int", height = 220, unit = "" }: {
  rows: StackRow[]; series: readonly { key: string; label: string; color: string }[]; format?: FmtName; height?: number; unit?: string;
}) {
  const format = FORMATS[fmtName];
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = height, L = 44, B = 22, T = 8;
  const totals = rows.map((r) => series.reduce((s, x) => s + (r.values[x.key] ?? 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1]!;
  const slot = (W - L) / Math.max(rows.length, 1);
  const bw = Math.max(2, Math.min(28, slot * 0.66));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const every = Math.ceil(rows.length / 10);
  return (
    <div style={box}>
      {series.length > 1 && <Legend series={series} />}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${series.map((s) => s.label).join(", ")} per ${unit || "period"}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke={INK.grid} strokeWidth={1} />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={INK.muted}>{format(t)}</text></g>)}
        {rows.map((r, i) => {
          const cx = L + slot * i + slot / 2;
          let acc = 0;
          const segs = series.map((s) => ({ s, v: r.values[s.key] ?? 0 })).filter((x) => x.v > 0);
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={cx - slot / 2} y={T} width={slot} height={H - T - B} fill="transparent" />
              {segs.map(({ s, v }, j) => {
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                const h = Math.max(0, y0 - y1 - (j < segs.length - 1 ? 2 : 0));   // 2px surface gap between segments
                const isTop = j === segs.length - 1;
                return isTop ? <path key={s.key} d={topRounded(cx - bw / 2, y1, bw, Math.max(h, 1), 4)} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />
                  : <rect key={s.key} x={cx - bw / 2} y={y0 - h} width={bw} height={h} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} />;
              })}
              {i % every === 0 && <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill={INK.muted}>{r.label}</text>}
            </g>
          );
        })}
        <line x1={L} x2={W} y1={y(0)} y2={y(0)} stroke="#cfc8bf" />
      </svg>
      {hover !== null && rows[hover] && (
        <div style={{ ...tipStyle, left: `${((L + slot * hover + slot / 2) / W) * 100}%`, top: `${(y(totals[hover]!) / H) * 100}%` }}>
          <strong>{rows[hover]!.title ?? rows[hover]!.label}</strong> · {format(totals[hover]!)} {totals[hover] === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit}
          {series.length > 1 && series.map((s) => <div key={s.key} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />{s.label}: {format(rows[hover]!.values[s.key] ?? 0)}</div>)}
        </div>
      )}
      <TableView head={["", ...series.map((s) => s.label), ...(series.length > 1 ? ["Total"] : [])]}
        rows={rows.map((r, i) => [r.title ?? r.label, ...series.map((s) => format(r.values[s.key] ?? 0)), ...(series.length > 1 ? [format(totals[i]!)] : [])])} />
    </div>
  );
}

/** One measure over time (e.g. revenue per day): 2px line, crosshair + tooltip. */
export function LineChart({ points, format: fmtName = "int", color = SERVICE_SERIES[0].color, height = 200, name }: {
  points: { label: string; title?: string; value: number }[]; format?: FmtName; color?: string; height?: number; name: string;
}) {
  const format = FORMATS[fmtName];
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const W = 720, H = height, L = 60, B = 22, T = 10;
  const ticks = niceTicks(Math.max(...points.map((p) => p.value), 0));
  const top = ticks[ticks.length - 1]!;
  const x = (i: number) => L + ((W - L - 10) * i) / Math.max(points.length - 1, 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join("");
  const every = Math.ceil(points.length / 10);
  return (
    <div style={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={name}
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - 10)) * (points.length - 1))))); }}
        onMouseLeave={() => setHover(null)}>
        <defs><linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity={0.14} /><stop offset="1" stopColor={color} stopOpacity={0} /></linearGradient></defs>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke={INK.grid} />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill={INK.muted}>{format(t)}</text></g>)}
        {points.length > 1 && <path d={`${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={`url(#${id})`} />}
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => i % every === 0 && <text key={i} x={x(i)} y={H - 6} textAnchor={i === points.length - 1 ? "end" : i === 0 ? "start" : "middle"} fontSize={11} fill={INK.muted}>{p.label}</text>)}
        {hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#bdb6ad" strokeDasharray="3 3" />
          <circle cx={x(hover)} cy={y(points[hover]!.value)} r={5} fill={color} stroke={INK.surface} strokeWidth={2} /></g>}
      </svg>
      {hover !== null && <div style={{ ...tipStyle, left: `${(x(hover) / W) * 100}%`, top: `${(y(points[hover]!.value) / H) * 100}%` }}>
        <strong>{points[hover]!.title ?? points[hover]!.label}</strong> · {name}: {format(points[hover]!.value)}</div>}
      <TableView head={["", name]} rows={points.map((p) => [p.title ?? p.label, format(p.value)])} />
    </div>
  );
}

/** Ranked horizontal bars with the value written at the end (e.g. failure reasons). */
export function BarList({ items, format: fmtName = "int", color = SERVICE_SERIES[0].color, empty = "Nothing to show" }: {
  items: { label: string; value: number; note?: string }[]; format?: FmtName; color?: string; empty?: string;
}) {
  const format = FORMATS[fmtName];
  const max = Math.max(...items.map((i) => i.value), 0);
  if (!items.length) return <p style={{ color: INK.muted, fontSize: 13 }}>{empty}</p>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {items.map((it) => (
        <div key={it.label} title={`${it.label}: ${format(it.value)}${it.note ? ` (${it.note})` : ""}`}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: INK.primary, marginBottom: 3 }}>
            <span>{it.label}</span><span style={{ color: INK.secondary }}>{format(it.value)}{it.note ? <span style={{ color: INK.muted }}> · {it.note}</span> : null}</span>
          </div>
          <div style={{ height: 8, background: "#f1ede8", borderRadius: 4 }}>
            <div style={{ width: `${max ? (it.value / max) * 100 : 0}%`, minWidth: it.value ? 3 : 0, height: 8, background: color, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** A headline number with the change against the previous period (arrow + words, never colour alone). */
export function Kpi({ label, value, previous, format: fmtName = "int", upIsGood = true, hint }: {
  label: string; value: number | null | undefined; previous?: number | null; format?: FmtName; upIsGood?: boolean; hint?: ReactNode;
}) {
  const format = FORMATS[fmtName];
  const v = value ?? null;
  const change = v != null && previous != null && previous !== 0 ? ((v - previous) / Math.abs(previous)) * 100 : null;
  const good = change == null ? null : (change >= 0) === upIsGood;
  return (
    <div style={{ background: "#fff", border: "1px solid #e6e1da", borderRadius: 10, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ fontSize: 12, color: INK.secondary }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: INK.primary, lineHeight: 1.25 }}>{v == null ? "—" : format(v)}</div>
      {change != null && Math.abs(change) >= 0.5 && (
        <div style={{ fontSize: 12, color: good ? "#1f8a4c" : "#b3261e" }}>{change > 0 ? "▲" : "▼"} {Math.abs(change).toFixed(0)}% <span style={{ color: INK.muted }}>vs previous period</span></div>
      )}
      {change != null && Math.abs(change) < 0.5 && <div style={{ fontSize: 12, color: INK.muted }}>same as previous period</div>}
      {hint && <div style={{ fontSize: 12, color: INK.muted }}>{hint}</div>}
    </div>
  );
}

/** Density squares on a simple map projection, with zone outlines for orientation (no paid map service needed). */
export function HeatGrid({ cells, outlines = [], height = 420, cellDeg = 0.005 }: {
  cells: { lat: number; lng: number; n: number }[]; outlines?: { name: string; ring: [number, number][] }[]; height?: number; cellDeg?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = useMemo(() => [...cells.map((c) => [c.lng, c.lat] as [number, number]), ...outlines.flatMap((o) => o.ring)], [cells, outlines]);
  if (!cells.length) return <p style={{ color: INK.muted, fontSize: 13 }}>No drop-offs in this period.</p>;
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  const k = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);       // keep squares square at Ghana's latitude
  const spanX = Math.max((maxX - minX) * k, 0.02), spanY = Math.max(maxY - minY, 0.02);
  const W = 720, H = height, pad = 16;
  const s = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const X = (lng: number) => pad + (lng - minX) * k * s + ((W - 2 * pad) - spanX * s) / 2;
  const Y = (lat: number) => H - pad - (lat - minY) * s - ((H - 2 * pad) - spanY * s) / 2;
  const max = Math.max(...cells.map((c) => c.n));
  const step = (n: number) => SEQ[Math.min(SEQ.length - 1, Math.floor((Math.log(n) / Math.log(max + 1)) * SEQ.length))]!;
  const size = Math.max(3, cellDeg * k * s - 1);
  return (
    <div style={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Drop-offs per area" onMouseLeave={() => setHover(null)} style={{ background: "#faf8f5", borderRadius: 8 }}>
        {outlines.map((o, i) => <polygon key={o.name + i} points={o.ring.map(([lng, lat]) => `${X(lng)},${Y(lat)}`).join(" ")} fill="none" stroke="#cfc8bf" strokeWidth={1} />)}
        {cells.map((c, i) => <rect key={i} x={X(c.lng) - size / 2} y={Y(c.lat) - size / 2} width={size} height={size} rx={2} fill={step(c.n)}
          stroke={hover === i ? INK.primary : INK.surface} strokeWidth={hover === i ? 1.5 : 1} onMouseEnter={() => setHover(i)} />)}
        {/* zone names on top of the squares, with a white halo so they stay readable */}
        {outlines.map((o, i) => <text key={"t" + o.name + i} x={o.ring.reduce((a, p) => a + X(p[0]), 0) / o.ring.length} y={o.ring.reduce((a, p) => a + Y(p[1]), 0) / o.ring.length}
          fontSize={11} fontWeight={600} fill={INK.secondary} textAnchor="middle" stroke="#ffffff" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: "none" }}>{o.name}</text>)}
      </svg>
      {hover !== null && <div style={{ ...tipStyle, left: `${(X(cells[hover]!.lng) / W) * 100}%`, top: `${(Y(cells[hover]!.lat) / H) * 100}%` }}>
        <strong>{fmtInt(cells[hover]!.n)} drop-offs</strong> · around {cells[hover]!.lat.toFixed(3)}, {cells[hover]!.lng.toFixed(3)}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: INK.secondary, marginTop: 6 }}>
        Fewer {SEQ.map((c) => <span key={c} style={{ width: 16, height: 10, background: c, borderRadius: 2, display: "inline-block" }} />)} More
        <span style={{ color: INK.muted }}>· each square ≈ 550 m · max {fmtInt(max)}</span>
      </div>
    </div>
  );
}
