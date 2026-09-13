# ops

Zodiac Roles preset build/diff/apply, Safe setup, role assignment, kill switch, and the
deliberately awkward mainnet execution path.

Lands in P4 (PLAN.md 2.6-2.7). `ops` joins the pnpm workspace in the same commit.

Two rules that predate the code:

- `roles:diff` runs before `roles:apply`, always, and its output has to be readable by
  someone who did not write the preset.
- `execute-mainnet` requires `--confirm` and prints the decoded action, the Safe, the
  roleKey, the value and the recipient before it does anything. Default network is Base
  Sepolia everywhere; there is no path that defaults to mainnet.
