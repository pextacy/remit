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


def _newest_source_mtime() -> float:
    """When the core's sources last changed."""
    newest = 0.0
    for path in (CORE_DIR / "src").rglob("*.ts"):
        newest = max(newest, path.stat().st_mtime)
    return newest


def _command(subcommand: str) -> list[str]:
    """How to run the core CLI.

    The built `dist/cli.js` when it is **newer than the sources**, `tsx` otherwise.

    That condition is not fussiness. A stale build is the worst kind of bug in a system
    like this: the gates keep answering, the answers look right, and they are the answers
    of code nobody is reading any more. It cost an hour here — a signature check that had
    been written, tested and wired ran green against a `dist` built before it existed.
    """
    built = CORE_DIR / "dist" / "cli.js"
    if built.exists() and built.stat().st_mtime >= _newest_source_mtime():
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


def preflight(
    *,
    rpc_url: str,
    roles_modifier: str,
    role_key: str,
    agent: str,
    target: str,
    calldata: str,
) -> dict[str, Any]:
    """G2. One `eth_call`, no gas, and a named reason when the answer is no.

    The bridge does not hold a chain client of its own. That is not squeamishness: a
    second implementation of "would the Roles Modifier allow this" is a second answer,
    and the gate an operator reads has to be the gate that ran.
    """
    answer, _code = invoke(
        "preflight",
        {
            "rpcUrl": rpc_url,
            "rolesModifier": roles_modifier,
            "roleKey": role_key,
            "agent": agent,
            "target": target,
            "calldata": calldata,
        },
    )
    return answer


def check_preset(
    *,
    rpc_url: str,
    chain_id: int,
    remit: dict[str, Any],
    limits: dict[str, Any],
    roles_modifier: str,
    agent: str,
    from_block: int | None = None,
    signatures: list[str] | None = None,
) -> dict[str, Any]:
    """RM-4 and RM-5. Does the chain still say what the Remit claims it says?"""
    payload: dict[str, Any] = {
        "rpcUrl": rpc_url,
        "chainId": chain_id,
        "remit": remit,
        "limits": limits,
        "rolesModifier": roles_modifier,
        "agent": agent,
    }
    if from_block is not None:
        payload["fromBlock"] = from_block
    if signatures:
        payload["signatures"] = signatures
    answer, _code = invoke("preset:check", payload)
    check: dict[str, Any] = answer.get("check", {"ok": False, "findings": []})
    return check


def tx_status(*, rpc_url: str, tx_hash: str) -> dict[str, Any]:
    """What the chain says about a transaction. A read, with no rules in it."""
    answer, _code = invoke("tx:status", {"rpcUrl": rpc_url, "txHash": tx_hash})
    return answer


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
