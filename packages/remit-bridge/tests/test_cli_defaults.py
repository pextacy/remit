"""What `remit run` points an intent at when the caller does not say.

`propose` has always chosen per kind — value lands at the Safe, an approval names the
venue — and `run` defaulted every kind to the Safe. So `remit run --kind approve` was
refused at G1 as `OUT_OF_REMIT_SPENDER`: G1 was right, and the two paths simply
disagreed about the default. These tests are about that disagreement not coming back.
"""

from __future__ import annotations

from typing import Any

import pytest

from remit_bridge import core
from remit_bridge.cli import _default_counterparty
from remit_bridge.config import Deployment

POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27"

DEPLOYMENT = Deployment(
    network="base-sepolia",
    chain_id=84_532,
    safe="0x4e67371BA5cA46BF64a2B91c7b51bB8b0bfC87d1",
    roles_modifier="0xe8777944e78B34e788f57a340Ea85F3D7c04FA68",
    role_key="0x72656d69742d6167656e74" + "0" * 42,
    agent_signer="0x1fC8Ed19F28e9f16a8F047383DDc322617503796",
)


@pytest.fixture
def asked(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """Record what the core was asked, and answer as the core does."""
    calls: list[tuple[str, dict[str, Any]]] = []

    def invoke(subcommand: str, payload: dict[str, Any]) -> tuple[dict[str, Any], int]:
        calls.append((subcommand, payload))
        return ({"action": {"target": POOL, "value": "0", "calldata": "0x"}}, 0)

    monkeypatch.setattr(core, "invoke", invoke)
    return calls


class TestDefaultCounterparty:
    def test_value_lands_at_the_safe(self, asked: list[Any]) -> None:
        for kind in ("supply", "withdraw"):
            assert _default_counterparty(kind, DEPLOYMENT) == DEPLOYMENT.safe
        assert asked == [], "neither kind needs the core to answer"

    def test_an_approval_names_the_venue(self, asked: list[Any]) -> None:
        spender = _default_counterparty("approve", DEPLOYMENT)
        assert spender == POOL
        assert spender != DEPLOYMENT.safe, (
            "approving the Safe is the bug this default exists to prevent: G1 checks a "
            "spender against the venues, not against where value may land"
        )

    def test_the_venue_comes_from_the_core(self, asked: list[Any]) -> None:
        """Not from a second copy of the address table living in the CLI."""
        _default_counterparty("approve", DEPLOYMENT)
        assert len(asked) == 1
        subcommand, payload = asked[0]
        assert subcommand == "compile"
        assert payload["chainId"] == DEPLOYMENT.chain_id
        assert payload["intent"]["kind"] == "supply"
        assert payload["intent"]["asset"] == "USDC"
        assert payload["intent"]["onBehalfOf"] == DEPLOYMENT.safe
