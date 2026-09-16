"""The two properties that only hold because both runtimes agree.

The lock is the same file `packages/remit-core/src/util/lock.ts` takes, and the
`unparseable` evidence field is the same byte sequence `canonicalJson` produces. Neither
is visible from one side alone: a lock that guards a different path looks exactly like a
lock, and a receipt whose evidence differs by a space is a receipt that diffs against
itself. So both are asserted here, against the file layout the other half computes.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from remit_bridge import config, ledger, receipts
from remit_bridge.lock import LockTimeout, file_lock
from remit_bridge.pipeline_lock import pipeline_lock_path

#: The core's own `unparseableIntent`, built. The parity test calls it rather than a
#: transcription of its answers: the point is that the two implementations agree today,
#: which a table of expected strings stops proving the moment one of them changes.
_CORE_SCHEMA = (
    config.REPO_ROOT / "packages" / "remit-core" / "dist" / "receipts" / "schema.js"
)


def test_the_lock_is_held_for_the_body_and_released_after(tmp_path: Path) -> None:
    path = tmp_path / "one.lock"
    with file_lock(path):
        assert path.exists()
    assert not path.exists()


def _take(path: Path) -> None:
    """Acquire and release. Separated so the nesting below is one `with`, not two."""
    with file_lock(path, timeout_seconds=0.05):
        pytest.fail("two holders at once")


def test_a_held_lock_refuses_rather_than_proceeding_without_it(tmp_path: Path) -> None:
    path = tmp_path / "two.lock"
    with file_lock(path), pytest.raises(LockTimeout):
        _take(path)


def test_it_is_released_even_when_the_body_raises(tmp_path: Path) -> None:
    path = tmp_path / "three.lock"
    with pytest.raises(RuntimeError), file_lock(path):
        raise RuntimeError("the body failed")
    assert not path.exists()
    with file_lock(path):
        pass


def test_a_lock_left_by_a_process_that_died_is_broken_by_age(tmp_path: Path) -> None:
    path = tmp_path / "four.lock"
    path.write_text("pid 999999 since forever\n")
    old = time.time() - 3600
    os.utime(path, (old, old))
    with file_lock(path, stale_seconds=1.0, timeout_seconds=0.5):
        pass


def test_a_displaced_holder_does_not_remove_the_new_holders_lock(
    tmp_path: Path,
) -> None:
    """One stolen lock must not become a cascade.

    A waiter that judges a holder dead removes the file and takes it. If the displaced
    holder then releases unconditionally, it deletes the *new* holder's lock on its way
    out — and a third process walks in while the second is still inside its critical
    section. So the damage compounded instead of settling.

    Release is now ownership-checked: a holder only removes the lock it wrote.
    """
    path = tmp_path / "stolen.lock"

    with file_lock(path):
        mine = path.read_text()
        # Somebody else breaks it as stale and takes it, while we are still inside.
        path.unlink()
        path.write_text("pid 4242 somebody else\n")
        assert path.read_text() != mine

    assert path.exists(), "the displaced holder deleted the new holder's lock"
    assert path.read_text() == "pid 4242 somebody else\n"


def test_two_waiters_cannot_both_break_the_same_stale_lock(tmp_path: Path) -> None:
    """The property the docstring claimed and the code did not have.

    Breaking a stale lock was ``unlink`` and nothing else, which is wrong twice: two
    waiters could both cross the staleness check and both remove what they saw, and a
    waiter's ``stat`` could be read before the previous holder released and its unlink
    land after — taking out a lock that had a live holder inside it.

    Measured before the fix, with four waiters and a fifty-millisecond body: two of them
    were inside together in seven runs out of forty. The critical section this guards is a
    whole proposal, so that is the daily cap counted twice.

    Asserted by counting occupancy rather than by reading the lock file, because a real
    critical section never looks at it.
    """
    path = tmp_path / "stale.lock"
    path.write_text("pid 999999 long gone\n")
    stale = time.time() - 600
    os.utime(path, (stale, stale))

    inside = 0
    overlapped = False
    errors: list[BaseException] = []
    guard = threading.Lock()

    def contend() -> None:
        nonlocal inside, overlapped
        try:
            with file_lock(path, timeout_seconds=5.0):
                with guard:
                    inside += 1
                    if inside > 1:
                        overlapped = True
                time.sleep(0.02)
                with guard:
                    inside -= 1
        except BaseException as error:  # noqa: BLE001 - recorded, asserted below
            errors.append(error)

    threads = [threading.Thread(target=contend) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors, errors
    assert not overlapped, "two holders were inside the critical section at once"
    assert not path.exists()


def test_the_pipeline_lock_is_the_path_the_ops_pipeline_computes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "RECEIPTS_ROOT", tmp_path / "receipts")
    # `ops/src/lib/pipeline.ts` locks `join(receiptsRoot, network, ".pipeline.lock")`.
    # If these two ever name different files, both halves hold "the lock" and neither
    # excludes the other — which is indistinguishable from no lock at all.
    assert (
        pipeline_lock_path("anvil") == tmp_path / "receipts" / "anvil" / ".pipeline.lock"
    )


def test_the_ledger_lock_sits_beside_the_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ledger, "DEPLOYMENTS_ROOT", tmp_path)
    # `ops/src/lib/ledger-store.ts` locks `${pathFor(network)}.lock`.
    assert ledger.ledger_lock_path("base") == tmp_path / "base.ledger.json.lock"


def test_an_append_takes_the_lock_and_gives_it_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config, "DEPLOYMENTS_ROOT", tmp_path)
    monkeypatch.setattr(ledger, "DEPLOYMENTS_ROOT", tmp_path)
    entry = {"at": 1_800_000_000, "usdMicros": "5000000", "kind": "supply"}

    ledger.append_ledger("scratch", entry)
    assert not ledger.ledger_lock_path("scratch").exists()
    assert ledger.read_ledger("scratch") == [entry]

    # And it is a real exclusion, not a decoration: an append while the lock is held has
    # to wait, and refuses rather than writing against a history somebody else is
    # changing.
    with file_lock(ledger.ledger_lock_path("scratch")), pytest.raises(LockTimeout):
        ledger.append_ledger("scratch", entry, timeout_seconds=0.05)
    assert ledger.read_ledger("scratch") == [entry]


def test_unparseable_evidence_is_the_bytes_canonical_json_produces() -> None:
    # `canonicalJson` sorts keys and emits no whitespace. Python's defaults put a space
    # after every comma and colon, so the same refusal recorded by the bridge and by the
    # ops path used to produce two different `raw` strings — inside a hashed receipt.
    recorded = receipts.unparseable({"b": 1, "a": {"d": 2, "c": [3, 4]}})
    assert recorded["kind"] == "unparseable"
    assert recorded["raw"] == '{"a":{"c":[3,4],"d":2},"b":1}'


def test_evidence_never_exceeds_what_the_receipt_schema_accepts() -> None:
    # The schema caps `raw` at 1024 characters, and a receipt that cannot be sealed is a
    # refusal that left no record — the one outcome RC-1 forbids.
    recorded = receipts.unparseable({"blob": "x" * 4000})
    assert len(recorded["raw"]) <= 1024
    assert recorded["raw"].endswith("...")


def test_evidence_records_what_json_cannot_carry_rather_than_failing() -> None:
    recorded = receipts.unparseable({"amount": 5.5, "when": object()})
    # A float is recorded as its own text, not as a number. That is not a stylistic
    # choice: the canonicaliser refuses floats on both sides, and `renderable()` in the
    # core stringifies them — so recording `5.5` as a JSON number here would make one
    # poisoned intent hash to two different receipts depending on which path refused it.
    assert json.loads(recorded["raw"])["amount"] == "5.5"
    assert json.loads(recorded["raw"])["when"].startswith("<object object")


def test_evidence_matches_the_core_byte_for_byte() -> None:
    """The bridge and the ops path must record one refusal as one byte sequence.

    `raw` goes into a hashed receipt. Three Python defaults break parity with the core's
    `unparseableIntent`, and every one of them is invisible in a diff of the rendered
    JSON: an escape sequence for anything outside ASCII, floats written as numbers where
    the core writes them as strings, and a different threshold for exponential
    notation (`-0.000001` is `-1e-06` to Python and `-0.000001` to JavaScript).

    Checked against the core itself rather than against a copy of its answers, so the
    day somebody changes `renderable()` this fails here instead of in a chain.
    """
    cases: list[Any] = [
        {"b": 1, "a": {"d": 2, "c": [3, 4]}},
        {"amount": 5.5, "when": "x"},
        {"note": "café ☕ — “quotes”, \\ backslash", "emoji": "🙂"},
        {"neg": -0.000001, "exp": 1e-7, "huge": 1e21, "mid": 1e20, "tiny": 0.0001},
        {"f": [1234.5, 0.1, 1e-6, 5e-324]},
        {"big": 9007199254740993},
        {"日本語": "キー"},
        {},
        [],
        "plain",
        {"nested": {"deep": {"deeper": {"a": [1, {"b": 2.5}]}}}},
    ]

    script = (
        "import { unparseableIntent } from "
        f"{json.dumps(str(_CORE_SCHEMA))};"
        "let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{"
        "process.stdout.write(JSON.stringify("
        "JSON.parse(input).map(v=>unparseableIntent(v).raw)));});"
    )
    completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(cases),
        capture_output=True,
        text=True,
        check=True,
    )

    for case, expected in zip(cases, json.loads(completed.stdout), strict=True):
        assert receipts.unparseable(case)["raw"] == expected, case


def test_evidence_stops_descending_where_the_core_stops() -> None:
    # Both sides give up at depth 8 and record "…". A structure deeper than that is
    # evidence of something, but not of anything worth recursing into — and the two have
    # to give up in the same place or the bytes diverge exactly when they are strangest.
    deep: Any = "bottom"
    for _ in range(20):
        deep = {"a": deep}
    assert "…" in receipts.unparseable(deep)["raw"]
