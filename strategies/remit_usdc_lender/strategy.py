"""
===============================================================================
Remit USDC Lender — a deliberately boring Almanak strategy
===============================================================================

Supplies idle USDC from the Safe into Aave v3 on Base, and withdraws it back when
asked to unwind. That is the whole rule.

WHY IT IS BORING
----------------
Remit is execution infrastructure. Profit is not a judging criterion and chasing
it would burn the sprint (PRD.md NG-1), so this strategy exists to *produce
intents*, not returns. Every interesting property of the system — the envelope,
the preflight, the on-chain preset, the receipt chain — is a property of what
happens to an intent after this file is done with it.

Its other job is to be a real strategy rather than a stub. It is an unmodified
`IntentStrategy` at a pinned SDK version (`almanak==2.28.0`), decorated with
Almanak's own `@almanak_strategy`, returning Almanak's own `Intent` objects. It
knows nothing about Remit, has no Remit imports, and would run unchanged against
Almanak's platform gateway. That is what makes it evidence for AL-1: the
integration is not a strategy written to suit us.

WHAT MAKES IT SAFE
------------------
Nothing in this file. It could ask for anything — a withdrawal to an attacker, a
thousand times its balance, a token nobody approved — and the answer would be the
same four refusals, because none of the authority lives here. That is the point
being demonstrated: `strategyHash` in a receipt records *which* version of this
file produced a transaction, and the Remit records what it was allowed to do
about it.

CONFIG
------
    min_supply_amount   don't bother supplying dust (default "1")
    max_supply_amount   cap any single supply (default "5", the Remit's per-tx cap)
    action              "", "supply" or "withdraw" — force one, for a demo
===============================================================================
"""

from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

from almanak.framework.intents import Intent, IntentType
from almanak.framework.market import MarketSnapshot
from almanak.framework.strategies import IntentStrategy, almanak_strategy

logger = logging.getLogger(__name__)

TOKEN = "USDC"
PROTOCOL = "aave_v3"
CHAIN = "base"


@almanak_strategy(
    name="remit_usdc_lender",
    description="Supply idle USDC into Aave v3 on Base; withdraw on request",
    version="1.0.0",
    author="Remit",
    tags=["lending", "usdc", "base", "aave"],
    supported_chains=[CHAIN],
    supported_protocols=[PROTOCOL],
    intent_types=[IntentType.SUPPLY, IntentType.WITHDRAW, IntentType.HOLD],
    default_chain=CHAIN,
    quote_asset="USD",
)
class RemitUsdcLenderStrategy(IntentStrategy):
    """Supply idle USDC to Aave v3. Withdraw when told to."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)

        self.min_supply_amount = Decimal(str(self.get_config("min_supply_amount", "1")))
        # Sized to the Remit's per-transaction cap rather than to an opinion about
        # markets. A strategy that proposes more than the operator allowed is not
        # dangerous — G1 refuses it — but it is noisy, and noise trains people to
        # ignore refusals.
        self.max_supply_amount = Decimal(str(self.get_config("max_supply_amount", "5")))
        self.action = str(self.get_config("action", "")).lower()

        # What the strategy believes it is holding. The chain is the authority; this is
        # only used to describe the position at teardown.
        self._supplied = Decimal("0")

        logger.info(
            "remit_usdc_lender: supply between %s and %s %s",
            self.min_supply_amount,
            self.max_supply_amount,
            TOKEN,
        )

    def decide(self, market: MarketSnapshot) -> Intent | None:
        """Look at the balance, propose one action."""
        if self.action == "withdraw":
            return self._withdraw(self.max_supply_amount)

        try:
            held = market.balance(TOKEN)
            balance = held.balance if hasattr(held, "balance") else Decimal(str(held))
        except (ValueError, KeyError) as error:
            # A balance we could not read is not a balance of zero, and proposing an
            # action on a number we do not have is how an agent supplies its own
            # uncertainty.
            return Intent.hold(reason=f"could not read the {TOKEN} balance: {error}")

        if balance < self.min_supply_amount:
            return Intent.hold(
                reason=f"{balance} {TOKEN} is below the {self.min_supply_amount} floor"
            )

        return self._supply(min(balance, self.max_supply_amount))

    def _supply(self, amount: Decimal) -> Intent:
        logger.info("SUPPLY %s %s -> Aave v3", amount, TOKEN)
        self._supplied += amount
        return Intent.supply(
            protocol=PROTOCOL,
            token=TOKEN,
            amount=amount,
            use_as_collateral=True,
            chain=CHAIN,
        )

    def _withdraw(self, amount: Decimal) -> Intent:
        logger.info("WITHDRAW %s %s <- Aave v3", amount, TOKEN)
        return Intent.withdraw(protocol=PROTOCOL, token=TOKEN, amount=amount, chain=CHAIN)

    # =========================================================================
    # TEARDOWN
    # =========================================================================
    #
    # Almanak requires every strategy to say how it unwinds. Ours is the simplest
    # possible answer — one supply position, closed by withdrawing it — and the
    # framework's own full-close helper resolves the live size at execution rather
    # than freezing a figure at plan time, so accrued interest comes home too.
    #
    # It matters here for a reason beyond conformance: the withdrawal recipient is
    # pinned to the Safe by the Roles preset, so even a teardown cannot be steered
    # into moving funds anywhere else.

    def supports_teardown(self) -> bool:
        return True

    def get_teardown_profile(self) -> Any:
        from almanak.framework.teardown import TeardownAssetPolicy, TeardownProfile

        return TeardownProfile(
            natural_exit_assets=[TOKEN],
            recommended_target=TOKEN,
            estimated_steps=1,
            chains_involved=[CHAIN],
            has_lending_positions=True,
            preferred_asset_policy=TeardownAssetPolicy.KEEP_OUTPUTS,
        )

    def get_open_positions(self) -> Any:
        from datetime import UTC, datetime

        from almanak.framework.teardown import (
            PositionInfo,
            PositionType,
            TeardownPositionSummary,
        )

        positions: list[Any] = []
        if self._supplied > 0:
            positions.append(
                PositionInfo(
                    position_type=PositionType.SUPPLY,
                    position_id=f"aave-v3-supply-{TOKEN}-{CHAIN}",
                    chain=CHAIN,
                    protocol=PROTOCOL,
                    # USDC is a dollar. There is no oracle in this path for a poisoned
                    # feed to steer, which is the same assumption G1 makes.
                    value_usd=self._supplied,
                    details={"asset": TOKEN, "type": "collateral"},
                )
            )

        return TeardownPositionSummary(
            deployment_id=getattr(self, "deployment_id", None) or "remit_usdc_lender",
            timestamp=datetime.now(UTC),
            positions=positions,
        )

    def generate_teardown_intents(self, mode: Any = None, market: Any = None) -> list[Any]:
        del mode, market
        return self.teardown_full_close_intents()
