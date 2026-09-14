"""The boundary to `@remit/core`.

The envelope check, canonical JSON, the EIP-712 digest and the receipt chain are
implemented once, in TypeScript, and this module calls them. It does not
reimplement any of them.

That is a deliberate trade. A second implementation of a hash rule is a second
hash rule the first time someone fixes a bug in one of them, and the entire value
of the receipt chain rests on two parties computing the same digest from the same
bytes. A subprocess per decision is cheap next to a chain that silently forks.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

from remit_bridge.errors import CoreInvocationError, EnvelopeRefused

# packages/remit-bridge/src/remit_bridge/core.py -> repository root
REPO_ROOT = Path(__file__).resolve().parents[4]
CORE_DIR = REPO_ROOT / "packages" / "remit-core"


def _command(subcommand: str) -> list[str]:
    """How to run the core CLI.

    `tsx` during development, the built `dist/cli.js` when it exists. Both are the
    same source; the built one is what a clean clone should use once P9's setup
    step has run.
    """
    built = CORE_DIR / "dist" / "cli.js"
    if built.exists():
        return ["node", str(built), subcommand]
    return ["pnpm", "--silent", "--filter", "@remit/core", "cli", subcommand]


def invoke(subcommand: str, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
    """Run one core command. Returns its parsed answer and its exit code."""
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            _command(subcommand),
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
            timeout=float(os.environ.get("REMIT_CORE_TIMEOUT", "60")),
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CoreInvocationError(
            f"could not run remit-core {subcommand}", detail=str(error)
        ) from error

    stdout = completed.stdout.strip()
    # pnpm prints its own noise around the payload; the answer is the last JSON line.
    line = next(
        (
            candidate
            for candidate in reversed(stdout.splitlines())
            if candidate.startswith("{")
        ),
        None,
    )
    if line is None:
        raise CoreInvocationError(
            f"remit-core {subcommand} produced no JSON",
            stdout=stdout[-2000:],
            stderr=completed.stderr[-2000:],
            returncode=completed.returncode,
        )

    try:
        return json.loads(line), completed.returncode
    except json.JSONDecodeError as error:
        raise CoreInvocationError(
            f"remit-core {subcommand} answered with invalid JSON", line=line[:2000]
        ) from error


def check_envelope(
    *,
    remit: dict[str, Any],
    limits: dict[str, Any],
    chain_id: int,
    intent: dict[str, Any],
    now: int,
    ledger: list[dict[str, Any]],
) -> dict[str, Any]:
    """G1. Returns the decision, or raises `EnvelopeRefused` with the typed error."""
    answer, _code = invoke(
        "envelope",
        {
            "remit": remit,
            "limits": limits,
            "chainId": chain_id,
            "intent": intent,
            "now": now,
            "ledger": ledger,
        },
    )
    if not answer.get("ok"):
        error = answer.get("error", {})
        raise EnvelopeRefused(error)
    decision: dict[str, Any] = answer["decision"]
    return decision


def append_receipt(directory: Path, body: dict[str, Any]) -> dict[str, Any]:
    """Append to the chain. `sequence` and `prevHash` are assigned by the store."""
    answer, _code = invoke("receipt:append", {"dir": str(directory), "body": body})
    if not answer.get("ok"):
        raise CoreInvocationError("receipt could not be appended", detail=answer)
    return answer


def verify_chain(
    directory: Path,
    *,
    remit: dict[str, Any] | None = None,
    limits: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Re-derive every hash on disk. Nothing is trusted, everything is recomputed."""
    payload: dict[str, Any] = {"dir": str(directory)}
    if remit is not None and limits is not None:
        payload["remit"] = remit
        payload["limits"] = limits
    answer, _code = invoke("receipt:verify", payload)
    verification: dict[str, Any] = answer.get("verification", {})
    return verification
