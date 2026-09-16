"""What a receipt is allowed to claim, and what a transaction hash may be correlated on.

Both are provenance rules rather than mechanics. A receipt that records an action nobody
proposed, or a hash that belongs to a different execution, is worse than a gap: it is a
gap an auditor has to find rather than one we admitted to.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from remit_bridge import receipts
from remit_bridge.config import Deployment, RemitBundle
from remit_bridge.errors import ConfigError, ReceiptUnresolvable
from remit_bridge.keeperhub import KeeperHubClient, Resolution

SAFE = "0xe7533B43310a2660bf3d50CEF792D77d32A73D64"
DEPLOYMENT = Deployment(
    network="anvil",
    chain_id=84_532,
    safe=SAFE,
    roles_modifier="0x1A500342644ce5BAA9485afaf84bB78d5E9d34De",
    role_key="0x" + "72656d69742d6167656e74".ljust(64, "0"),
    agent_signer="0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
)
BUNDLE = RemitBundle(
    remit_hash="0x" + "aa" * 32,
    remit={
        "strategyHash": "0x" + "11" * 32,
        "workflowHash": "0x" + "22" * 32,
        "limitsHash": "0x" + "33" * 32,
    },
    limits={},
)
INTENT = {"kind": "supply", "asset": "USDC", "amount": "5000000", "onBehalfOf": SAFE}


class TestReceiptBodies:
    def test_a_refusal_carries_no_action_because_no_call_was_built(self) -> None:
        body = receipts.refused_at_g1(
            deployment=DEPLOYMENT,
            bundle=BUNDLE,
            intent=INTENT,
            error={"code": "OUT_OF_REMIT_RECIPIENT", "message": "not permitted"},
        )
        assert body["action"] is None
        assert body["outcome"] == "rejected_g1"
        assert body["submission"]["path"] == "none"
        assert body["gates"][0]["code"] == "OUT_OF_REMIT_RECIPIENT"

    def test_a_valid_intent_is_recorded_as_itself(self) -> None:
        body = receipts.refused_at_g1(
            deployment=DEPLOYMENT,
            bundle=BUNDLE,
            intent=INTENT,
            error={"code": "REMIT_CAP_EXCEEDED_PER_TX", "message": "too large"},
        )
        assert body["intent"] == INTENT

    def test_something_that_was_not_an_intent_is_recorded_as_that(self) -> None:
        # The receipt schema would refuse to hold it as a typed intent — for the same
        # reason G1 did — and writing a plausible one instead would put an action in the
        # audit trail that no strategy ever proposed.
        malformed = {"kind": "supply", "asset": "USDC", "amount": "-5000000"}
        body = receipts.refused_at_g1(
            deployment=DEPLOYMENT,
            bundle=BUNDLE,
            intent=malformed,
            error={"code": "INTENT_MALFORMED", "message": "not a valid intent"},
        )
        assert body["intent"]["kind"] == "unparseable"
        assert "-5000000" in body["intent"]["raw"]

    def test_the_evidence_field_is_bounded(self) -> None:
        body = receipts.refused_at_g1(
            deployment=DEPLOYMENT,
            bundle=BUNDLE,
            intent={"junk": "x" * 5000},
            error={"code": "INTENT_MALFORMED", "message": "no"},
        )
        assert len(body["intent"]["raw"]) <= 1024

    def test_unparseable_never_raises_on_something_odd(self) -> None:
        assert receipts.unparseable(object())["kind"] == "unparseable"
        assert receipts.unparseable({})["raw"] == "{}"

    def test_the_five_hashes_come_from_the_remit_rather_than_the_caller(self) -> None:
        body = receipts.refused_at_g1(
            deployment=DEPLOYMENT, bundle=BUNDLE, intent=INTENT, error={"code": "X"}
        )
        assert body["remitHash"] == BUNDLE.remit_hash
        assert body["strategyHash"] == BUNDLE.remit["strategyHash"]
        assert body["roleKey"] == DEPLOYMENT.role_key

    def test_sequence_and_prevhash_are_the_stores_to_assign(self) -> None:
        # A writer that can pick its own place in the chain can rewrite history.
        body = receipts.refused_at_g1(
            deployment=DEPLOYMENT, bundle=BUNDLE, intent=INTENT, error={"code": "X"}
        )
        assert "sequence" not in body
        assert "prevHash" not in body


class TestHashCorrelation:
    """KH-4: a receipt may carry only the hash reported for *this* execution."""

    def test_one_hash_for_one_execution_resolves(self) -> None:
        resolution = KeeperHubClient._resolve(
            "exec-1", "completed", True, ["0x" + "ab" * 32], None, 1
        )
        assert isinstance(resolution, Resolution)
        assert resolution.tx_hash == "0x" + "ab" * 32
        assert resolution.succeeded is True

    def test_no_hash_is_a_gap_we_admit_to(self) -> None:
        with pytest.raises(ReceiptUnresolvable, match="reported no transaction hash"):
            KeeperHubClient._resolve("exec-2", "completed", True, [], None, 1)

    def test_two_hashes_are_never_guessed_between(self) -> None:
        with pytest.raises(ReceiptUnresolvable) as raised:
            KeeperHubClient._resolve(
                "exec-3", "success", True, ["0x" + "ab" * 32, "0x" + "cd" * 32], None, 1
            )
        assert len(raised.value.candidates) == 2
        assert raised.value.execution_id == "exec-3"

    def test_the_same_hash_reported_twice_is_one_hash(self) -> None:
        resolution = KeeperHubClient._resolve(
            "exec-4", "success", True, ["0x" + "ab" * 32, "0x" + "ab" * 32], None, 1
        )
        assert resolution.tx_hash == "0x" + "ab" * 32

    def test_a_failed_execution_keeps_its_hash_and_its_verdict(self) -> None:
        resolution = KeeperHubClient._resolve(
            "exec-5", "failed", False, ["0x" + "ef" * 32], None, 2
        )
        assert resolution.succeeded is False
        assert resolution.status == "failed"


class TestClientConstruction:
    def test_a_key_of_the_wrong_shape_fails_early(self) -> None:
        from remit_bridge.errors import ConfigError

        with pytest.raises(ConfigError, match="does not look like a KeeperHub key"):
            KeeperHubClient("sk-not-a-keeperhub-key")

    def test_no_key_at_all_is_a_refusal_to_start(self) -> None:
        from remit_bridge.errors import ConfigError

        with pytest.raises(ConfigError):
            KeeperHubClient("")

    def test_the_key_never_appears_in_the_object_repr(self) -> None:
        # A credential in a repr is a credential in a log line.
        client = KeeperHubClient("kh_secret_value_here")
        try:
            assert "kh_secret_value_here" not in repr(client)
        finally:
            client.close()


class TestWhereTheKeyIsAllowedToGo:
    """`KEEPERHUB_BASE_URL` decides where `Authorization: Bearer kh_…` is sent.

    It is an environment variable, and two ways it goes wrong announce themselves to
    nobody: `http://` puts the key in clear on the wire, and a host that is not
    KeeperHub hands the key to whoever owns that host.
    """

    def test_plain_http_to_somewhere_else_is_refused(self) -> None:
        with pytest.raises(ConfigError, match="plain http"):
            KeeperHubClient("kh_key_value_here", base_url="http://app.keeperhub.com")

    def test_plain_http_on_loopback_is_how_this_is_exercised_without_an_account(
        self,
    ) -> None:
        # A local stub is how this client is exercised without touching the service,
        # and a key that never leaves the machine is not a key that leaked.
        client = KeeperHubClient("kh_key_value_here", base_url="http://127.0.0.1:8099/")
        try:
            assert client._base_url == "http://127.0.0.1:8099"
        finally:
            client.close()

    @pytest.mark.parametrize(
        "base_url",
        ["", "   ", "app.keeperhub.com", "ftp://app.keeperhub.com", "https://"],
    )
    def test_something_that_is_not_an_https_url_is_refused(self, base_url: str) -> None:
        with pytest.raises(ConfigError):
            KeeperHubClient("kh_key_value_here", base_url=base_url)

    def test_https_anywhere_is_the_operators_call(self) -> None:
        client = KeeperHubClient("kh_key_value_here", base_url="https://staging.example")
        client.close()


class TestIdsThatBecomeUrls:
    """A workflow or execution id is interpolated into a route, with the key attached.

    A value carrying a slash or a `..` does not fail — it succeeds, at a different path.
    """

    @pytest.fixture
    def client(self) -> Iterator[KeeperHubClient]:
        made = KeeperHubClient("kh_key_value_here")
        yield made
        made.close()

    @pytest.mark.parametrize(
        "bad",
        [
            "../../api/keys",
            "abc/def",
            "",
            "with space",
            "id\nHost: elsewhere",
            "?redirect=http://elsewhere",
        ],
    )
    def test_an_id_that_could_change_the_route_is_refused(
        self, client: KeeperHubClient, bad: str
    ) -> None:
        with pytest.raises(ConfigError):
            client.execute_workflow(bad, {})
        with pytest.raises(ConfigError):
            client.run_log(bad)

    def test_the_ids_keeperhub_actually_issues_are_fine(
        self, client: KeeperHubClient
    ) -> None:
        for good in ["exec_01HXYZ", "6f1c2d3e-4b5a-6789-abcd-ef0123456789", "run.12:3"]:
            assert client.run_log(good).execution_id == good
