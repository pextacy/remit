"""Typed failures.

Every rejection carries a code and the field that failed, never a bare string
(CLAUDE.md §5). Judges test failure paths, and the error message is part of the
product.
"""

from __future__ import annotations

from typing import Any


class RemitError(Exception):
    """Base for everything this package raises."""

    code: str = "REMIT_ERROR"

    def __init__(self, message: str, **context: Any) -> None:
        super().__init__(message)
        self.message = message
        self.context = context

    def as_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, **self.context}


class CoreInvocationError(RemitError):
    """The remit-core CLI could not be run, or did not answer in JSON.

    The gate and the hash rules live in TypeScript and are called across a process
    boundary. If that call fails, the honest outcome is a refusal: continuing would
    mean acting without a gate.
    """

    code = "CORE_INVOCATION_FAILED"


class EnvelopeRefused(RemitError):
    """G1 said no. Carries the typed envelope error verbatim."""

    code = "OUT_OF_REMIT"

    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(str(error.get("message", "refused at G1")), error=error)
        self.error = error
        self.code = str(error.get("code", "OUT_OF_REMIT"))


class KeeperHubError(RemitError):
    """KeeperHub answered, and the answer was not one we can act on."""

    code = "KEEPERHUB_ERROR"

    def __init__(
        self, message: str, *, status: int | None = None, body: Any = None
    ) -> None:
        super().__init__(message, status=status, body=body)
        self.status = status
        self.body = body


class ReceiptUnresolvable(RemitError):
    """The execution may have produced a transaction; we cannot prove which one.

    Raised rather than writing a hash we are not sure of (PRD.md KH-4). An audit
    trail with one uncertain entry is an audit trail nobody can cite. The execution
    id is kept so the gap can be closed by hand later.
    """

    code = "RECEIPT_UNRESOLVABLE"

    def __init__(
        self, execution_id: str, reason: str, *, candidates: list[str] | None = None
    ) -> None:
        super().__init__(reason, executionId=execution_id, candidates=candidates or [])
        self.execution_id = execution_id
        self.candidates = candidates or []


class ConfigError(RemitError):
    """Something the operator has to set is not set."""

    code = "CONFIG_MISSING"
