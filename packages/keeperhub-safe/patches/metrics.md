# BP-6 — the counter this node should emit

`runPluginStep` already wraps the step in `withPluginMetrics`, so duration and
success/failure land in the collector without any work here. What that does *not* capture
is the thing this node exists to answer: **how often does the role refuse, and why?**

A step that returns `success: true, allowed: false` is a success to the plugin wrapper and
a refusal to an operator. Those are the runs worth a dashboard — a role that never refuses
is either perfectly configured or not being consulted, and today nothing distinguishes
them.

## The addition

In `lib/metrics/types.ts`, beside `SIGNER_MODE_TOTAL`:

```ts
  // Policy-preflight outcomes (safe/policy-check). Answers "how often does the
  // role refuse, and on what?" — a refusal is a successful step to the plugin
  // wrapper, so the generic counter cannot see it.
  SAFE_POLICY_CHECK_TOTAL: "safe.policy_check.total",
```

In `lib/metrics/instrumentation/safe.ts`, beside `recordSignerMode`:

```ts
export function recordPolicyCheck(options: {
  chainId: number;
  /** Whether the role would allow the call. */
  allowed: boolean;
  /** The structured revert kind when it would not, e.g. role-condition-violation. */
  revertKind?: string;
  /** The modifier's Status label on a condition refusal, e.g. ParameterNotAllowed. */
  status?: string;
}): void {
  const metrics = getMetricsCollector();
  metrics.incrementCounter(MetricNames.SAFE_POLICY_CHECK_TOTAL, {
    chain_id: chainLabel(options.chainId),
    outcome: options.allowed ? "allowed" : "refused",
    kind: options.revertKind ?? "none",
    status: options.status ?? "none",
  });
}
```

and one call at the end of `policy-check.ts`'s handler, on both branches.

## Why the labels are these

`status` carries the modifier's own `Status` enum label, so the dashboard question
"are we refusing on `ParameterNotAllowed` or on `AllowanceExceeded`?" is answerable — those
are a misconfigured preset and an exhausted budget, which look identical in a success rate
and need opposite responses.

`kind` separates a role refusal from an inner call that would fail anyway. Mixing them
would make an empty Safe look like a policy problem.

Cardinality stays bounded: chain ids are finite, `outcome` is two values, `kind` is the
closed `RevertKind` union, and `status` is the modifier's 20-value enum.

## Not included in the first pass

Deliberately: the node ships without this if you would rather keep the PR to one file's
worth of surface. The counter is worth having, but it touches two shared modules and the
node is useful without it.
