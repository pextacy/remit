"""Building a receipt, whatever the outcome was.

One record per attempt (PRD.md RC-1). A refusal at G1 produces a receipt, a
refusal at G2 produces a receipt, and so does a transaction that reverted. The
hashing and the chaining are `@remit/core`'s — this module only assembles the
body, so that there is one definition of what a receipt *is* and one
implementation of what its hash *is*.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Literal

from remit_bridge import core
from remit_bridge.config import Deployment, RemitBundle

Outcome = Literal[
    "executed",
    "rejected_g1",
    "rejected_g2",
    "declined_g3",
    "reverted_g4",
    "unresolved",
]

SubmissionPath = Literal["keeperhub", "ops-direct", "none"]


def _submission(
    path: SubmissionPath,
    *,
    execution_id: str | None = None,
    workflow_id: str | None = None,
    tx_hash: str | None = None,
    explorer: str | None = None,
    gas_used: str | None = None,
) -> dict[str, Any]:
    return {
        "path": path,
        "executionId": execution_id,
        "workflowId": workflow_id,
        "txHash": tx_hash,
        "explorer": explorer,
        "gasUsed": gas_used,
    }


def build_body(
    *,
    deployment: Deployment,
    bundle: RemitBundle,
    intent: dict[str, Any],
    action: dict[str, Any] | None,
    usd: str,
    gates: list[dict[str, Any]],
    outcome: Outcome,
    submission: dict[str, Any],
    at: int | None = None,
) -> dict[str, Any]:
    """Assemble a receipt body. `sequence` and `prevHash` are the store's to assign."""
    return {
        "version": 1,
        "at": at if at is not None else int(time.time()),
        "network": deployment.network,
        "chainId": deployment.chain_id,
        "remitHash": bundle.remit_hash,
        "strategyHash": bundle.remit["strategyHash"],
        "workflowHash": bundle.remit["workflowHash"],
        "limitsHash": bundle.remit["limitsHash"],
        "roleKey": deployment.role_key,
        "safe": deployment.safe,
        "rolesModifier": deployment.roles_modifier,
        "agent": deployment.agent_signer,
        "intent": intent,
        # Named parameters, never raw calldata: the calldata is derivable from the
        # intent by anyone holding this receipt, and printing it here would invite a
        # reader to check the bytes instead of the meaning.
        "action": None
        if action is None
        else {
            "target": action["target"],
            "signature": action["signature"],
            "selector": action["selector"],
            "description": action["description"],
            "usd": usd,
        },
        "gates": gates,
        "outcome": outcome,
        "submission": submission,
    }


def refused_at_g1(
    *,
    deployment: Deployment,
    bundle: RemitBundle,
    intent: dict[str, Any],
    error: dict[str, Any],
) -> dict[str, Any]:
    """A refusal before any I/O.

    `action` is null: the intent never reached the compiler, so no call was ever
    built. Filling the field with placeholders would put a call in the audit trail
    that nobody made.
    """
    return build_body(
        deployment=deployment,
        bundle=bundle,
        intent=intent,
        action=None,
        usd="0",
        gates=[
            {
                "gate": "G1",
                "outcome": "refused",
                "code": str(error.get("code", "OUT_OF_REMIT")),
                "detail": str(error.get("message", "")),
            }
        ],
        outcome="rejected_g1",
        submission=_submission("none"),
    )


def write(network_dir: Path, body: dict[str, Any]) -> dict[str, Any]:
    """Append to the chain on disk."""
    return core.append_receipt(network_dir, body)


submission = _submission
