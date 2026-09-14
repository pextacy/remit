import type { ReactNode } from "react";

/** A hash, shortened for the eye but linked to the whole. */
export function Hash({ value, href }: { value: string; href?: string }) {
  const short = value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  const inner = <code title={value}>{short}</code>;
  return href === undefined ? (
    inner
  ) : (
    <a href={href} target="_blank" rel="noreferrer">
      {inner}
    </a>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "ok" | "no" | "warn";
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ""}`}>{value}</div>
      {sub === undefined ? null : <div className="sub">{sub}</div>}
    </div>
  );
}

const GATE_TONE: Record<string, string> = {
  pass: "ok",
  refused: "no",
  declined: "no",
  reverted: "no",
  skipped: "muted",
};

export function GatePill({
  gate,
  outcome,
  code,
}: {
  gate: string;
  outcome: string;
  code?: string;
}) {
  const tone = GATE_TONE[outcome] ?? "";
  return (
    <span className={`pill ${tone === "muted" ? "" : tone}`} title={code ?? outcome}>
      <span className="mono">{gate}</span> {outcome}
      {code === undefined ? "" : ` · ${code}`}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
