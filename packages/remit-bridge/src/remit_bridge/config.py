"""Where the bridge reads its world from.

Nothing here has a default that points at mainnet, and nothing here holds a
secret: keys come from the environment, are used, and are never written to a file,
a log line or an error message (CLAUDE.md §2.4).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from remit_bridge.errors import ConfigError

REPO_ROOT = Path(__file__).resolve().parents[4]
RECEIPTS_ROOT = REPO_ROOT / "receipts"
REMITS_ROOT = REPO_ROOT / "ops" / "remits"
DEPLOYMENTS_ROOT = REPO_ROOT / "ops" / "deployments"

CHAIN_IDS: dict[str, int] = {
    "anvil": 84_532,
    # A fork of Base mainnet, where the mainnet run is rehearsed.
    "anvil-base": 8453,
    "base-sepolia": 84_532,
    "base": 8453,
}


@dataclass(frozen=True)
class Deployment:
    """The Safe and the Roles instance the Remit was issued against."""

    network: str
    chain_id: int
    safe: str
    roles_modifier: str
    role_key: str
    agent_signer: str
    #: Where to start replaying the Roles Modifier's events. Everything before the
    #: instance existed is, by definition, not about this role — and scanning from zero
    #: is how a public RPC's range cap is discovered the hard way.
    roles_deployed_block: int | None = None


@dataclass(frozen=True)
class RemitBundle:
    """A Remit and the documents its hashes commit to."""

    remit_hash: str
    remit: dict[str, Any]
    limits: dict[str, Any]
    #: Owner signatures over the digest, if the Remit carries any (RM-5). An unsigned
    #: Remit is usable — the preset is the authority either way — but signatures that do
    #: not verify are worse than none, and the startup check says so.
    signatures: list[str] = field(default_factory=list)


def _read_json(path: Path, what: str) -> dict[str, Any]:
    try:
        loaded: dict[str, Any] = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise ConfigError(f"no {what} at {path}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"{what} at {path} is not valid JSON") from error
    return loaded


def load_deployment(network: str) -> Deployment:
    raw = _read_json(DEPLOYMENTS_ROOT / f"{network}.json", "deployment")
    missing = [
        field
        for field in ("safe", "rolesModifier", "roleKey", "agentSigner")
        if not raw.get(field)
    ]
    if missing:
        raise ConfigError(f"deployment for {network} is incomplete", missing=missing)
    return Deployment(
        network=network,
        chain_id=int(raw.get("chainId", CHAIN_IDS.get(network, 0))),
        safe=str(raw["safe"]),
        roles_modifier=str(raw["rolesModifier"]),
        role_key=str(raw["roleKey"]),
        agent_signer=str(raw["agentSigner"]),
        roles_deployed_block=(
            int(raw["rolesDeployedBlock"]) if raw.get("rolesDeployedBlock") else None
        ),
    )


def load_remit(network: str) -> RemitBundle:
    raw = _read_json(REMITS_ROOT / f"{network}.json", "Remit")
    return RemitBundle(
        remit_hash=str(raw["remitHash"]),
        remit=dict(raw["remit"]),
        limits=dict(raw["limits"]),
        signatures=[str(s) for s in raw.get("signatures", [])],
    )


def receipts_dir(network: str) -> Path:
    return RECEIPTS_ROOT / network


def require_env(name: str, *, hint: str = "") -> str:
    value = os.environ.get(name, "")
    if not value:
        raise ConfigError(f"{name} is not set{f' — {hint}' if hint else ''}")
    return value
