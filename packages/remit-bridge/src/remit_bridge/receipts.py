"""Building a receipt, whatever the outcome was.

One record per attempt (PRD.md RC-1). A refusal at G1 produces a receipt, a
refusal at G2 produces a receipt, and so does a transaction that reverted. The
hashing and the chaining are `@remit/core`'s — this module only assembles the
body, so that there is one definition of what a receipt *is* and one
implementation of what its hash *is*.
"""

from __future__ import annotations

import json
import time
from decimal import Decimal
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
    #: Nothing was proposed: the record is a reading of what the chain would have said.
    #: The adapter's dry run writes one, and so does the kill switch either side of the
    #: transition. It was missing here while both were already writing it, which is a
    #: type that documents the vocabulary wrongly rather than one that catches anything.
    "observed",
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


#: The one envelope code that means "this was not an intent at all".
#:
#: G1 reports it exactly when the intent schema refused the document, so it is also the
#: signal that the receipt must not try to record the thing as a typed intent — the
#: receipt schema would refuse it for the same reason, the append would fail, and the
#: refusal most worth recording would be the one that left no record. The decision is
#: taken from the gate's own answer rather than from a second copy of the schema here.
INTENT_MALFORMED = "INTENT_MALFORMED"


#: How deep `_renderable` will go before it gives up, matching `renderable()` in
#: `packages/remit-core/src/receipts/schema.ts`. A cycle or a pathological nesting is
#: evidence of something, but not of anything worth recursing into.
_RENDER_MAX_DEPTH = 8


def _renderable(value: Any, depth: int = 0) -> Any:
    """Coerce a value into something the canonical serialiser accepts.

    A transcription of `renderable()` in the core, and it has to be one byte for byte.
    The canonicaliser refuses floats, bigints and `undefined` inside arrays because each
    is a silently different document elsewhere — and those are exactly the shapes this
    field exists to record, so they are rendered as their own text first: `5.5` becomes
    the *string* `"5.5"`, not the number `5.5`.

    That last distinction is the one this used to get wrong. `json.dumps` writes a float
    as a bare number and the core writes it as a quoted string, so the same poisoned
    intent refused by the bridge and by the ops path produced two different byte
    sequences — in a field that is hashed into the receipt. Two records of one event that
    disagree about what was sent is the failure a receipt chain exists to make
    impossible.
    """
    if depth > _RENDER_MAX_DEPTH:
        return "…"
    if value is None:
        return None
    # Before `int`: `bool` is a subclass of it, and `True` is a boolean in both runtimes.
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        if -(2**53) < value < 2**53:
            return value
        # Outside JavaScript's safe-integer range the core stringifies — but it
        # stringifies the number it *has*, and `JSON.parse` has already rounded it to the
        # nearest double by then. Python's `json.loads` keeps the digits exactly, so
        # recording them here would put a different figure in the two chains' receipts
        # for one strategy's message. The rounding is reproduced rather than corrected:
        # this field records what was received, and what the core received is this.
        try:
            rounded = float(value)
        except OverflowError:
            return "Infinity" if value > 0 else "-Infinity"
        if rounded in (float("inf"), float("-inf")):
            return "Infinity" if value > 0 else "-Infinity"
        return str(int(rounded))
    if isinstance(value, float):
        # `Number.isSafeInteger(5.0)` is true in JavaScript, where 5.0 *is* 5.
        if value.is_integer() and -(2**53) < value < 2**53:
            return int(value)
        return _js_number(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return [_renderable(item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {str(key): _renderable(item, depth + 1) for key, item in value.items()}
    return str(value)


def _js_number(value: float) -> str:
    """A float as JavaScript's ``String(n)`` renders it.

    Both runtimes pick the shortest decimal that round-trips, so the *digits* always
    agree. Where they stop agreeing is the point at which each switches to exponential
    notation: Python does it below 1e-4, JavaScript below 1e-6. ``-0.000001`` is
    ``-1e-06`` to Python and ``-0.000001`` to JavaScript — two spellings of one number,
    and two different byte sequences in a hashed receipt.

    So the digits come from Python's shortest representation and the *formatting* is
    ECMA-262 §7.1.12.1, which is the rule JavaScript actually applies.
    """
    if value != value:  # noqa: PLR0124 - NaN is the only value unequal to itself
        return "NaN"
    if value == float("inf"):
        return "Infinity"
    if value == float("-inf"):
        return "-Infinity"

    sign, raw_digits, exponent = Decimal(repr(value)).as_tuple()
    digits = "".join(str(digit) for digit in raw_digits)

    # Trailing zeros are not part of the shortest representation; `Decimal` keeps them
    # when `repr` wrote them (`1e+21` is one digit, `100.0` is four).
    stripped = digits.rstrip("0") or "0"
    exponent = int(exponent) + (len(digits) - len(stripped))
    digits = stripped

    count = len(digits)
    # `value` is `0.<digits> × 10 ** point`.
    point = count + exponent
    minus = "-" if sign else ""

    if count <= point <= 21:
        return f"{minus}{digits}{'0' * (point - count)}"
    if 0 < point <= 21:
        return f"{minus}{digits[:point]}.{digits[point:]}"
    if -6 < point <= 0:
        return f"{minus}0.{'0' * -point}{digits}"

    mantissa = digits if count == 1 else f"{digits[0]}.{digits[1:]}"
    power = point - 1
    return f"{minus}{mantissa}e{'+' if power >= 0 else '-'}{abs(power)}"


def unparseable(value: Any) -> dict[str, Any]:
    """What was proposed, when what was proposed was not an intent.

    Serialised the way `canonicalJson` serialises: sorted keys, no whitespace, and
    non-ASCII left as the characters it is. The field is evidence rather than input, but
    it is evidence that goes into a hashed receipt — and the same refusal recorded by the
    bridge and by the ops path has to produce the same bytes, or two receipts of one
    event disagree about what was sent.

    Three things Python does by default break that, and all three are invisible until
    somebody diffs two chains: a space after every comma and colon, a ``\\u`` escape for
    every character outside ASCII, and floats written as numbers where the core writes
    them as strings.
    """
    try:
        raw = json.dumps(
            _renderable(value),
            sort_keys=True,
            separators=(",", ":"),
            # `JSON.stringify` emits the character; `json.dumps` escapes it. One poisoned
            # intent carrying a non-ASCII byte is enough to fork the two chains.
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError):
        raw = str(value)
    if len(raw) > 1024:
        # Truncated the way the receipt schema's own writer truncates, so the 1024-byte
        # cap is one rule rather than two that agree by luck.
        raw = raw[:1021] + "..."
    return {"kind": "unparseable", "raw": raw or "(empty)"}


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
    # Already recorded as unrecognisable — wrapping it again would bury what the strategy
    # actually sent inside an escaped copy of our own record of it, which is the one thing
    # this field exists to show plainly.
    if intent.get("kind") == "unparseable":
        recorded = intent
    elif str(error.get("code", "")) == INTENT_MALFORMED:
        recorded = unparseable(intent)
    else:
        recorded = intent
    return build_body(
        deployment=deployment,
        bundle=bundle,
        intent=recorded,
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
