import "server-only";

import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";

/**
 * Who may answer G3.
 *
 * G3 is the gate whose cost is a person's attention, and a server action is a public
 * endpoint whatever the page around it looks like: anything that can reach the console's
 * port can POST an approval, and the bridge — which is polling a directory, not a
 * session — will take it. That is the whole gate, satisfied by whoever is on the network.
 *
 * There are no accounts here by design (one operator, one machine, no database), so the
 * control is the two things that do not need one:
 *
 * 1. **The console listens on loopback.** `next dev` and `next start` are both bound to
 *    127.0.0.1 in `package.json`, so the endpoint is not on the network at all — and the
 *    decision below checks that the request really did arrive over it, from the socket's
 *    own address rather than from a header a sender chooses.
 * 2. **A shared secret, when it is.** An operator who deliberately exposes the console —
 *    a tunnel, a container, a colleague's browser — sets `REMIT_CONSOLE_TOKEN`, and every
 *    decision then has to carry it. That is the control that survives anything sitting in
 *    front of the console, because nothing header-shaped does.
 *
 * A token that is set and not presented is a refusal, never a silent no-op: a reviewer
 * who clicks approve and is ignored will click it again, and the receipt chain would show
 * a review nobody answered.
 */
export type OperatorCheck =
  | { readonly ok: true; readonly how: "token" | "loopback" }
  | { readonly ok: false; readonly reason: string };

/** Host names on which an unauthenticated console is only reachable from this machine. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Is this the address of something on this machine?
 *
 * The whole of `127.0.0.0/8` rather than `127.0.0.1` alone, plus IPv6 loopback in both
 * the forms a stack hands it over in — `::1`, and the v4-mapped `::ffff:127.0.0.1`.
 * Anything that is not recognisably one of those is not local, including the empty
 * string and anything unparseable: this answers a question whose safe default is "no".
 */
function isLoopbackAddress(value: string): boolean {
  const address = value
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (address === "") return false;
  if (address === "::1" || address === "localhost") return true;

  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  const octets = v4.split(".");
  if (octets.length !== 4) return false;
  return (
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function sameSecret(a: string, b: string): boolean {
  // Constant time, and length-safe: `timingSafeEqual` throws on a length mismatch, which
  // would itself leak the length.
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function consoleToken(): string {
  return process.env.REMIT_CONSOLE_TOKEN ?? "";
}

export async function checkOperator(presented: string): Promise<OperatorCheck> {
  const expected = consoleToken();

  if (expected !== "") {
    return sameSecret(expected, presented)
      ? { ok: true, how: "token" }
      : {
          ok: false,
          reason:
            "REMIT_CONSOLE_TOKEN is set and this decision did not carry it. Nothing was " +
            "written — G3 is a person's answer, and an unauthenticated one is not it.",
        };
  }

  // No token configured. That is only safe while the request came from this machine, and
  // the `Host` header alone cannot say so — which was the hole rather than the check.
  //
  // Every header here is written by whoever sent the request, and `Host` is the one a
  // proxy rewrites to the origin it forwards to: put anything in front of this console
  // and every request through it reads as `127.0.0.1`. A client speaking to the port can
  // also simply *type* that host.
  //
  // What cannot be typed from elsewhere is the socket. Next fills in `x-forwarded-for`
  // from the connection's own remote address when nothing upstream already set it, so on
  // a direct request it is this machine's loopback address — and on a proxied one it is
  // whatever the proxy put there, which is the client. So the rule is the address rather
  // than the presence: **every** hop named in the chain has to be local, and the `Host`
  // and `x-forwarded-host` have to be loopback too.
  //
  // What this does not defend against is a proxy configured to pass a client's own
  // `X-Forwarded-For` through untouched. Nothing header-shaped can, which is why the
  // answer to exposing this console is REMIT_CONSOLE_TOKEN and not a cleverer header.
  const requestHeaders = await headers();

  const host = requestHeaders.get("host") ?? "";
  const forwardedHost = requestHeaders.get("x-forwarded-host") ?? "";
  const forwardedFor = requestHeaders.get("x-forwarded-for") ?? "";

  // Every hop, not the first: a proxy that *appends* leaves whatever the client claimed
  // at the head of the list, so trusting the leftmost entry would trust the attacker.
  const hops = forwardedFor.split(",").filter((hop) => hop.trim() !== "");
  const remote = hops.find((hop) => !isLoopbackAddress(hop));

  if (remote !== undefined) {
    return {
      ok: false,
      reason:
        `this decision was forwarded from ${remote.trim()}, which is not this machine, ` +
        "and REMIT_CONSOLE_TOKEN is not set. Nothing was written — G3 is a person's " +
        "answer, and anything that can reach this port could otherwise give it. Set " +
        "REMIT_CONSOLE_TOKEN and every decision has to carry it.",
    };
  }

  const named = [host, forwardedHost].filter((value) => value !== "");
  const elsewhere = named.find(
    (value) => !LOOPBACK_HOSTS.has(value.replace(/:\d+$/, "")),
  );

  if (elsewhere === undefined && named.length > 0) {
    return { ok: true, how: "loopback" };
  }

  return {
    ok: false,
    reason:
      `this console was reached at "${elsewhere ?? "an unnamed host"}", not over ` +
      "loopback, and REMIT_CONSOLE_TOKEN is not set. Set it before exposing the review " +
      "queue: anything that can reach this port can otherwise approve an action.",
  };
}
