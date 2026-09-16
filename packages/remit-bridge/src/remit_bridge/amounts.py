"""Amounts, exactly, and in one place.

Every figure in this system is an integer: USDC base units, and micro-dollars. A float
never touches one. Six decimals means a USDC base unit *is* a micro-dollar, so the two
conversions here are the whole of the arithmetic — and both of them are the kind that is
wrong in a way nobody notices until a cap has already failed open.

It is one module rather than a helper per caller because it was two: the adapter refused
to round a strategy's amount, and the CLI silently truncated one an operator typed. Two
implementations of "what does this amount mean" is two answers, and the one that rounds
is a different action from the one that was asked for.
"""

from __future__ import annotations

#: USDC. The only asset this build moves, and the reason a base unit is a micro-dollar.
USDC_DECIMALS = 6


def to_units(amount: str) -> str:
    """Decimal string → base units, exactly. Refuses rather than rounds.

    A seventh decimal place is below USDC's resolution, and silently dropping it turns
    "supply 0.0000001" into "supply 0" — a different action to the one that was asked
    for, taken without telling anybody. An empty amount is not zero either: ``int("" or
    "0")`` would quietly make it one.
    """
    text = str(amount).strip()
    whole, separator, fraction = text.partition(".")

    if not whole and not fraction:
        raise ValueError(f"{amount!r} is not an amount")
    if not (whole or "0").isdigit() or (separator and not fraction.isdigit()):
        raise ValueError(f"{amount!r} is not a decimal amount")

    if len(fraction) > USDC_DECIMALS and fraction[USDC_DECIMALS:].strip("0"):
        raise ValueError(
            f"{amount} is finer than USDC's {USDC_DECIMALS} decimals; "
            "this will not round an amount somebody chose"
        )
    return str(
        int(whole or "0") * 10**USDC_DECIMALS
        + int((fraction or "").ljust(USDC_DECIMALS, "0")[:USDC_DECIMALS])
    )


def micros_to_usd(micros: int | str) -> str:
    """``5250000`` → ``"5.25"``. The same rule as ``microsToUsd`` in the core.

    Integer arithmetic throughout, and the sign is taken off first and put back at the
    end: Python's ``%`` on a negative would otherwise put the minus inside the fraction.
    Headroom goes negative the moment a cap is lowered below what has already been spent,
    and that figure reaches a reviewer's screen — a number that renders as nonsense there
    is worse than no number, because they either distrust every figure beside it or they
    do not notice.

    It was ``int(micros) / 1_000_000`` at both call sites: a float, in the one system
    whose stated rule is that no float ever touches an amount, printed to the person
    being asked to approve a transaction.
    """
    value = int(micros)
    negative = value < 0
    magnitude = -value if negative else value

    whole, remainder = divmod(magnitude, 10**USDC_DECIMALS)
    fraction = str(remainder).rjust(USDC_DECIMALS, "0").rstrip("0")
    rendered = str(whole) if fraction == "" else f"{whole}.{fraction}"
    return f"-{rendered}" if negative else rendered
