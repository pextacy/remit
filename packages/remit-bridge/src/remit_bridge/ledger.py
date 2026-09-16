"""The rolling spend ledger, shared with the ops tooling.

G1 is pure and takes the ledger as an argument (PRD.md G1-1). Something has to hold it
between calls, and the answer must be the *same* something the ops scripts use, or the
daily cap counts two different histories depending on which door an action came through
— and an agent that alternates between them has no cap at all.

So this reads and writes the file `ops/src/lib/ledger-store.ts` reads and writes:
``ops/deployments/<network>.ledger.json``, a JSON array of ``{at, usdMicros, kind}``.

A missing file is an empty ledger — the genesis case. A file that exists and does not
parse is not: treating it as empty would silently restore the whole daily cap, which is
the one way this module could fail open.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from remit_bridge.config import DEPLOYMENTS_ROOT
from remit_bridge.errors import ConfigError
from remit_bridge.lock import DEFAULT_TIMEOUT_SECONDS, file_lock
from remit_bridge.log import log_event

KINDS = frozenset({"approve", "supply", "withdraw"})


class LostLedgerEntryError(ConfigError):
    """The entry went in and did not come back out.

    Only a concurrent writer can produce this: two appends that each read the same array
    and each wrote the whole thing back, so one of them is gone. Raised rather than
    swallowed because the number it affects is the daily cap.

    A ``ConfigError`` so the callers that already treat an unreadable ledger as a hard
    failure treat this the same way — it is the same fact, found one step later.
    """

    code = "LEDGER_ENTRY_LOST"


def ledger_path(network: str) -> Path:
    return DEPLOYMENTS_ROOT / f"{network}.ledger.json"


def ledger_lock_path(network: str) -> Path:
    """The file ``ops/src/lib/ledger-store.ts`` locks for the same write."""
    return DEPLOYMENTS_ROOT / f"{network}.ledger.json.lock"


def _entry(value: Any, index: int, path: Path) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{path} entry {index} is not a ledger entry")

    at = value.get("at")
    micros = value.get("usdMicros")
    kind = value.get("kind")

    if not isinstance(at, int) or isinstance(at, bool):
        raise ConfigError(f"{path} entry {index} has no integer 'at'")
    if not isinstance(micros, str) or not micros.isdigit():
        raise ConfigError(f"{path} entry {index} has no decimal 'usdMicros'")
    if kind not in KINDS:
        raise ConfigError(f"{path} entry {index} has an unknown kind {kind!r}")

    return {"at": at, "usdMicros": micros, "kind": kind}


def read_ledger(network: str) -> list[dict[str, Any]]:
    """Everything G1 has already admitted, or a refusal to guess."""
    path = ledger_path(network)
    if not path.exists():
        return []

    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise ConfigError(
            f"{path} exists but is not JSON — refusing to treat an unreadable ledger "
            "as an empty one"
        ) from error

    if not isinstance(raw, list):
        raise ConfigError(f"{path} is not a ledger: expected an array of entries")

    return [_entry(item, index, path) for index, item in enumerate(raw)]


def append_ledger(
    network: str,
    entry: dict[str, Any],
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> list[dict[str, Any]]:
    """Record what an action consumed. Called only once value has actually moved.

    Written through a temporary file in the same directory and renamed, because a
    half-written ledger is now a hard failure rather than a silent zero — which is the
    right trade, but only if a crash mid-write cannot produce one.
    """
    path = ledger_path(network)

    # Read and write are one unit. Two writers that each read the file, each add their
    # own entry and each write the whole array back lose one of the two entries — and a
    # lost entry is spend the daily cap never sees again. The lock is the same file the
    # TypeScript ledger store takes, so the two interlock rather than racing.
    with file_lock(
        ledger_lock_path(network),
        timeout_seconds=timeout_seconds,
        # Only reachable if something judged this process dead and took the lock while it
        # was inside. Whatever this append counted was counted against a history somebody
        # else may have been changing.
        on_lost=lambda holder: log_event(
            "ledger.lock.lost", network=network, holder=holder
        ),
    ):
        existing = read_ledger(network)
        entries = [*existing, _entry(entry, len(existing), path)]
        path.parent.mkdir(parents=True, exist_ok=True)

        handle, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
        try:
            with os.fdopen(handle, "w") as file:
                file.write(json.dumps(entries, indent=2) + "\n")
            Path(temporary).replace(path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise

        # Read it back, and say so if it is not there.
        #
        # The receipt chain has a second line of defence — the store creates each file
        # with an exclusive create, so two writers reaching the same sequence collide
        # loudly. This has none: it is a read-modify-write of one array, and a concurrent
        # writer that read the same starting state silently drops one of the two entries.
        # A lost entry is spend the daily cap never sees again, which is the failure that
        # makes the cap smaller than the operator set it and never announces itself.
        #
        # Cheap, and independent of whether the lock did its job — which is the point.
        written = read_ledger(network)
        if len(written) != len(entries) or written[-1]["at"] != entries[-1]["at"]:
            raise LostLedgerEntryError(
                f"{path} holds {len(written)} entries after an append that should have "
                f"left {len(entries)} — the entry was overwritten by a concurrent "
                "writer, and the spend it recorded is not counted against the daily cap. "
                "Nothing else will notice."
            )

    return entries
