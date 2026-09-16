import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <div className="head">
        <span className="eyebrow">no such screen</span>
        <h1>Out of remit</h1>
        <p className="lede">
          The console has five: the overview, the review queue, the receipt ledger, the
          Remit, and the kill switch.
        </p>
      </div>
      <section>
        <p>
          <Link href="/">Back to the overview</Link>
        </p>
      </section>
    </>
  );
}
