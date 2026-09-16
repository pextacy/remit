"""Where the one-proposal-at-a-time lock lives, for every runtime that takes it.

`ops/src/lib/pipeline.ts` computes the same path. Keeping it in a module of its own is
what stops the two from drifting into locking different files and believing they are
interlocked — which is the failure mode that looks exactly like no lock at all.
"""

from __future__ import annotations

from pathlib import Path

from remit_bridge.config import receipts_dir


def pipeline_lock_path(network: str) -> Path:
    """`receipts/<network>/.pipeline.lock` — the whole gated path, per network."""
    return receipts_dir(network) / ".pipeline.lock"
