"""The Almanak seam: one intent in, one typed intent out, and everything it refuses.

This is the boundary a poisoned strategy arrives at, so the tests are mostly about the
refusals. None of them touch a chain: `map_intent` is a pure mapping, which is the
property that lets it be the first thing that runs.
"""

from __future__ import annotations

import pytest

from remit_bridge.adapters.almanak import AdapterRefusalError, _units, map_intent

SAFE = "0xe7533B43310a2660bf3d50CEF792D77d32A73D64"
CHAIN = 84_532
BASE_PARAMS = {"protocol": "aave_v3", "token": "USDC", "amount": "5", "chain": "base"}


def refusal(intent_type: str, **overrides: object) -> str:
    """The code the seam reports, which is what a strategy author acts on."""
    with pytest.raises(AdapterRefusalError) as raised:
        map_intent(intent_type, {**BASE_PARAMS, **overrides}, SAFE, CHAIN)
    return raised.value.code


class TestUnits:
    @pytest.mark.parametrize(
        ("amount", "units"),
        [
            ("5", "5000000"),
            ("0.25", "250000"),
            ("0", "0"),
            ("1.000000", "1000000"),
            ("0.000001", "1"),
            ("12345.6789", "12345678900"),
        ],
    )
    def test_converts_exactly(self, amount: str, units: str) -> None:
        assert _units(amount) == units

    def test_refuses_finer_than_usdc_can_hold(self) -> None:
        # Rounding would turn "supply 0.0000001" into "supply 0" — a different action to
        # the one the strategy decided on, taken without telling it.
        with pytest.raises(ValueError, match="finer than USDC"):
            _units("0.0000001")

    def test_trailing_zeroes_below_the_sixth_place_are_not_precision(self) -> None:
        assert _units("1.0000000") == "1000000"

    def test_refuses_something_that_is_not_a_number(self) -> None:
        for amount in ["abc", "1e6", "", "5,00"]:
            with pytest.raises(ValueError):
                _units(amount)


class TestMapping:
    def test_supply_names_the_safe_as_the_recipient(self) -> None:
        intent = map_intent("SUPPLY", BASE_PARAMS, SAFE, CHAIN)
        assert intent == {
            "kind": "supply",
            "asset": "USDC",
            "amount": "5000000",
            "onBehalfOf": SAFE,
        }

    def test_withdraw_lands_back_in_the_safe(self) -> None:
        intent = map_intent("WITHDRAW", BASE_PARAMS, SAFE, CHAIN)
        assert intent["kind"] == "withdraw"
        assert intent["to"] == SAFE

    def test_the_intent_carries_no_bytes(self) -> None:
        # The thesis, asserted rather than reviewed: there is no field here that names
        # what to call or what to send.
        intent = map_intent("SUPPLY", BASE_PARAMS, SAFE, CHAIN)
        assert set(intent) == {"kind", "asset", "amount", "onBehalfOf"}
        assert not any(key in intent for key in ("data", "target", "abi", "selector"))

    def test_the_verified_usdc_address_is_accepted_as_a_token_reference(self) -> None:
        # The SDK deprecates symbols, so a strategy may name the token by address. Only
        # the address this repository verified on chain resolves.
        verified = "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f"
        intent = map_intent("SUPPLY", {**BASE_PARAMS, "token": verified}, SAFE, CHAIN)
        assert intent["asset"] == "USDC"

    def test_another_token_address_does_not(self) -> None:
        assert refusal("SUPPLY", token="0x4200000000000000000000000000000000000006") == (
            "ASSET_UNSUPPORTED"
        )

    def test_case_does_not_matter_for_a_symbol(self) -> None:
        params = {**BASE_PARAMS, "token": "usdc"}
        assert map_intent("supply", params, SAFE, CHAIN)["asset"] == "USDC"


class TestRefusals:
    def test_a_venue_the_preset_never_scoped(self) -> None:
        assert refusal("SUPPLY", protocol="compound_v3") == "PROTOCOL_UNSUPPORTED"

    def test_a_missing_protocol(self) -> None:
        with pytest.raises(AdapterRefusalError) as raised:
            map_intent("SUPPLY", {"token": "USDC", "amount": "5"}, SAFE, CHAIN)
        assert raised.value.code == "PROTOCOL_UNSUPPORTED"

    def test_an_intent_kind_this_remit_does_not_carry(self) -> None:
        for kind in ["BORROW", "SWAP", "REPAY", "TRANSFER", ""]:
            with pytest.raises(AdapterRefusalError) as raised:
                map_intent(kind, BASE_PARAMS, SAFE, CHAIN)
            assert raised.value.code == "INTENT_KIND_UNSUPPORTED"

    def test_an_asset_the_remit_does_not_allow(self) -> None:
        assert refusal("SUPPLY", token="WETH") == "ASSET_UNSUPPORTED"

    def test_a_chained_amount_is_not_guessed_at(self) -> None:
        # "whatever the previous step produced" is a number this adapter does not have.
        assert refusal("SUPPLY", amount="all") == "AMOUNT_CHAINED"

    def test_an_amount_that_is_not_an_amount(self) -> None:
        for amount in ["abc", None, "1e6", "0.0000001"]:
            assert refusal("SUPPLY", amount=amount) == "AMOUNT_INVALID"

    def test_the_refusal_says_what_was_asked_for(self) -> None:
        with pytest.raises(AdapterRefusalError) as raised:
            map_intent("SUPPLY", {**BASE_PARAMS, "protocol": "compound_v3"}, SAFE, CHAIN)
        assert "compound_v3" in raised.value.message
