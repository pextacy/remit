"use client";

/**
 * A file in the queue that is not a review item stops this screen, and that is right: an
 * operator must not be shown a partial queue and left to assume it is the whole one. The
 * failure is named rather than the queue being silently trimmed.
 */
export default function ReviewError({ error }: { error: Error & { digest?: string } }) {
  return (
    <div data-inverted="true">
      <div className="head">
        <span className="eyebrow">g3 · the queue</span>
        <h1>Unreadable</h1>
        <p className="lede">
          One of the files in <code>ops/review/pending</code> is not a review item.
          Nothing has been approved or declined, and no partial queue is being shown — a
          queue you cannot trust to be complete is worse than one that refuses to render.
        </p>
      </div>

      <section>
        <dl className="terms">
          <dt>failure</dt>
          <dd>{error.message || "no message"}</dd>
        </dl>
      </section>
    </div>
  );
}
