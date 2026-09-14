"""Structured logging: one JSON object per line (CLAUDE.md §5).

One module rather than a private helper per file, because a receipt, a gate decision and
a run-log pointer should all be greppable the same way — and because a library that
`print`s is a library that cannot be embedded.

Flushed on every line. A long-running `remit serve` whose log only appears when it exits
is a server nobody can tell is working.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def log_event(event: str, **fields: Any) -> None:
    """One event. Never a bare string, and never a value that is not JSON-serialisable."""
    sys.stdout.write(json.dumps({"event": event, **fields}, default=str) + "\n")
    sys.stdout.flush()
