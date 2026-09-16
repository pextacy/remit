"use client";

/**
 * An error thrown in the root layout itself, where `error.tsx` cannot run because there is
 * no layout left to render it into. It brings its own `html` and `body` and depends on no
 * stylesheet — at this point the stylesheet may be the thing that failed.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 48,
          background: "#0c0f0d",
          color: "#e7e9e6",
          fontFamily: "ui-monospace, monospace",
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        <p style={{ letterSpacing: "0.2em", textTransform: "uppercase", fontSize: 10 }}>
          Remit · operator console
        </p>
        <h1 style={{ fontSize: 40, fontWeight: 400, margin: "0 0 24px" }}>
          Failed to start
        </h1>
        <p style={{ maxWidth: "60ch" }}>{error.message || "no message"}</p>
        <p style={{ maxWidth: "60ch" }}>
          No gate runs here. Receipts, the Remit and the kill switch are files and
          scripts, and all three work with this process stopped:
        </p>
        <pre style={{ opacity: 0.7 }}>
          uv run --directory packages/remit-bridge remit verify --network $REMIT_NETWORK
          {"\n"}
          pnpm --filter ops kill --network $REMIT_NETWORK
        </pre>
      </body>
    </html>
  );
}
