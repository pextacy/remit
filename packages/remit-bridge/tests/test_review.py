"""G3 on the product path.

The queue and the console that reads it existed all along; the bridge did not use them.
It recorded ``{"gate": "G3", "outcome": "skipped"}`` and submitted anyway, so an action
over the Remit's review threshold reached KeeperHub with nobody having looked at it.

These are the properties that make it a gate rather than a note in a receipt: an item
appears where the console reads it, carries named parameters rather than calldata, and
silence resolves to a refusal instead of an approval.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from remit_bridge import review

ACTION: dict[str, Any] = {
    "target": "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    "signature": "supply(address,uint256,address,uint16)",
    "selector": "0x617ba037",
    "description": "supply 5000000 USDC to Aave, credited to the Safe",
    # The compiled bytes travel with the decision inside the process. They must not reach
    # the queue: an operator asked to approve a hex blob is being asked to rubber-stamp.
    "calldata": "0x617ba037deadbeef",
}

INTENT: dict[str, Any] = {
    "kind": "supply",
    "asset": "USDC",
    "amount": "5000000",
    "onBehalfOf": "0xe7533B43310a2660bf3d50CEF792D77d32A73D64",
}

REMIT_HASH = "0x" + "ab" * 32


def _enqueue(directory: Path, review_id: str) -> None:
    review.enqueue(
        review_id=review_id,
        network="anvil",
        remit_hash=REMIT_HASH,
        intent=INTENT,
        action=ACTION,
        usd="5",
        headroom_usd="20.00",
        reason="above the Remit's review threshold of 1 USD",
        directory=directory,
    )


def test_an_item_lands_where_the_console_reads_it(tmp_path: Path) -> None:
    review_id = review.new_id()
    _enqueue(tmp_path, review_id)
    assert (tmp_path / "pending" / f"{review_id}.json").exists()


def test_the_reviewer_is_shown_named_parameters_never_calldata(tmp_path: Path) -> None:
    review_id = review.new_id()
    _enqueue(tmp_path, review_id)
    written = json.loads((tmp_path / "pending" / f"{review_id}.json").read_text())

    assert written["action"]["signature"] == ACTION["signature"]
    assert written["action"]["usd"] == "5"
    assert "calldata" not in json.dumps(written)
    # G1 and G2 have already answered. A reviewer should not be the first to check.
    assert [gate["gate"] for gate in written["gates"]] == ["G1", "G2"]


def test_silence_is_a_refusal(tmp_path: Path) -> None:
    review_id = review.new_id()
    _enqueue(tmp_path, review_id)
    # A review that times out into an approval is not a review.
    assert (
        review.wait_for_decision(
            review_id, timeout_seconds=0.2, directory=tmp_path, poll_seconds=0.05
        )
        is None
    )


def test_an_answer_is_read_back_as_the_person_wrote_it(tmp_path: Path) -> None:
    review_id = review.new_id()
    _enqueue(tmp_path, review_id)

    decisions = tmp_path / "decisions"
    decisions.mkdir(parents=True, exist_ok=True)
    (decisions / f"{review_id}.json").write_text(
        json.dumps(
            {
                "id": review_id,
                "at": int(time.time()),
                "decision": "declined",
                "by": "operator",
                "note": "the recipient is not the Safe",
            }
        )
    )

    answer = review.wait_for_decision(
        review_id, timeout_seconds=5.0, directory=tmp_path, poll_seconds=0.05
    )
    assert answer is not None
    assert answer["decision"] == "declined"
    assert answer["by"] == "operator"


def test_a_decision_that_does_not_parse_is_not_a_decision(tmp_path: Path) -> None:
    review_id = review.new_id()
    _enqueue(tmp_path, review_id)

    decisions = tmp_path / "decisions"
    decisions.mkdir(parents=True, exist_ok=True)
    (decisions / f"{review_id}.json").write_text("{ not json")

    # Not "declined": attributing a refusal to a person who did not make one is worse
    # than waiting. The deadline then refuses on its own terms.
    assert (
        review.wait_for_decision(
            review_id, timeout_seconds=0.2, directory=tmp_path, poll_seconds=0.05
        )
        is None
    )


def test_an_id_that_is_not_an_id_cannot_become_a_path(tmp_path: Path) -> None:
    # The id names a file in both directions. A traversal here is a write anywhere the
    # bridge's user can write, so the schema both halves share refuses it.
    with pytest.raises(review.ReviewUnavailableError):
        _enqueue(tmp_path, "../../escaped")


def test_a_keeperhub_error_body_never_carries_a_key_into_a_log() -> None:
    """An error body is a third party's text, and it goes into a log line verbatim.

    Some gateways echo the request — headers included — in a 4xx, and
    ``Authorization: Bearer kh_…`` is the one string in this process that must never
    reach a log file.
    """
    from remit_bridge.keeperhub import _redact

    # Key-shaped enough for `_redact` to catch — its own pattern is
    # ``kh_[A-Za-z0-9_-]{8,}`` — and visibly not a key to anything else. A fixture that
    # reads like a live credential trips the history scan in `submit:check`, and a
    # "no secret in git history" that goes red for a fake one teaches an operator to
    # scroll past it, which is the morning a real one gets through.
    fake = "kh_NOT_A_REAL_KEY_0000000000"

    echoed = {
        "error": "unauthorized",
        "request": {"headers": {"Authorization": f"Bearer {fake}"}},
    }
    cleaned = json.dumps(_redact(echoed))
    assert fake not in cleaned
    assert "kh_[redacted]" in cleaned
    # And it leaves everything that is not key-shaped alone, so the error stays useful.
    assert "unauthorized" in cleaned
    assert _redact({"ok": True, "count": 5}) == {"ok": True, "count": 5}
