"""The KeeperHub client. The only thing in this project that submits a transaction.

There is no `eth_sendRawTransaction` anywhere in the bridge, and there is no path
that reaches a chain except through this module (PRD.md KH-1). That is not a
stylistic preference: the claim being made to a judge is that execution is
deterministic and auditable because KeeperHub does it, and a quiet fallback to a
local signer would make the claim false in exactly the case where it matters.

Everything below was written against the KeeperHub repository at commit
f8c8f18c754ccbca481774a1c3c0fdf71e282e96 — the routes, the field names, the status
vocabularies and the auth header all come from the source, and are recorded in
docs/VERIFIED.md §5. It has **not** been run against the live service, because that
needs an account nobody has yet (docs/OPEN_QUESTIONS.md OQ-1). Until it has, treat
every response model here as a reading of the source rather than an observation.

Two shapes exist, and they are not interchangeable:

* the **workflow** path — `POST /api/workflow/{id}/execute`, status read from
  `/api/workflows/executions/{id}/status`, which returns `transactionHashes` (plural)
  and terminal statuses `success | error | system_error | skipped | cancelled`.
* the **direct execution** path — `POST /api/execute/contract-call`, status read from
  `/api/execute/{id}/status`, which returns a single `transactionHash` and terminal
  statuses `completed | failed`.

The workflow path is the product path: workflows are registered in advance and the
bridge invokes them by id with typed inputs (KH-2), so the bytes that reach the
chain are fixed before the agent ever runs.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from remit_bridge.errors import ConfigError, KeeperHubError, ReceiptUnresolvable

WORKFLOW_TERMINAL_STATUSES = frozenset(
    {"success", "error", "system_error", "skipped", "cancelled"}
)
WORKFLOW_SUCCESS_STATUSES = frozenset({"success"})

DIRECT_TERMINAL_STATUSES = frozenset({"completed", "failed"})
DIRECT_SUCCESS_STATUSES = frozenset({"completed"})

#: The routes answer with a poll hint of 2s while a run is in flight.
DEFAULT_POLL_SECONDS = 2.0
DEFAULT_MAX_WAIT_SECONDS = 180.0


class ExecuteAccepted(BaseModel):
    """What `POST …/execute` and `POST /api/execute/contract-call` return.

    `transactionHash` is present only when the hash was already known at response
    time. Issue #1784 — which added it — is closed, but "sometimes present" is not
    "always present", so the hash is still resolved through the status route rather
    than read from here.
    """

    model_config = ConfigDict(extra="allow")

    execution_id: str = Field(alias="executionId")
    status: str | None = None
    transaction_hash: str | None = Field(default=None, alias="transactionHash")
    transaction_link: str | None = Field(default=None, alias="transactionLink")
    error: str | None = None


class DirectExecutionStatus(BaseModel):
    """`GET /api/execute/{executionId}/status`."""

    model_config = ConfigDict(extra="allow")

    execution_id: str = Field(alias="executionId")
    status: str
    transaction_hash: str | None = Field(default=None, alias="transactionHash")
    transaction_link: str | None = Field(default=None, alias="transactionLink")
    sponsored: bool = False
    error: str | None = None
    network: str | None = None
    retry_count: int | None = Field(default=None, alias="retryCount")


class WorkflowExecutionStatus(BaseModel):
    """`GET /api/workflows/executions/{executionId}/status`."""

    model_config = ConfigDict(extra="allow")

    status: str
    transaction_hashes: list[str] | None = Field(default=None, alias="transactionHashes")
    error_context: dict[str, Any] | None = Field(default=None, alias="errorContext")
    progress: dict[str, Any] | None = None


@dataclass(frozen=True)
class RunLog:
    """Where the evidence for a run lives (KH-5).

    Private routing, retry and gas escalation are the workflow's behaviour, not ours, so
    the evidence that they happened is KeeperHub's run log rather than anything we could
    write. The receipt records the `executionId` that log is addressed by; these are the
    two ways to open it.
    """

    execution_id: str
    status_url: str
    cli_command: str


@dataclass(frozen=True)
class Resolution:
    """What we can say about an execution once it has stopped moving."""

    execution_id: str
    status: str
    succeeded: bool
    tx_hash: str
    explorer_link: str | None
    polls: int


class KeeperHubClient:
    """A thin, typed client. No retry logic of its own on the write path.

    KeeperHub already does nonce management, gas escalation, retries and private
    routing, and re-implementing any of that here would mean two systems deciding
    when to resubmit — which is how a "reliable" execution layer double-spends.
    The only loop in this file is a read loop against the status route.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://app.keeperhub.com",
        timeout: float = 30.0,
    ) -> None:
        if not api_key:
            raise ConfigError("KEEPERHUB_API_KEY is not set")
        if not api_key.startswith("kh_"):
            # The source expects `Authorization: Bearer kh_…`. A key of another shape
            # is a copy-paste error, and failing here beats a 401 three calls later.
            raise ConfigError(
                "KEEPERHUB_API_KEY does not look like a KeeperHub key (kh_…)"
            )

        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )

    def run_log(self, execution_id: str, *, kind: str = "workflow") -> RunLog:
        """How to read what KeeperHub did with a run, without going through us."""
        path = (
            f"/api/workflows/executions/{execution_id}/status"
            if kind == "workflow"
            else f"/api/execute/{execution_id}/status"
        )
        return RunLog(
            execution_id=execution_id,
            status_url=f"{self._base_url}{path}",
            cli_command=f"kh run logs {execution_id}",
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> KeeperHubClient:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ---- writes ----------------------------------------------------------

    def execute_workflow(
        self, workflow_id: str, inputs: dict[str, Any]
    ) -> ExecuteAccepted:
        """Invoke a workflow that was registered in advance, by id (KH-2)."""
        return self._accepted(
            self._post(f"/api/workflow/{workflow_id}/execute", inputs),
            context=f"workflow {workflow_id}",
        )

    def execute_contract_call(
        self,
        *,
        chain_id: int,
        contract_address: str,
        function_name: str,
        function_args: list[Any],
        abi: str | None = None,
    ) -> ExecuteAccepted:
        """The direct execution route.

        Kept because it is the one path that can be exercised with nothing but an API
        key, which makes it the fastest way to close OQ-1. `functionArgs` is a JSON
        **string** in this API, not an array — a detail that costs an afternoon if it
        is guessed rather than read.
        """
        import json as _json

        body: dict[str, Any] = {
            "chainId": chain_id,
            "contractAddress": contract_address,
            "functionName": function_name,
            "functionArgs": _json.dumps(function_args),
        }
        if abi is not None:
            body["abi"] = abi

        return self._accepted(
            self._post("/api/execute/contract-call", body),
            context=f"{function_name} on {contract_address}",
        )

    # ---- reads -----------------------------------------------------------

    def direct_status(self, execution_id: str) -> DirectExecutionStatus:
        return DirectExecutionStatus.model_validate(
            self._get(f"/api/execute/{execution_id}/status")
        )

    def workflow_status(self, execution_id: str) -> WorkflowExecutionStatus:
        return WorkflowExecutionStatus.model_validate(
            self._get(f"/api/workflows/executions/{execution_id}/status")
        )

    def resolve_tx_hash(
        self,
        execution_id: str,
        *,
        kind: Literal["workflow", "direct"] = "workflow",
        max_wait_seconds: float = DEFAULT_MAX_WAIT_SECONDS,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
    ) -> Resolution:
        """Poll until the execution is terminal, then return *its* transaction hash.

        Correlation is strictly on the execution id: the only hash this will ever
        return is one the status route reported for the id we submitted. It never
        reads a hash from anywhere else, never matches on a block or a timestamp,
        and never picks one of several (PRD.md KH-4).

        Ambiguity raises `ReceiptUnresolvable` rather than writing an uncertain hash.
        A gap in the chain is honest; a plausible wrong hash is not, and it is the
        kind of thing an auditor finds rather than us.
        """
        deadline = time.monotonic() + max_wait_seconds
        polls = 0
        backoff = poll_seconds

        while True:
            polls += 1
            if kind == "direct":
                status = self.direct_status(execution_id)
                state = status.status
                terminal = state in DIRECT_TERMINAL_STATUSES
                succeeded = state in DIRECT_SUCCESS_STATUSES
                hashes = [status.transaction_hash] if status.transaction_hash else []
                link = status.transaction_link
            else:
                workflow = self.workflow_status(execution_id)
                state = workflow.status
                terminal = state in WORKFLOW_TERMINAL_STATUSES
                succeeded = state in WORKFLOW_SUCCESS_STATUSES
                hashes = list(workflow.transaction_hashes or [])
                link = None

            if terminal:
                return self._resolve(execution_id, state, succeeded, hashes, link, polls)

            if time.monotonic() >= deadline:
                raise ReceiptUnresolvable(
                    execution_id,
                    f"still {state} after {max_wait_seconds:.0f}s — it may yet land, so "
                    "no receipt is written rather than one that says it failed",
                )

            time.sleep(backoff)
            # Gentle backoff, capped: the routes advertise a 2s hint, and hammering a
            # rate-limited endpoint is how a poll loop turns a slow run into a failed one.
            backoff = min(backoff * 1.5, 10.0)

    @staticmethod
    def _resolve(
        execution_id: str,
        state: str,
        succeeded: bool,
        hashes: list[str],
        link: str | None,
        polls: int,
    ) -> Resolution:
        unique = sorted({h for h in hashes if h})

        if len(unique) == 1:
            return Resolution(
                execution_id=execution_id,
                status=state,
                succeeded=succeeded,
                tx_hash=unique[0],
                explorer_link=link,
                polls=polls,
            )

        if not unique:
            raise ReceiptUnresolvable(
                execution_id,
                f"execution is {state} but reported no transaction hash",
            )

        # More than one hash for one execution: a workflow whose run touched the chain
        # more than once. Which of them is *the* transaction this receipt is about is
        # not a question to answer by guessing — it is a question for the workflow
        # definition, which should have one write node.
        raise ReceiptUnresolvable(
            execution_id,
            f"execution is {state} and reported {len(unique)} transaction hashes; "
            "correlation on executionId alone cannot say which one this receipt covers",
            candidates=unique,
        )

    # ---- plumbing --------------------------------------------------------

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        try:
            response = self._client.post(path, json=body)
        except httpx.HTTPError as error:
            raise KeeperHubError(f"POST {path} failed: {error}") from error
        return self._body(response, path)

    def _get(self, path: str) -> Any:
        try:
            response = self._client.get(path)
        except httpx.HTTPError as error:
            raise KeeperHubError(f"GET {path} failed: {error}") from error
        return self._body(response, path)

    @staticmethod
    def _body(response: httpx.Response, path: str) -> Any:
        if response.status_code >= 400:
            raise KeeperHubError(
                f"{path} answered {response.status_code}",
                status=response.status_code,
                body=_safe_json(response),
            )
        return _safe_json(response)

    @staticmethod
    def _accepted(payload: Any, *, context: str) -> ExecuteAccepted:
        try:
            accepted = ExecuteAccepted.model_validate(payload)
        except Exception as error:  # noqa: BLE001 - any shape mismatch is the same failure
            raise KeeperHubError(
                f"{context}: response did not carry an executionId", body=payload
            ) from error
        return accepted


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return {"raw": response.text[:2000]}
