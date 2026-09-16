/**
 * G3 is a gate, not a note in a receipt.
 *
 * `runPipeline` used to record `{"gate": "G3", "outcome": "skipped"}` and go on to the
 * chain whenever no review queue was configured — so the gate the README calls
 * deliberately redundant could be removed by *omitting a flag*, and the flag was easiest
 * to forget on exactly the runs where it mattered. These assert the shape of the refusal
 * rather than the code that produces it.
 *
 * They stop before G2, which needs a chain. What is under test is the decision to stop.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  limitsSchema,
  type Receipt,
  receiptSchema,
  remitDigest,
  remitSchema,
} from "@remit/core";
import { parseUnits } from "viem";
import { resolveNetwork } from "../src/lib/networks.js";
import { runPipeline } from "../src/lib/pipeline.js";
import { buildLimits } from "../src/remit/limits.js";
import { SAFE } from "./fixtures.js";

const temporaries: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "remit-gates-"));
  temporaries.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

const network = resolveNetwork("anvil");
const limits = limitsSchema.parse(buildLimits(network.chainId, SAFE));
const now = Math.floor(Date.now() / 1000);
const remit = remitSchema.parse({
  strategyHash: `0x${"11".repeat(32)}`,
  workflowHash: `0x${"22".repeat(32)}`,
  safe: SAFE,
  rolesModifier: "0x1A500342644ce5BAA9485afaf84bB78d5E9d34De",
  roleKey: "0x72656d69742d6167656e74000000000000000000000000000000000000000000",
  limitsHash: (await import("@remit/core")).limitsHash(limits),
  chainId: network.chainId,
  notBefore: now - 3600,
  notAfter: now + 86_400,
  nonce: "1",
});

/** Above `requireReviewAboveUsd`, which the demo caps put at 1 USD. */
const overThreshold = {
  kind: "supply" as const,
  asset: "USDC" as const,
  amount: parseUnits("2", 6).toString(),
  onBehalfOf: SAFE,
};

const agent = {
  kind: "impersonated" as const,
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
};

function onlyReceipt(root: string): Receipt {
  const dir = join(root, network.name);
  const files = readdirSync(dir).sort();
  const last = files.at(-1);
  assert.ok(last !== undefined, "the pipeline wrote no receipt");
  return receiptSchema.parse(JSON.parse(readFileSync(join(dir, last), "utf8")));
}

/** Where the first test wrote, so the second can read the same receipt. */
let latestRoot = "";

describe("an action that needs a person, with nobody to ask", () => {
  test("is refused, and the receipt says why", async () => {
    const receiptsRoot = scratch();
    latestRoot = receiptsRoot;
    const result = await runPipeline({
      network,
      remit,
      remitHash: remitDigest(remit),
      limits,
      rolesModifier: remit.rolesModifier,
      agent,
      intent: overThreshold,
      receiptsRoot,
    });

    assert.equal(result.stage, "g3");
    assert.equal(result.ok, false);

    const receipt = onlyReceipt(receiptsRoot);
    assert.equal(receipt.outcome, "declined_g3");
    const g3 = receipt.gates.find((gate) => gate.gate === "G3");
    assert.equal(g3?.outcome, "declined");
    assert.equal(g3?.code, "G3_NO_REVIEWER");
    // Nothing was sent, so nothing may claim to have been.
    assert.equal(receipt.submission.path, "none");
    assert.equal(receipt.submission.txHash, null);
  });

  test("and it costs nothing: the refusal is taken before G2 is asked", () => {
    // The receipt from the case above records G2 as `skipped`, not `pass`. There is
    // nobody to ask, and there was never going to be — so the operator finds out for the
    // price of a function call rather than after an eth_call. The `proceed` escape hatch
    // and the below-threshold path both reach the chain, and are exercised on the fork in
    // CI rather than pretended at here.
    const dir = join(latestRoot, network.name);
    const receipt = receiptSchema.parse(
      JSON.parse(readFileSync(join(dir, readdirSync(dir).sort()[0] as string), "utf8")),
    );
    assert.equal(receipt.gates.find((gate) => gate.gate === "G2")?.outcome, "skipped");
  });
});
