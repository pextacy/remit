"""G3, on the product path.

The queue is a directory of JSON files and the console already reads it. What was missing
was the bridge using it: the Python path recorded ``{"gate": "G3", "outcome": "skipped"}``
and submitted anyway, so the one gate whose cost is a person's attention did not exist on
the path that actually runs a strategy. An action above the Remit's review threshold went
to KeeperHub with nobody having looked at it.

It is reached through the core CLI rather than reimplemented here, for the reason every
other rule is: one schema for what a pending item is, one check on what an id may be, one
definition of what counts as a decision.

Silence is a refusal. A review that times out into an approval is not a review.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any

from remit_bridge import core
from remit_bridge.config import REPO_ROOT
from remit_bridge.errors import RemitError

#: The directory the ops pipeline writes and the console reads. One queue, not two.
REVIEW_ROOT = REPO_ROOT / "ops" / "review"

#: How long to wait for a person before treating silence as a refusal.
DEFAULT_TIMEOUT_SECONDS = 600.0

#: How often to look. The console writes a file; nothing needs a socket between the two.
POLL_SECONDS = 1.0


class ReviewUnavailableError(RemitError):
    """The queue could not be written, so nobody could have looked."""

    code = "G3_QUEUE_UNAVAILABLE"


def new_id() -> str:
    return str(uuid.uuid4())


def enqueue(
    *,
    review_id: str,
    network: str,
    remit_hash: str,
    intent: dict[str, Any],
    action: dict[str, Any],
    usd: str,
    headroom_usd: str,
    reason: str,
    directory: Path = REVIEW_ROOT,
) -> str:
    """Put one action in front of a person.

    What goes in is the decoded action in named parameters — the contract, the function,
    where value lands, how much. Never raw calldata: an operator asked to approve a hex
    blob is an operator being asked to rubber-stamp, and a gate that produces
    rubber-stamping launders the decision instead of making it.
    """
    item = {
        "id": review_id,
        "at": int(time.time()),
        "network": network,
        "remitHash": remit_hash,
        "intent": intent,
        "action": {
            "target": action["target"],
            "signature": action["signature"],
            "selector": action["selector"],
            "description": action["description"],
            "usd": usd,
        },
        "gates": [
            {"gate": "G1", "outcome": "pass", "detail": action["description"]},
            {"gate": "G2", "outcome": "pass", "detail": "preflight clean, no gas spent"},
        ],
        "headroomUsd": headroom_usd,
        "reason": reason,
    }

    answer, code = core.invoke("review:enqueue", {"dir": str(directory), "item": item})
    if not answer.get("ok") or code != 0:
        raise ReviewUnavailableError(
            f"the review queue at {directory} could not be written, so this action "
            "cannot be put in front of anybody",
            detail=answer.get("error"),
        )
    return str(answer.get("file", ""))


def wait_for_decision(
    review_id: str,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    directory: Path = REVIEW_ROOT,
    poll_seconds: float = POLL_SECONDS,
) -> dict[str, Any] | None:
    """Wait for somebody to answer, or for the deadline. ``None`` is silence.

    The *waiting* is a file existing, which Python can see for itself; the *reading* is
    the core's, because what counts as a decision — the id shape, the schema, the refusal
    to answer from a file that does not parse — is one rule and belongs in one place.

    Polling through a subprocess instead would have been the same rule and a far worse
    program: a ten-minute review is six hundred Node processes, and on a host with a
    handful of reviews in flight that is the bridge spending its life forking. The check
    below costs a `stat`.
    """
    deadline = time.monotonic() + timeout_seconds
    candidate = decision_path(directory, review_id)

    while True:
        if candidate.exists():
            answer, _code = core.invoke(
                "review:decision", {"dir": str(directory), "id": review_id}
            )
            if answer.get("decided"):
                decision: dict[str, Any] = answer.get("decision") or {}
                return decision
            # The file is there and is not a decision — half-written, or edited by hand.
            # Not an answer, and not attributed to anybody: the deadline refuses on its
            # own terms rather than this inventing a refusal somebody did not make.

        if time.monotonic() >= deadline:
            return None

        time.sleep(poll_seconds)


def decision_path(directory: Path, review_id: str) -> Path:
    """Where the console writes an answer. Read for existence only — never parsed here."""
    return directory / "decisions" / f"{review_id}.json"
