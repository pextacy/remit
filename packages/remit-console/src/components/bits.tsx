import type { ReactNode } from "react";

/** A hash, shortened for the eye, whole on hover. */
export function Hash({ value, href }: { value: string; href?: string }) {
  const short = value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  const inner = (
    <code className="mono" title={value}>
      {short}
    </code>
  );
  return href === undefined ? (
    inner
  ) : (
    <a href={href} target="_blank" rel="noreferrer">
      {inner}
    </a>
  );
}

/** A number that matters, with what it is and what it is out of. */
/**
 * One attempt, drawn as a line on the grid with its measure beneath it.
 *
 * The measure is a sibling of the text rather than a cell inside it, so its width is a
 * share of the page — the only frame the remit line is drawn on.
 */
export function Record({
  sequence,
  what,
  detail,
  gates,
  outcome,
  amount,
  cap,
  refused,
  meta,
}: {
  sequence: number;
  what: ReactNode;
  detail?: ReactNode;
  gates: readonly { gate: string; outcome: string }[];
  outcome: string;
  /** Undefined when no call was ever built — a G1 refusal has nothing to measure. */
  amount?: number;
  cap: number;
  refused: boolean;
  meta?: ReactNode;
}) {
  return (
    <article className="record" data-refused={String(refused)}>
      <div className="record-line">
        <span className="num">#{sequence}</span>
        <span className="record-what">{what}</span>
        <span>
          <Gates gates={gates} />
        </span>
        <span className="num record-outcome">{outcome}</span>
      </div>

      {amount === undefined ? null : (
        <Measure amount={amount} cap={cap} refused={refused} />
      )}

      {detail === undefined && meta === undefined ? null : (
        <div className="record-meta">
          {detail}
          {meta}
        </div>
      )}
    </article>
  );
}

export function Figure({
  label,
  value,
  sub,
  mark,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  /** Underline it. At most one figure per screen earns this. */
  mark?: boolean;
}) {
  return (
    <div className="figure" {...(mark === true ? { "data-mark": "true" } : {})}>
      <span className="label">{label}</span>
      <b>{value}</b>
      {sub === undefined ? null : <small>{sub}</small>}
    </div>
  );
}

const CAP_SHARE = 66.666;

/**
 * How far along the page an amount reaches, with the cap on the remit line.
 *
 * The length is the number. An amount at the cap lands exactly on the line; one above it
 * crosses and is cut off at the container edge, which is the only thing in this design
 * allowed to cross. A bar that lied about its length would make every other number on the
 * screen worth doubting.
 */
export function measureWidth(amount: number, cap: number): string {
  if (!(cap > 0) || !Number.isFinite(amount) || amount <= 0) return "0%";
  return `${Math.min((amount / cap) * CAP_SHARE, 100)}%`;
}

export function Measure({
  amount,
  cap,
  refused,
  left,
  right,
  showCap,
  mark,
}: {
  amount: number;
  cap: number;
  refused?: boolean;
  left?: ReactNode;
  right?: ReactNode;
  /** Draw the cap tick. Off inside the spine, where the page's own line already marks it. */
  showCap?: boolean;
  /**
   * A second threshold on the same track — the point at which an action stops for a
   * person. It belongs here rather than in a figure of its own: the reviewer's question
   * is "how far along this line does a human get involved", and that is a place on the
   * line.
   */
  mark?: { at: number; label: string };
}) {
  return (
    <>
      <div
        className="measure"
        {...(refused === true ? { "data-refused": "true" } : {})}
        style={{ ["--measure" as string]: measureWidth(amount, cap) }}
      >
        <div className="measure-bar" />
        {mark === undefined || !(mark.at > 0) || !(mark.at < cap) ? null : (
          <div className="measure-mark" style={{ left: measureWidth(mark.at, cap) }}>
            <span>{mark.label}</span>
          </div>
        )}
        {showCap === true ? <div className="measure-cap" /> : null}
      </div>
      {left === undefined && right === undefined ? null : (
        <div className="measure-foot">
          <span>{left}</span>
          <span>{right}</span>
        </div>
      )}
    </>
  );
}

/**
 * A cap, stated at the size it deserves, with its measure underneath.
 *
 * On the Remit screen the caps *are* the document — the largest thing on the page should
 * be the number that bounds everything else, not a heading that describes it.
 */
export function Cap({
  label,
  value,
  unit,
  children,
}: {
  label: string;
  value: string;
  unit: string;
  children: ReactNode;
}) {
  return (
    <div className="cap">
      <span className="label">{label}</span>
      <p className="cap-value">
        {value}
        <em>{unit}</em>
      </p>
      {children}
    </div>
  );
}

const SLOTS = ["G1", "G2", "G3", "G4"] as const;

/** What each gate actually asks. A reviewer being asked to be G3 should see the other three. */
const ASKS: Record<string, string> = {
  G1: "the envelope",
  G2: "the preflight",
  G3: "a person",
  G4: "the chain",
};

/**
 * The four gates written out, for the one screen where a person is the gate.
 *
 * Ticks alone are a shape to scan a long list by. Here there is one action and a decision
 * to make about it, so each gate says what it asked and what it answered — a reviewer who
 * cannot see that G1 and G2 already agreed is a reviewer being asked to take it on trust.
 */
export function GateSequence({
  gates,
}: {
  gates: readonly { gate: string; outcome: string; detail?: string | undefined }[];
}) {
  const byName = new Map(gates.map((gate) => [gate.gate, gate]));

  return (
    <div className="sequence">
      {SLOTS.map((slot) => {
        const gate = byName.get(slot);
        const outcome = gate?.outcome;
        return (
          <div key={slot} className="sequence-gate" data-outcome={outcome ?? "absent"}>
            <span className="sequence-name">{slot}</span>
            <span className="sequence-asks">{ASKS[slot]}</span>
            <i />
            <span className="sequence-verdict">
              {outcome === undefined ? "not yet" : outcome}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Four slots, always the same four and always in the same place.
 *
 * A refusal at G2 is therefore always the second tick, and an operator learns to read the
 * shape rather than the words. A gate that never ran has an empty slot: "nobody looked"
 * and "it passed" must not look alike.
 */
export function Gates({
  gates,
}: {
  gates: readonly { gate: string; outcome: string }[];
}) {
  const byName = new Map(gates.map((gate) => [gate.gate, gate.outcome]));

  return (
    <span className="gates">
      {SLOTS.map((slot) => {
        const outcome = byName.get(slot);
        return (
          <span
            key={slot}
            className="gate"
            data-outcome={outcome ?? "absent"}
            title={`${slot} ${outcome ?? "did not run"}`}
          >
            <span>{slot}</span>
            <i />
          </span>
        );
      })}
    </span>
  );
}

/**
 * Something on disk is not what it claims to be.
 *
 * Inverted, because there is no red in this design to reach for and because a block that
 * turns the page inside out is the one thing an operator cannot scroll past.
 */
export function Problem({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="problem">
      <strong>{title}</strong>
      {detail === undefined ? null : <p className="mono">{detail}</p>}
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
