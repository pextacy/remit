"""Almanak's execution seam, implemented.

A strategy running on Almanak does not know or care what is on the other end of its
gateway. It compiles an intent and asks for it to be executed:

    execution.CompileIntent(CompileIntentRequest(intent_type, intent_data, chain, wallet))
    execution.Execute(ExecuteRequest(action_bundle, dry_run, simulation_enabled, …))

Read from the SDK at the pinned version (`almanak==2.28.0`,
`almanak/framework/runner/_inner_runner_helpers.py` lines 180-290): `intent_data` is
``json.dumps(intent_params).encode()`` and `action_bundle` is whatever the *server*
returned from CompileIntent, handed straight back. The server owns that shape, and here
the server is Remit.

So this is the seam, served — `ExecutionServiceServicer` from Almanak's own generated
stubs, with no fork of the SDK and no patched strategy (PRD.md AL-2). A strategy is
pointed at Remit with `ALMANAK_GATEWAY_HOST` and `ALMANAK_GATEWAY_PORT`, and everything
it proposes arrives here.

**There is no strategy logic in this file** (AL-3). It maps one Almanak intent onto one
typed Remit intent and refuses anything it does not recognise. It decides nothing about
markets, sizing or timing — that is the strategy's job, and a bridge that second-guesses
it would be a second strategy nobody reviewed.
"""

from __future__ import annotations

import json
import os
import time
from concurrent import futures
from typing import Any

import grpc
from almanak.gateway.proto import gateway_pb2, gateway_pb2_grpc

from remit_bridge import core, receipts
from remit_bridge.config import CHAIN_IDS, Deployment, RemitBundle, receipts_dir
from remit_bridge.errors import (
    ConfigError,
    EnvelopeRefused,
    ReceiptUnresolvable,
    RemitError,
)
from remit_bridge.keeperhub import KeeperHubClient
from remit_bridge.log import log_event

#: Almanak intent types this adapter knows how to carry. Anything else is refused with a
#: code the strategy author can act on, rather than translated into something adjacent.
SUPPORTED_INTENTS = {"SUPPLY", "WITHDRAW"}

#: The only venue the Remit's preset scopes. A strategy naming another protocol is not a
#: strategy this Remit authorises, and silently routing it to Aave would be the bridge
#: making a decision that belongs to the operator.
SUPPORTED_PROTOCOLS = {"aave_v3", "aave-v3", "aavev3"}

SUPPORTED_TOKENS = {"USDC"}

#: The SDK warns that symbol-based token references are deprecated and will be rejected
#: in Almanak 3.0, so a strategy may name the token by address instead. An address is
#: accepted only when it *equals the address this repository verified on chain* — the
#: comparison is against our own table, so a strategy still cannot name a token nobody
#: checked (CLAUDE.md §2.3).
VERIFIED_USDC = {
    8453: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    84_532: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f",
}


def _resolve_token(reference: str, chain_id: int) -> str:
    """A symbol, or the verified address for this chain. Nothing else."""
    text = str(reference).strip()
    if text.upper() in SUPPORTED_TOKENS:
        return text.upper()
    if text.lower() == VERIFIED_USDC.get(chain_id):
        return "USDC"
    return text


#: USDC base units. The SDK sends human amounts as decimal strings ("5", "0.25").
USDC_DECIMALS = 6


def _units(amount: str) -> str:
    """Decimal string → base units, exactly. No float ever touches an amount."""
    whole, _, fraction = str(amount).partition(".")
    return str(
        int(whole or "0") * 10**USDC_DECIMALS
        + int((fraction or "").ljust(USDC_DECIMALS, "0")[:USDC_DECIMALS])
    )


class AdapterRefusalError(RemitError):
    """The adapter will not carry this intent. Carries the code the seam reports."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def map_intent(
    intent_type: str, params: dict[str, Any], safe: str, chain_id: int
) -> dict[str, Any]:
    """One Almanak intent → one Remit intent.

    The whole mapping, and deliberately nothing else. Note what it refuses: an unknown
    intent type, an unknown protocol, an unknown token, a chained ``"all"`` amount. The
    last one matters — ``amount="all"`` means "whatever the previous step produced", which
    is a number this adapter does not know and must not guess.

    The recipient is always the Safe. Almanak's supply and withdraw intents do not name
    one; the preset pins it on chain anyway, and naming it here keeps G1 checking the same
    field the chain checks.
    """
    kind = intent_type.upper()
    if kind not in SUPPORTED_INTENTS:
        raise AdapterRefusalError(
            "INTENT_KIND_UNSUPPORTED",
            f"this Remit carries {'/'.join(sorted(SUPPORTED_INTENTS))}, not {kind}",
        )

    protocol = str(params.get("protocol", "")).lower()
    if protocol not in SUPPORTED_PROTOCOLS:
        raise AdapterRefusalError(
            "PROTOCOL_UNSUPPORTED",
            f"the preset scopes Aave v3 only; the strategy asked for '{protocol}'",
        )

    token = _resolve_token(params.get("token", ""), chain_id)
    if token not in SUPPORTED_TOKENS:
        allowed = "/".join(sorted(SUPPORTED_TOKENS))
        raise AdapterRefusalError(
            "ASSET_UNSUPPORTED",
            f"the Remit allows {allowed}, the strategy asked for '{token}'",
        )

    amount = params.get("amount")
    if amount == "all":
        raise AdapterRefusalError(
            "AMOUNT_CHAINED",
            "amount='all' takes its value from a previous step; this adapter carries one "
            "action at a time and will not guess what that was",
        )

    try:
        units = _units(str(amount))
    except (TypeError, ValueError) as error:
        raise AdapterRefusalError(
            "AMOUNT_INVALID", f"amount {amount!r} is not a number"
        ) from error

    if kind == "SUPPLY":
        return {"kind": "supply", "asset": "USDC", "amount": units, "onBehalfOf": safe}
    return {"kind": "withdraw", "asset": "USDC", "amount": units, "to": safe}


class RemitExecutionService(gateway_pb2_grpc.ExecutionServiceServicer):
    """Almanak's ExecutionService, answered by the four gates."""

    def __init__(
        self,
        *,
        deployment: Deployment,
        bundle: RemitBundle,
        rpc_url: str,
        keeperhub: KeeperHubClient | None,
        workflow_id: str | None = None,
    ) -> None:
        self._deployment = deployment
        self._bundle = bundle
        self._rpc_url = rpc_url
        self._keeperhub = keeperhub
        self._workflow_id = workflow_id
        self._receipts = receipts_dir(deployment.network)

    # ---- phase 1: compile -------------------------------------------------

    def CompileIntent(  # noqa: N802 - the name is Almanak's
        self, request: Any, context: Any
    ) -> Any:
        """Map the intent, then run G1 — before any I/O, as the gate requires."""
        del context

        try:
            params = json.loads(request.intent_data or b"{}")
        except json.JSONDecodeError:
            return gateway_pb2.CompilationResult(
                success=False,
                error="intent_data was not JSON",
                error_code="INTENT_MALFORMED",
            )

        try:
            intent = map_intent(
                request.intent_type,
                params,
                self._deployment.safe,
                self._deployment.chain_id,
            )
        except AdapterRefusalError as refusal:
            self._record_refusal(params, refusal.code, refusal.message)
            return gateway_pb2.CompilationResult(
                success=False, error=refusal.message, error_code=refusal.code
            )

        try:
            decision = core.check_envelope(
                remit=self._bundle.remit,
                limits=self._bundle.limits,
                chain_id=CHAIN_IDS[self._deployment.network],
                intent=intent,
                now=int(time.time()),
                ledger=[],
            )
        except EnvelopeRefused as refusal:
            body = receipts.refused_at_g1(
                deployment=self._deployment,
                bundle=self._bundle,
                intent=intent,
                error=refusal.error,
            )
            receipts.write(self._receipts, body)
            return gateway_pb2.CompilationResult(
                success=False,
                error=str(refusal.error.get("message", "refused at G1")),
                error_code=str(refusal.error.get("code", "OUT_OF_REMIT")),
            )

        # The bundle is ours to define: Almanak hands it straight back to Execute. It
        # carries the decision, not calldata to be trusted — Execute re-checks it.
        bundle = {
            "remitHash": self._bundle.remit_hash,
            "intent": decision["intent"],
            "action": decision["action"],
            "usd": decision["usd"],
            "requiresReview": decision["requiresReview"],
        }
        return gateway_pb2.CompilationResult(
            success=True, action_bundle=json.dumps(bundle).encode()
        )

    # ---- phase 2: execute -------------------------------------------------

    def Execute(self, request: Any, context: Any) -> Any:  # noqa: N802 - Almanak's name
        """G1 again, then G2, then KeeperHub. A receipt either way."""
        del context

        try:
            bundle = json.loads(request.action_bundle or b"{}")
        except json.JSONDecodeError:
            return gateway_pb2.ExecutionResult(
                success=False,
                error="action_bundle was not JSON",
                error_code="BUNDLE_MALFORMED",
            )

        if bundle.get("remitHash") != self._bundle.remit_hash:
            # The bundle came back over a wire. A bundle for another Remit is either a
            # stale client or something worse, and neither is a thing to execute.
            return gateway_pb2.ExecutionResult(
                success=False,
                error="action_bundle was compiled under a different Remit",
                error_code="REMIT_MISMATCH",
            )

        intent = bundle.get("intent", {})

        # G1 again. The gate is pure and cheap, and the alternative is trusting a
        # round-tripped decision — which is exactly the shape of every deserialisation bug
        # that ever became a security bug.
        try:
            decision = core.check_envelope(
                remit=self._bundle.remit,
                limits=self._bundle.limits,
                chain_id=CHAIN_IDS[self._deployment.network],
                intent=intent,
                now=int(time.time()),
                ledger=[],
            )
        except EnvelopeRefused as refusal:
            body = receipts.refused_at_g1(
                deployment=self._deployment,
                bundle=self._bundle,
                intent=intent,
                error=refusal.error,
            )
            receipts.write(self._receipts, body)
            return gateway_pb2.ExecutionResult(
                success=False,
                error=str(refusal.error.get("message")),
                error_code=str(refusal.error.get("code")),
            )

        action = decision["action"]

        # ---- G2 -----------------------------------------------------------
        check = core.preflight(
            rpc_url=self._rpc_url,
            roles_modifier=self._deployment.roles_modifier,
            role_key=self._deployment.role_key,
            agent=self._deployment.agent_signer,
            target=action["target"],
            calldata=action["calldata"],
        )

        if not check.get("ok"):
            reason = str(check.get("reason", "refused at G2"))
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {
                        "gate": "G2",
                        "outcome": "refused",
                        "code": str(check.get("code", "")),
                        "detail": reason,
                    },
                ],
                outcome="rejected_g2",
                submission=receipts.submission("none"),
            )
            return gateway_pb2.ExecutionResult(
                success=False,
                error=reason,
                error_code=str(check.get("code", "G2_REFUSED")),
            )

        # ---- dry run stops here -------------------------------------------
        if request.dry_run:
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass", "detail": "no gas spent"},
                    {"gate": "G4", "outcome": "skipped", "detail": "dry run"},
                ],
                outcome="observed",
                submission=receipts.submission("none"),
            )
            return gateway_pb2.ExecutionResult(
                success=True, execution_plan_hash=self._bundle.remit_hash
            )

        # ---- G4, through KeeperHub and nothing else -----------------------
        if self._keeperhub is None:
            return gateway_pb2.ExecutionResult(
                success=False,
                error=(
                    "no KeeperHub credentials: every transaction is submitted by "
                    "KeeperHub and there is no local-signer path"
                ),
                error_code="CONFIG_MISSING",
            )

        try:
            accepted = self._submit(action)
            resolution = self._keeperhub.resolve_tx_hash(
                accepted.execution_id, kind="workflow" if self._workflow_id else "direct"
            )
        except ReceiptUnresolvable as unresolved:
            self._write(
                intent=decision["intent"],
                action=action,
                usd=decision["usd"],
                gates=[
                    {"gate": "G1", "outcome": "pass"},
                    {"gate": "G2", "outcome": "pass"},
                    {"gate": "G4", "outcome": "reverted", "detail": unresolved.message},
                ],
                outcome="unresolved",
                submission=receipts.submission(
                    "keeperhub", execution_id=unresolved.execution_id
                ),
            )
            return gateway_pb2.ExecutionResult(
                success=False, error=unresolved.message, error_code="RECEIPT_UNRESOLVABLE"
            )
        except RemitError as error:
            return gateway_pb2.ExecutionResult(
                success=False, error=error.message, error_code=error.code
            )

        self._write(
            intent=decision["intent"],
            action=action,
            usd=decision["usd"],
            gates=[
                {"gate": "G1", "outcome": "pass"},
                {"gate": "G2", "outcome": "pass"},
                {
                    "gate": "G4",
                    "outcome": "pass" if resolution.succeeded else "reverted",
                    "detail": resolution.status,
                },
            ],
            outcome="executed" if resolution.succeeded else "reverted_g4",
            submission=receipts.submission(
                "keeperhub",
                execution_id=resolution.execution_id,
                workflow_id=self._workflow_id,
                tx_hash=resolution.tx_hash,
                explorer=resolution.explorer_link,
            ),
        )

        # KH-5's evidence is KeeperHub's run log, and the executionId is how it is
        # addressed. Logged rather than copied into the receipt: a receipt should carry
        # the key to the evidence, not a snapshot of it that can drift.
        if self._keeperhub is not None:
            log = self._keeperhub.run_log(
                resolution.execution_id,
                kind="workflow" if self._workflow_id else "direct",
            )
            log_event(
                "keeperhub.run_log",
                executionId=log.execution_id,
                status=log.status_url,
                cli=log.cli_command,
            )

        return gateway_pb2.ExecutionResult(
            success=resolution.succeeded,
            tx_hashes=[resolution.tx_hash],
            execution_id=resolution.execution_id,
            execution_plan_hash=self._bundle.remit_hash,
            submission_transactions=[
                gateway_pb2.SubmissionTransactionEvidence(
                    tx_id=resolution.tx_hash,
                    role=gateway_pb2.EXECUTION_TRANSACTION_ROLE_ACTION,
                    # AL-5, stated in Almanak's own vocabulary: never replay this.
                    #
                    # KeeperHub owns nonce management, gas escalation and retries for this
                    # submission. A replay from Almanak's side would be a *second*
                    # submission of the same intent racing KeeperHub's own resubmission —
                    # a double-spend risk dressed as a recovery. The two systems must not
                    # both be deciding when to resend.
                    replay_policy=gateway_pb2.REPLAY_POLICY_NEVER,
                )
            ],
        )

    # ---- coexisting with Almanak's own reliability machinery ---------------
    #
    # AL-5. Almanak ships a stuck detector
    # (`almanak/framework/services/stuck_detector.py`) that watches
    # `snapshot.pending_transactions` — each carrying a `tx_hash`, a **nonce**, a **gas
    # price** and a `submitted_at` — and flags `GAS_PRICE_BLOCKED` when a pending
    # transaction's gas price falls below a ratio of current, or `NONCE_CONFLICT` on a
    # duplicate or a gap in the nonce sequence.
    #
    # Every one of those signals is about a transaction the *strategy's own wallet* sent.
    # A KeeperHub submission has none of those properties from the strategy's side: the
    # wallet's nonce never advances, the gas price is KeeperHub's and is escalated by
    # KeeperHub, and a resubmission changes the hash. Presenting one as a pending
    # transaction would hand the detector three facts that are all true of something else,
    # and its remediation — replace the transaction — would race the resubmission
    # KeeperHub is already doing.
    #
    # Two properties keep them out of each other's way, and both are deliberate:
    #
    # 1. `Execute` does not return until the execution is **terminal**. `resolve_tx_hash`
    #    polls to `completed`/`failed`, so from the strategy's point of view there is
    #    never a KeeperHub-managed transaction in flight to detect as stuck. The cost is
    #    a blocking call; the alternative is two systems recovering the same transaction.
    #
    # 2. Every submission is reported with `REPLAY_POLICY_NEVER`, which is Almanak's own
    #    word for the same thing.
    #
    # What Almanak's alerting *keeps* is everything that is genuinely its business: the
    # strategy's balances, its allowances, its position state, and a failed execution —
    # `success=False` with an `error_code` — which reaches its normal failure handling
    # unchanged.

    # ---- phase 3: status --------------------------------------------------

    def GetTransactionStatus(  # noqa: N802 - Almanak's name
        self, request: Any, context: Any
    ) -> Any:
        """What the chain says about a hash. A read, with no rules in it."""
        del context
        status = core.tx_status(rpc_url=self._rpc_url, tx_hash=request.tx_hash)
        return gateway_pb2.TxStatus(
            status=str(status.get("status", "pending")),
            confirmations=int(status.get("confirmations", 0)),
            block_number=int(status.get("blockNumber", 0)),
            gas_used=int(status.get("gasUsed", 0)),
        )

    # ---- plumbing ---------------------------------------------------------

    def _submit(self, action: dict[str, Any]) -> Any:
        if self._keeperhub is None:  # pragma: no cover - guarded by the caller
            raise ConfigError("KEEPERHUB_API_KEY is not set")

        if self._workflow_id:
            return self._keeperhub.execute_workflow(
                self._workflow_id,
                {
                    "safe": self._deployment.safe,
                    "rolesModifier": self._deployment.roles_modifier,
                    "roleKey": self._deployment.role_key,
                    "target": action["target"],
                    "value": "0",
                    "data": action["calldata"],
                    "operation": 0,
                },
            )

        return self._keeperhub.execute_contract_call(
            chain_id=self._deployment.chain_id,
            contract_address=self._deployment.roles_modifier,
            function_name="execTransactionWithRole",
            function_args=[
                action["target"],
                "0",
                action["calldata"],
                0,
                self._deployment.role_key,
                True,
            ],
        )

    def _write(self, **kwargs: Any) -> None:
        body = receipts.build_body(
            deployment=self._deployment, bundle=self._bundle, **kwargs
        )
        receipts.write(self._receipts, body)

    def _record_refusal(self, params: dict[str, Any], code: str, message: str) -> None:
        """A refusal before the intent was even mappable still leaves a record.

        The intent is stored as the strategy sent it, because that is what a reviewer
        needs to see: the thing that was asked for, not our rendering of it.
        """
        body = receipts.refused_at_g1(
            deployment=self._deployment,
            bundle=self._bundle,
            intent={
                "kind": "supply",
                "asset": "USDC",
                "amount": "0",
                "onBehalfOf": self._deployment.safe,
            },
            error={
                "code": code,
                "message": f"{message} (strategy sent: {json.dumps(params)[:200]})",
            },
        )
        receipts.write(self._receipts, body)


def serve(
    *,
    deployment: Deployment,
    bundle: RemitBundle,
    rpc_url: str,
    keeperhub: KeeperHubClient | None,
    workflow_id: str | None,
    host: str = "127.0.0.1",
    port: int = 50051,
) -> grpc.Server:
    """Start the gateway a strategy talks to.

    The strategy is pointed here with `ALMANAK_GATEWAY_HOST` and `ALMANAK_GATEWAY_PORT`
    — the precedence ladder is Almanak's own (`GatewayClientConfig.from_env`), so nothing
    about the strategy changes.
    """
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    gateway_pb2_grpc.add_ExecutionServiceServicer_to_server(
        RemitExecutionService(
            deployment=deployment,
            bundle=bundle,
            rpc_url=rpc_url,
            keeperhub=keeperhub,
            workflow_id=workflow_id,
        ),
        server,
    )
    server.add_insecure_port(f"{host}:{port}")
    server.start()
    return server


def env_rpc_url(network: str) -> str:
    """The RPC the gates read the chain through."""
    if network == "anvil":
        return os.environ.get("ANVIL_RPC_URL", "http://127.0.0.1:8545")
    if network == "anvil-base":
        return os.environ.get("ANVIL_BASE_RPC_URL", "http://127.0.0.1:8547")
    if network == "base-sepolia":
        return os.environ.get("BASE_SEPOLIA_RPC_URL", "https://sepolia.base.org")
    url = os.environ.get("BASE_RPC_URL", "")
    if not url:
        raise ConfigError("BASE_RPC_URL is required on mainnet")
    return url
