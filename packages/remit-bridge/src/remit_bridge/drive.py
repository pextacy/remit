"""Run the strategy, and let its intent cross Almanak's seam into Remit.

    uv run --directory packages/remit-bridge remit serve --network anvil --port 50071 &
    uv run --directory packages/remit-bridge python -m remit_bridge.drive \
        --network anvil --port 50071 --dry-run

What happens here is the integration, in the order it happens in production:

1. The strategy is constructed as Almanak constructs it — `IntentStrategy`, a config, a
   chain, a wallet address and a balance provider — and asked to `decide()`.
2. Whatever it returns is serialised with Almanak's own `Intent.serialize()`.
3. That is sent through Almanak's own `GatewayClient` to the gateway on the other side,
   which is Remit (`remit serve`).

The only thing this file adds is the balance provider and the loop. It does not touch the
intent between the strategy and the wire — if it did, the thing being demonstrated would
be our rendering of a strategy's decision rather than the decision.

Why a driver at all: Almanak's own runner brings a price oracle, state store, teardown
manager and a platform deployment id with it, and pointing all of that at a local fork is
a larger exercise than the seam it would be demonstrating. The seam is
`CompileIntent`/`Execute`, and this drives exactly that, with their client.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from decimal import Decimal
from typing import Any

from almanak.framework.gateway_client import GatewayClient, GatewayClientConfig
from almanak.framework.market import MarketSnapshot
from almanak.framework.market.models import TokenBalance
from almanak.gateway.proto import gateway_pb2

from remit_bridge import core
from remit_bridge.adapters import almanak as adapter
from remit_bridge.config import REPO_ROOT, load_deployment
from remit_bridge.errors import ConfigError

STRATEGY_PATH = REPO_ROOT / "strategies" / "remit_usdc_lender" / "strategy.py"


def load_strategy_class() -> Any:
    """Import the pinned strategy from its file, the way a runner would."""
    spec = importlib.util.spec_from_file_location("remit_usdc_lender", STRATEGY_PATH)
    if spec is None or spec.loader is None:
        raise ConfigError(f"cannot import a strategy from {STRATEGY_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["remit_usdc_lender"] = module
    spec.loader.exec_module(module)
    return module.RemitUsdcLenderStrategy


def _rogue_params(case: str) -> dict[str, Any]:
    """Intents a strategy should never send, in the shape a strategy would send them."""
    base = {
        "type": "SUPPLY",
        "protocol": "aave_v3",
        "token": "USDC",
        "amount": "1",
        "use_as_collateral": True,
        "chain": "base",
    }
    if case == "protocol":
        # A venue the Remit's preset never scoped.
        return {**base, "protocol": "compound_v3"}
    if case == "amount":
        # Well inside what the Safe holds, well outside what the operator allowed.
        return {**base, "amount": "500"}
    if case == "chained":
        # "whatever the previous step produced" — a number the adapter does not have.
        return {**base, "amount": "all"}
    # A withdrawal aimed somewhere that is not the Safe. Almanak's withdraw intent has no
    # recipient field, so this is the closest a strategy can come: asking for a token the
    # Remit does not carry, on the venue it does.
    return {**base, "type": "WITHDRAW", "token": "WETH", "amount": "1"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="remit-drive", description=__doc__)
    parser.add_argument("--network", default="anvil")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=50_051)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--action", default="", help="force 'supply' or 'withdraw'")
    parser.add_argument(
        "--rogue",
        default="",
        choices=["", "protocol", "amount", "chained", "recipient"],
        help="send a crafted intent instead of the strategy's, to show what is refused",
    )
    args = parser.parse_args(argv)

    deployment = load_deployment(args.network)
    rpc_url = adapter.env_rpc_url(args.network)

    # The balance provider a strategy reads through. It asks the core for a plain view
    # call, so the strategy sees the Safe's real balance on the real (forked) chain.
    def balance_provider(token: str) -> TokenBalance:
        if token.upper() != "USDC":
            return TokenBalance(symbol=token, balance=Decimal(0), balance_usd=Decimal(0))
        answer = core.invoke(
            "balance",
            {"rpcUrl": rpc_url, "chainId": deployment.chain_id, "owner": deployment.safe},
        )[0]
        amount = Decimal(str(answer.get("formatted", "0")))
        # USDC is treated as one dollar, the same assumption G1 makes and for the same
        # reason: six decimals means a base unit is exactly one micro-dollar, and there
        # is no oracle in the path for a poisoned feed to steer.
        return TokenBalance(symbol="USDC", balance=amount, balance_usd=amount)

    strategy_class = load_strategy_class()
    strategy = strategy_class(
        config={
            "min_supply_amount": "1",
            "max_supply_amount": "5",
            "action": args.action,
        },
        chain="base",
        wallet_address=deployment.safe,
        balance_provider=balance_provider,
    )

    market = MarketSnapshot(
        chain="base",
        wallet_address=deployment.safe,
        balance_provider=balance_provider,
    )

    if args.rogue:
        # A crafted intent, sent through the same seam by the same client. This is what a
        # compromised or poisoned strategy looks like from the gateway's side — a
        # well-formed Almanak intent asking for something nobody sanctioned — and it is
        # the material for the injection demo. Nothing here bypasses a gate; that is the
        # point of sending it through the front door.
        params = _rogue_params(args.rogue)
        kind = str(params.pop("type", "SUPPLY"))
        print(f"ROGUE      crafted {args.rogue} intent, not the strategy's decision")
    else:
        intent = strategy.decide(market)
        if intent is None:
            print(json.dumps({"event": "strategy.no_intent"}))
            return 0

        params = intent.serialize()
        kind = str(params.get("type", ""))
    print(f"strategy   {STRATEGY_PATH.relative_to(REPO_ROOT)}")
    detail = json.dumps({k: v for k, v in params.items() if k != "type"}, default=str)
    print(f"decided    {kind} {detail}")

    if kind == "HOLD":
        print("nothing to execute — the strategy is holding")
        return 0

    client = GatewayClient(
        GatewayClientConfig(host=args.host, port=args.port, timeout=60.0)
    )
    client.connect()

    try:
        # Exactly the request Almanak's runner builds: intent_data is the serialised
        # params as JSON bytes (almanak/framework/runner/_inner_runner_helpers.py:201).
        compiled = client.execution.CompileIntent(
            gateway_pb2.CompileIntentRequest(
                intent_type=kind,
                intent_data=json.dumps(params, default=str).encode(),
                chain="base",
                wallet_address=deployment.safe,
            )
        )

        if not compiled.success:
            print(f"G1 REFUSED {compiled.error_code}: {compiled.error}")
            return 2

        print("G1 PASS    compiled inside the Remit")

        executed = client.execution.Execute(
            gateway_pb2.ExecuteRequest(
                action_bundle=compiled.action_bundle,
                dry_run=args.dry_run,
                simulation_enabled=True,
                chain="base",
                wallet_address=deployment.safe,
            )
        )

        if not executed.success:
            print(f"REFUSED    {executed.error_code}: {executed.error}")
            return 3

        if args.dry_run:
            print("DRY RUN    G1 and G2 both passed; nothing was submitted")
            return 0

        for tx_hash in executed.tx_hashes:
            print(f"tx         {tx_hash}")
        print(f"execution  {executed.execution_id}")
        return 0
    finally:
        client.disconnect()


if __name__ == "__main__":
    sys.exit(main())
