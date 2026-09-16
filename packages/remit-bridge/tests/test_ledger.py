"""The spend ledger the bridge shares with the ops tooling.

It has to be the same file both halves read, or the daily cap counts two different
histories depending on which door an action came through — and an agent that alternates
between them has no cap at all. These tests drive the real file, in a temporary
repository root, and assert the refusal as much as the happy path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from remit_bridge import config, ledger
from remit_bridge.errors import ConfigError

ENTRY: dict[str, Any] = {"at": 1_800_000_000, "usdMicros": "5000000", "kind": "supply"}


@pytest.fixture
def deployments(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the module at a scratch directory rather than the repository's own."""
    directory = tmp_path / "deployments"
    directory.mkdir()
    monkeypatch.setattr(config, "DEPLOYMENTS_ROOT", directory)
    monkeypatch.setattr(ledger, "DEPLOYMENTS_ROOT", directory)
    return directory


class TestReading:
    @pytest.mark.usefixtures("deployments")
    def test_no_file_is_a_ledger_with_nothing_in_it(self) -> None:
        assert ledger.read_ledger("anvil") == []

    def test_a_file_that_is_not_json_is_refused(self, deployments: Path) -> None:
        # The fail-open this exists to prevent: truncate the ledger, get the whole daily
        # cap back.
        (deployments / "anvil.ledger.json").write_text('[{"at": 1,')
        with pytest.raises(ConfigError, match="refusing to treat an unreadable ledger"):
            ledger.read_ledger("anvil")

    def test_a_document_that_is_not_a_ledger_is_refused(self, deployments: Path) -> None:
        (deployments / "anvil.ledger.json").write_text('{"spent": "lots"}')
        with pytest.raises(ConfigError, match="not a ledger"):
            ledger.read_ledger("anvil")

    @pytest.mark.parametrize(
        "entry",
        [
            {"at": "yesterday", "usdMicros": "1", "kind": "supply"},
            {"at": 1, "usdMicros": 1, "kind": "supply"},
            {"at": 1, "usdMicros": "-1", "kind": "supply"},
            {"at": 1, "usdMicros": "1", "kind": "transfer"},
            {"at": 1, "usdMicros": "1"},
            "not an entry at all",
        ],
    )
    def test_an_entry_that_is_not_an_entry_is_refused(
        self, deployments: Path, entry: Any
    ) -> None:
        (deployments / "anvil.ledger.json").write_text(json.dumps([entry]))
        with pytest.raises(ConfigError):
            ledger.read_ledger("anvil")

    def test_a_true_boolean_is_not_a_timestamp(self, deployments: Path) -> None:
        # `isinstance(True, int)` is true in Python, which is how a bool becomes a date.
        (deployments / "anvil.ledger.json").write_text(
            json.dumps([{"at": True, "usdMicros": "1", "kind": "supply"}])
        )
        with pytest.raises(ConfigError):
            ledger.read_ledger("anvil")


class TestAppending:
    @pytest.mark.usefixtures("deployments")
    def test_what_is_written_is_what_comes_back(self) -> None:
        ledger.append_ledger("anvil", ENTRY)
        ledger.append_ledger("anvil", {**ENTRY, "at": ENTRY["at"] + 1})
        entries = ledger.read_ledger("anvil")
        assert len(entries) == 2
        assert entries[0] == ENTRY

    def test_it_is_the_file_the_ops_tooling_reads(self, deployments: Path) -> None:
        ledger.append_ledger("base-sepolia", ENTRY)
        assert (deployments / "base-sepolia.ledger.json").exists()

    def test_the_file_stays_valid_json(self, deployments: Path) -> None:
        ledger.append_ledger("anvil", ENTRY)
        raw = json.loads((deployments / "anvil.ledger.json").read_text())
        assert raw == [ENTRY]

    @pytest.mark.usefixtures("deployments")
    def test_an_entry_that_is_not_an_entry_is_never_written(self) -> None:
        bad = {"at": 1, "usdMicros": "oops", "kind": "supply"}
        with pytest.raises(ConfigError):
            ledger.append_ledger("anvil", bad)
        assert ledger.read_ledger("anvil") == []

    def test_appending_onto_an_unreadable_ledger_refuses(self, deployments: Path) -> None:
        # Otherwise a corrupt ledger would be silently repaired into one holding a single
        # entry, which is the same fail-open by a longer route.
        path = deployments / "anvil.ledger.json"
        path.write_text("not json")
        with pytest.raises(ConfigError):
            ledger.append_ledger("anvil", ENTRY)
        assert path.read_text() == "not json"


class TestRpcUrls:
    def test_nothing_defaults_to_mainnet(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ["ANVIL_RPC_URL", "ANVIL_BASE_RPC_URL", "BASE_SEPOLIA_RPC_URL"]:
            monkeypatch.delenv(name, raising=False)
        assert "mainnet" not in config.env_rpc_url("anvil")
        assert "sepolia" in config.env_rpc_url("base-sepolia")

    def test_mainnet_needs_an_explicit_endpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("BASE_RPC_URL", raising=False)
        with pytest.raises(ConfigError, match="BASE_RPC_URL"):
            config.env_rpc_url("base")

    def test_the_environment_wins(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANVIL_RPC_URL", "http://127.0.0.1:9999")
        assert config.env_rpc_url("anvil") == "http://127.0.0.1:9999"


class TestAnAppendThatDidNotSurvive:
    """The one write the lock protects that has no second line of defence.

    `appendReceipt` creates each file with an exclusive create, so two writers reaching
    the same sequence collide loudly. This is a read-modify-write of one array: a
    concurrent writer that read the same starting state silently drops one of the two
    entries, and a lost entry is spend the daily cap never sees again — a cap smaller than
    the operator set it, announcing nothing.

    So the append reads its own write back. Simulated here by making that read-back answer
    the way a clobbered file would, because producing a real clobber deterministically
    means removing the lock this is a backstop *for*.
    """

    @pytest.mark.usefixtures("deployments")
    def test_an_entry_that_is_not_there_afterwards_is_a_hard_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        ledger.append_ledger("anvil", ENTRY)

        real = ledger.read_ledger
        calls = {"n": 0}

        def clobbered(network: str) -> list[dict[str, Any]]:
            calls["n"] += 1
            # The first read is the append's own "what is already here". The second is
            # the read-back, and this is what a writer that overwrote us would leave.
            return real(network) if calls["n"] == 1 else real(network)[:-1]

        monkeypatch.setattr(ledger, "read_ledger", clobbered)

        with pytest.raises(ledger.LostLedgerEntryError, match="concurrent writer"):
            ledger.append_ledger("anvil", {**ENTRY, "at": ENTRY["at"] + 60})

    @pytest.mark.usefixtures("deployments")
    def test_the_happy_path_still_returns_what_it_wrote(self) -> None:
        first = ledger.append_ledger("anvil", ENTRY)
        second = ledger.append_ledger("anvil", {**ENTRY, "at": ENTRY["at"] + 60})

        assert len(first) == 1
        assert len(second) == 2
        assert ledger.read_ledger("anvil") == second
