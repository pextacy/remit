"""The same lock the TypeScript side takes, from Python.

``packages/remit-core/src/util/lock.ts`` and this file hold the *same files* with the
same primitive — ``open(O_CREAT | O_EXCL)``, which is atomic on every filesystem this
runs on. That is the point: the ops scripts, the bridge and the console are separate
processes sharing a directory, and the rules they enforce are read-modify-write rules.

``dailyCapUsd`` is "what the ledger already holds, plus this action". It is correct
exactly once. Two processes evaluating it against the same state each see a day in which
nothing has been spent, and the operator's daily cap turns out to be per-process.

A holder touches the file while it works, and ``stale_seconds`` is measured from that
rather than from when the lock was taken. That is what lets the window be short while a
legitimate hold is long: a G3 review takes ten minutes, and a process killed mid-review
should not block the next action for ten. A lock that outlives its holder is displaced
within a minute — because a system that deadlocks until somebody notices is a system that
fails open the moment somebody deletes the file to get moving again.
"""

from __future__ import annotations

import os
import secrets
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

from remit_bridge.errors import RemitError

DEFAULT_TIMEOUT_SECONDS = 30.0
#: Six heartbeats. Short enough that a killed holder is recovered from in a minute.
DEFAULT_STALE_SECONDS = 90.0
#: How often a long hold says it is still alive.
HEARTBEAT_SECONDS = 15.0


class LockTimeout(RemitError):
    """Somebody else is mid-decision. Refusing is the only safe answer."""

    code = "LOCK_TIMEOUT"


def _holder(path: Path) -> str:
    try:
        return path.read_text().strip() or "an unnamed process"
    except OSError:
        return "a process that has since released it"


def _is_stale(path: Path, stale_seconds: float) -> bool:
    """Has the holder gone quiet for longer than it is allowed to?"""
    try:
        return (time.time() - path.stat().st_mtime) > stale_seconds
    except OSError:
        # Gone between the failed create and this check: not stale, just released.
        return False


def _heartbeat(
    path: Path, token: str, stop: threading.Event, on_lost: Callable[[str], None] | None
) -> None:
    """Say the holder is alive, until it is not — or until the lock stops being ours.

    Touching a lock that is no longer ours kept *somebody else's* hold alive, so the real
    holder's heartbeat became indistinguishable from this one and the file outlived them
    both. Losing it cannot be undone from here and interrupting work already in flight
    would be its own hazard, so this exists to make the fact loud.
    """
    while not stop.wait(HEARTBEAT_SECONDS):
        if not _still_ours(path, token):
            if on_lost is not None:
                on_lost(_holder(path))
            return
        try:
            os.utime(path)
        except OSError:
            # Gone between the check and the touch. The context manager still exits
            # cleanly; releasing a file that is not there is not an error.
            return


def _new_token() -> str:
    """What this holder writes into the lock, and the only thing that identifies it.

    A pid is not an identity: pids are reused, and two acquisitions by one process are two
    different holds. The random suffix makes the token unique per acquisition, which is
    what lets a holder ask "is this still mine?" — and lets a release refuse to remove
    somebody else's lock.

    The human prefix stays because ``on_wait`` prints it to an operator trying to find out
    who is holding things up. The format is deliberately opaque to the other runtime:
    ``packages/remit-core/src/util/lock.ts`` holds the same files and compares the same
    way — whole content against its own token — so neither has to parse the other's.
    """
    return f"pid {os.getpid()} since {time.strftime('%FT%TZ')} {secrets.token_hex(8)}"


def _token_at(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _still_ours(path: Path, token: str) -> bool:
    """Is the lock on disk the one this holder created?"""
    return _token_at(path) == token.strip()


def _try_acquire(path: Path, token: str) -> bool:
    try:
        handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    try:
        os.write(handle, f"{token}\n".encode())
    finally:
        os.close(handle)

    # Created — but a waiter breaking a stale lock could have removed it between the
    # create and here, and put its own there. Read it back rather than assume: the whole
    # point of a token is that this question has an answer.
    return _still_ours(path, token)


#: How long a *break claim* may be held before it is assumed abandoned.
#:
#: A claim is held for the microseconds it takes to re-read one file, so this is generous
#: by four orders of magnitude. It exists only so that a process killed between claiming
#: and breaking cannot stop every other waiter from ever breaking anything.
CLAIM_STALE_SECONDS = 5.0


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _break_stale(path: Path, stale_seconds: float) -> None:
    """Break a lock left behind by a process that is not coming back.

    This is the one operation that can go wrong in a way the rest of the design cannot
    recover from: removing a lock somebody is *actually holding* puts two processes inside
    the same critical section, and the critical section here is a whole proposal — G1's
    reading of the ledger, a chain transaction, and the ledger write that records it. Two
    of those at once is the daily cap counted twice.

    ``unlink`` on its own was wrong twice over, and measurably so: with a stale lock
    present and four waiters, two of them were inside together in seven runs out of forty.

    1. **Two waiters could both break the same lock.** Both crossed the staleness check,
       both removed what they saw, both created their own. So the right to break a given
       lock is claimed first, with the same atomic create the lock itself uses. Exactly
       one waiter gets it.

    2. **A waiter could break a lock that had stopped being stale.** Its ``stat`` was read
       before the previous holder released and a new one took over, and the unlink landed
       after. So the claim-holder re-reads the *identity* — token and mtime — and breaks
       only what it actually judged dead. A new holder writes a different token; a live
       one moves the mtime every heartbeat. Either change means this is not that lock.

    What remains is a lock whose token and mtime are both unchanged and whose silence is
    longer than ``stale_seconds``, which is the definition of the thing being broken.
    """
    victim = _token_at(path)
    seen_at = _mtime(path)
    if victim is None or seen_at is None:
        return

    claim = path.with_name(f"{path.name}.break")
    try:
        os.close(os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644))
    except FileExistsError:
        # Somebody else is breaking this one. Unless they died holding the claim, in
        # which case nothing could ever be broken again — so a claim ages out too.
        held_since = _mtime(claim)
        if held_since is not None and time.time() - held_since > CLAIM_STALE_SECONDS:
            claim.unlink(missing_ok=True)
        return

    try:
        if (
            _token_at(path) == victim
            and _mtime(path) == seen_at
            and time.time() - seen_at > stale_seconds
        ):
            path.unlink(missing_ok=True)
    finally:
        claim.unlink(missing_ok=True)


def _release(path: Path, token: str) -> None:
    """Release, but only what we are actually holding.

    Unconditional removal turned one stolen lock into a cascade: the displaced holder
    deleted the *new* holder's file on its way out, letting a third process walk in while
    the second was still inside its critical section.
    """
    if _still_ours(path, token):
        path.unlink(missing_ok=True)


@contextmanager
def file_lock(
    path: Path,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    stale_seconds: float = DEFAULT_STALE_SECONDS,
    on_wait: Callable[[str], None] | None = None,
    on_lost: Callable[[str], None] | None = None,
) -> Iterator[None]:
    """Hold ``path`` for the body. Released whatever the body does, including raising.

    ``on_wait`` is called once, the first time the lock is found held. Waiting is correct
    and can last as long as a person takes to answer a review — but a process that says
    nothing for ten minutes looks exactly like one that has hung, and the operator's next
    move is to kill it.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_seconds
    token = _new_token()

    announced = False
    while not _try_acquire(path, token):
        if not announced:
            announced = True
            if on_wait is not None:
                on_wait(_holder(path))
        if _is_stale(path, stale_seconds):
            # Taken from a process that is not coming back. Moved aside rather than
            # deleted: two waiters may reach this line together, and only one of them may
            # go on to hold the lock — which ``unlink`` did not deliver and ``rename``
            # does.
            _break_stale(path, stale_seconds)
            continue
        if time.monotonic() >= deadline:
            raise LockTimeout(
                f"could not take {path} after {timeout_seconds:.0f}s — it is held by "
                f"{_holder(path)}. Nothing was written: a cap counted against a history "
                "somebody else is still changing is not a cap."
            )
        time.sleep(0.025)

    stop = threading.Event()
    # Daemon: an interpreter shutting down must not wait on a heartbeat, and a lock left
    # behind by a process that is exiting anyway is exactly what the stale window is for.
    beat = threading.Thread(
        target=_heartbeat, args=(path, token, stop, on_lost), daemon=True
    )
    beat.start()

    try:
        yield
    finally:
        stop.set()
        _release(path, token)
