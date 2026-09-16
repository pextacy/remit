"""Amounts, exactly, on both paths.

Two rules that used to hold in one place and not the other:

* a seventh decimal is refused rather than rounded away — the adapter did this and
  `remit run` did not, so one amount meant two different actions depending on which door
  it came through;
* micro-dollars become USD by integer arithmetic — both call sites divided by a million
  in floating point, and the result was printed to the person being asked to approve a
  transaction.
"""

from __future__ import annotations

import pytest

from remit_bridge import amounts
from remit_bridge.cli import _to_units
from remit_bridge.errors import ConfigError


class TestToUnits:
    @pytest.mark.parametrize(
        ("amount", "units"),
        [
            ("5", "5000000"),
            ("0.25", "250000"),
            ("0", "0"),
            ("1.000000", "1000000"),
            ("0.000001", "1"),
            ("1.0000000", "1000000"),
            ("12345.6789", "12345678900"),
        ],
    )
    def test_converts_exactly(self, amount: str, units: str) -> None:
        assert amounts.to_units(amount) == units

    def test_refuses_finer_than_usdc_can_hold(self) -> None:
        with pytest.raises(ValueError, match="finer than USDC"):
            amounts.to_units("0.0000001")

    @pytest.mark.parametrize("amount", ["abc", "1e6", "", "5,00", "-1", ".", "1.2.3"])
    def test_refuses_what_is_not_a_decimal_amount(self, amount: str) -> None:
        with pytest.raises(ValueError):
            amounts.to_units(amount)


class TestTheCliUsesTheSameRule:
    """`remit run` had its own, looser copy. One amount, one meaning."""

    def test_a_seventh_decimal_is_refused_rather_than_truncated(self) -> None:
        # It used to return "1999999" — supplying 1.999999 when 1.9999999 was typed.
        with pytest.raises(ConfigError, match="finer than USDC"):
            _to_units("1.9999999")

    def test_something_that_is_not_an_amount_is_a_refusal_not_a_traceback(self) -> None:
        # `int("abc")` came out as an uncaught ValueError, which reaches an operator as a
        # stack trace rather than as the name of the flag they typed.
        with pytest.raises(ConfigError, match="--amount"):
            _to_units("abc")

    def test_it_agrees_with_the_adapter(self) -> None:
        for amount in ["5", "0.25", "0.000001", "1.000000"]:
            assert _to_units(amount) == amounts.to_units(amount)


class TestMicrosToUsd:
    @pytest.mark.parametrize(
        ("micros", "usd"),
        [
            (5_250_000, "5.25"),
            (25_000_000, "25"),
            (0, "0"),
            (1, "0.000001"),
            (999_999, "0.999999"),
            (23_000_000, "23"),
        ],
    )
    def test_renders_exactly(self, micros: int, usd: str) -> None:
        assert amounts.micros_to_usd(micros) == usd

    def test_a_string_of_micros_is_the_same_number(self) -> None:
        # The gate answers over a process boundary, so headroom arrives as a string.
        assert amounts.micros_to_usd("5250000") == "5.25"

    def test_negative_headroom_renders_as_a_number_and_not_as_nonsense(self) -> None:
        # Headroom goes negative the moment a cap is lowered below what has been spent,
        # and that figure reaches a reviewer. `%` keeps the sign of the dividend, so the
        # naive version produced "0.0000-5".
        assert amounts.micros_to_usd(-5) == "-0.000005"
        assert amounts.micros_to_usd(-5_250_000) == "-5.25"

    def test_it_is_never_a_float(self) -> None:
        # 0.1 + 0.2 arithmetic has no business anywhere near a cap. The figure a reviewer
        # is shown used to be `int(micros) / 1_000_000`, and `.toFixed(2)` on the ops side
        # rounded it as well — so the headroom on the screen was not the headroom.
        assert amounts.micros_to_usd(1_000_001) == "1.000001"
        assert amounts.micros_to_usd(4_999_999) == "4.999999"
