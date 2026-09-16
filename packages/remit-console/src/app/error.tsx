"use client";

/**
 * What the operator sees when a screen throws.
 *
 * Next's default is a blank page, which is the worst thing this console could show: its
 * whole job is to say when something is wrong, and going dark is indistinguishable from
 * everything being fine. So the failure is named, and the two commands that answer "is the
 * underlying data actually intact?" are on the page — they need nothing from this process
 * and work when it is the thing that has failed.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div data-inverted="true">
      <div className="head">
        <span className="eyebrow">this screen, not the chain</span>
        <h1>Unrendered</h1>
        <p className="lede">
          The console reads the repository&apos;s own files. Something it read was not
          what it expected, which is a fact about the files and not only about this
          screen.
        </p>
      </div>

      <section>
        <dl className="terms">
          <dt>failure</dt>
          <dd>{error.message || "no message"}</dd>
          {error.digest === undefined ? null : (
            <>
              <dt>digest</dt>
              <dd>{error.digest}</dd>
            </>
          )}
        </dl>

        <p className="lede" style={{ marginTop: 28 }}>
          Check the data without going through the console:
        </p>
        <pre>
          <code>
            uv run --directory packages/remit-bridge remit verify --network $REMIT_NETWORK
            {"\n"}
            pnpm --filter ops status --network $REMIT_NETWORK
          </code>
        </pre>

        <div className="controls">
          <button type="button" onClick={reset}>
            Try again
          </button>
        </div>
      </section>
    </div>
  );
}
