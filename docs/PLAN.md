# Remit — Execution Plan

**Window** Sunday 13 September → Friday 18 September, 12:00 CEST (hard close).
**Elapsed budget** 5.5 days.
**Judging** 18–25 September. Finalist panel inside that window, invited by email.

This plan is written to be cut, not to be completed. The cut lines are explicit. Read
§7 before you start, so you know in advance what gets dropped rather than deciding it at
02:00 on Thursday.

---

## 1. Roles

Sized for a team of three. Collapse where you have fewer people — the sequencing holds,
the calendar stretches, and P2 disappears first.

| Role | Owns |
|---|---|
| **Chain** | Safe, Zodiac Roles v2, presets, `ops/` scripts, mainnet execution, kill switch |
| **Bridge** | `remit-core`, `remit-bridge`, Almanak adapter, KeeperHub client, receipts |
| **Plugin + Console** | `keeperhub-safe` bounty PR, `remit-console`, demo video |

Solo build: drop the console to a single read-only ledger page, drop `safe.propose`, keep
everything else. The four gates are non-negotiable — they are the product.

---

## 2. The rule that governs the whole week

**A real mainnet transaction through KeeperHub is a submission requirement.** Get it on
Wednesday, not Friday. Everything else is polish on top of a proven path. A beautiful
console with no transaction hash is an unjudgeable submission.

Second rule: **open the bounty PR early and iterate in public.** A PR opened on Monday and
refined all week reads very differently to a judge than one dropped at 11:50 on Friday.

---

## 3. Day 0 — Sunday 13 September (remainder of day, ~4h)

Everything here is verification. Write no product code today. The single biggest risk to
this build is coding against a remembered API.

| # | Task | Owner | Out |
|---|---|---|---|
| 0.1 | Register on DoraHacks. Join the KeeperHub Discord, find the office-hours schedule, introduce the project in the builder channel. | any | registered |
| 0.2 | Create a KeeperHub account, generate an API key, connect the MCP server (`claude mcp add --transport http keeperhub https://app.keeperhub.com/mcp`). Create one trivial workflow by hand and execute it. | Bridge | a working `executionId` |
| 0.3 | Verify the KeeperHub API surface against the live service: execute path, executions path, response shapes. Confirm whether `txHash` is present. | Bridge | `docs/VERIFIED.md` rows |
| 0.4 | `pip install`/`uv add` the Almanak SDK at a pinned version. Read the installed source under `.venv/`. Find the execution/gateway seam a strategy uses to submit a transaction. Write down the actual interface. | Bridge | `docs/VERIFIED.md` + a go/no-go call on AL-2 |
| 0.5 | Verify on Basescan: USDC on Base, Aave v3 Pool on Base, Zodiac Roles v2 deployment for chain 8453 and 84532, Safe singleton and proxy factory. | Chain | `docs/VERIFIED.md` rows |
| 0.6 | Clone `gnosisguild/zodiac-modifier-roles` at a pinned tag. Confirm `execTransactionWithRole` signature, `ConditionFlat` layout, `ExecutionOptions` enum, and the custom error ABI for revert decoding. | Chain | pinned commit recorded |
| 0.7 | Read `KeeperHub/keeperhub` issue #1241 and #1784 in full, plus `CONTRIBUTING.md` and an existing plugin under `keeperhub/plugins/` (start with `web3`). Run `pnpm create-plugin` locally. | Plugin | plugin scaffold, conventions understood |
| 0.8 | Scaffold the monorepo per CLAUDE.md §3. `.env.example`, CI running type-check/lint/test. | any | green CI on an empty repo |

**Go/no-go at end of day:** if 0.4 shows Almanak has no usable execution seam at the
pinned version, invoke the fallback in §8 *tonight*. Do not carry that uncertainty into
Monday.

---

## 4. Day 1 — Monday 14 September

Theme: **get a transaction out of a Safe through Roles, by hand, on testnet.** No agent,
no bridge. Just prove the chain path works.

| # | Task | Owner | Done when |
|---|---|---|---|
| 1.1 | Deploy a 2-of-3 Safe on Base Sepolia. Fund with test USDC and ETH. | Chain | Safe address recorded |
| 1.2 | Deploy a Roles v2 instance, enable it as a module on the Safe, assign an agent signer EOA to `roleKey`. | Chain | `isModuleEnabled` true, membership true |
| 1.3 | Build the minimal preset from DOCS.md §5: `approve` on USDC scoped to the Aave pool, `supply`/`withdraw` on Aave with `onBehalfOf`/`to` pinned to the Safe, `ExecutionOptions.None`. | Chain | preset applied |
| 1.4 | Execute `supply` by hand via `cast` calling `execTransactionWithRole`. | Chain | **first testnet tx hash** |
| 1.5 | Execute a deliberately out-of-preset call (recipient = a random address). Capture and decode the revert. | Chain | named revert reason, not a hex blob |
| 1.6 | `remit-core`: Remit type, canonical JSON, `limitsHash`, EIP-712 domain and struct, `remitDigest`. Tests for hash reproducibility. | Bridge | `pnpm test` green |
| 1.7 | `remit-core`: `Intent` union, Zod schemas, `checkEnvelope` (G1) with typed errors. Tests **including** four rejection cases. | Bridge | G1-1…G1-4 satisfied |
| 1.8 | `keeperhub-safe`: implement `safe.read_state` and `safe.policy_check` against the real Roles Modifier deployed in 1.2. | Plugin | preflight returns a decoded reason for the 1.5 case |
| 1.9 | **Open the bounty PR against `KeeperHub/keeperhub` as a draft.** Reference #1241. Two nodes is enough to open with. | Plugin | PR URL |

**End-of-day gate:** a transaction has moved out of a Safe through Zodiac Roles on Base
Sepolia, and an out-of-preset transaction has been shown to revert with a decoded reason.
If this is not true by Monday night, cut the Almanak adapter to a stub-free minimal
integration (§7 cut line C2) and spend Tuesday on the chain path.

---

## 5. Day 2 — Tuesday 15 September

Theme: **KeeperHub becomes the only thing that sends transactions.**

| # | Task | Owner | Done when |
|---|---|---|---|
| 2.1 | `keeperhub-safe`: implement `safe.exec_with_role`. | Plugin | node submits a real Base Sepolia tx |
| 2.2 | Register the KeeperHub workflow: `read_state → policy_check → exec_with_role → notify`. Enable retries and private routing. Record `workflowHash`. | Bridge | workflow id + hash in the Remit |
| 2.3 | `remit-bridge`: KeeperHub client. `execute(workflow_id, inputs)`, `resolve_tx_hash(execution_id)` with backoff and strict `executionId` correlation, `ReceiptUnresolvable` on ambiguity. | Bridge | KH-4 satisfied |
| 2.4 | `remit-bridge`: receipts module. `selfHash`, `prevHash`, canonical JSON, `verify_chain`. Receipts written for rejections too. | Bridge | RC-1…RC-3 satisfied |
| 2.5 | Wire G1 → compile → KeeperHub → receipt. First full path with a hand-written Intent, no Almanak yet. | Bridge | **first tx through KeeperHub**, receipt written |
| 2.6 | `ops/scripts`: `roles:build`, `roles:diff`, `roles:apply`, `kill`. `roles:diff` prints the exact permission delta. | Chain | diff output readable by a non-author |
| 2.7 | Verify the kill switch: pull it, confirm G2 now fails, restore it. Capture receipts for both states. | Chain | NH-4 evidenced |
| 2.8 | `remit-console`: ledger page reading `receipts/`, with chain-integrity indicator and links to KeeperHub and Basescan. | Console | CN-2 satisfied |

**End-of-day gate:** a transaction has gone Intent → G1 → KeeperHub → Roles → Safe, and a
verifiable receipt exists for it. This is the core of the product. Everything after is
integration and presentation.

---

## 6. Day 3 — Wednesday 16 September

Theme: **Almanak on the front, mainnet on the back.**

| # | Task | Owner | Done when |
|---|---|---|---|
| 3.1 | Almanak adapter: implement the execution seam identified in 0.4. Map one strategy action to one typed Intent. Zero strategy logic in the adapter. | Bridge | AL-2, AL-3 satisfied |
| 3.2 | Pick or write a minimal Almanak strategy (a USDC supply/withdraw rule is sufficient). Pin it. Compute `strategyHash` from its source. | Bridge | AL-1, AL-4 satisfied |
| 3.3 | Run the strategy end to end against Base Sepolia through the adapter. | Bridge | **strategy-driven tx hash** |
| 3.4 | Startup assertion: bridge compares Remit limits against the on-chain preset and refuses to run on drift. Test it by tightening the preset. | Chain + Bridge | RM-4 satisfied |
| 3.5 | **Base mainnet setup**: separate Safe, separate Roles instance, preset with 5 USDC / 25 USDC caps, separate Remit. Fund with ~30 USDC. | Chain | mainnet Safe live |
| 3.6 | **Execute the mainnet proof transaction** via `ops exec --network base --confirm`. Capture the Basescan link and commit the receipt. | Chain | **mainnet tx hash secured** |
| 3.7 | `remit-console`: review queue (G3) with decoded action, G2 result, approve/decline. Decline writes a terminal receipt. | Console | G3-1…G3-3 satisfied |
| 3.8 | `keeperhub-safe`: add `safe.propose` (Safe Transaction Service path), unit tests, Base Sepolia fork test, docs page. Move the PR out of draft. | Plugin | BP-1…BP-5 satisfied, PR ready for review |

**End-of-day gate:** the mainnet transaction hash exists and is committed. From this point
the submission is viable even if everything on Thursday fails.

---

## 7. Day 4 — Thursday 17 September

Theme: **make the failures beautiful, then record.** This is the day that wins the ranking,
because every other team will have a happy path and almost none will have this.

| # | Task | Owner | Done when |
|---|---|---|---|
| 4.1 | Implement and test each non-happy-path requirement NH-1…NH-7. Every one gets a committed receipt. | all | seven receipts in `receipts/` |
| 4.2 | Build the injection scenario: a strategy input crafted to redirect funds to an attacker address. Show G1 rejecting it, then bypass G1 and show G2 rejecting it, then bypass G2 and show G4 reverting on chain. Three receipts, one story. | Bridge + Chain | the demo's centrepiece works twice in a row |
| 4.3 | Concurrency test: fire three intents at once, show all three land in order. Evidence of KeeperHub nonce management. | Bridge | NH-7 evidenced |
| 4.4 | `remit-console`: gate counters, Remit screen with headroom and expiry, kill switch screen with live membership status. | Console | CN-3…CN-5 satisfied |
| 4.5 | `verifyReceiptChain` run from a clean clone by whoever did not write it. | any | third-party verification passes |
| 4.6 | Write `README.md`: one-paragraph pitch, architecture diagram, four-command setup, the mainnet and testnet transaction links, the bounty PR link. | all | a stranger can run it |
| 4.7 | **Record the demo video** (§9). Record it today, not Friday. | Console | video uploaded |
| 4.8 | Draft the DoraHacks submission using PRD.md §8. Fill the candid "what still breaks" answer honestly — the brief says it has never hurt a submission. | all | draft saved |

**Hard rule for Thursday:** no new features after 18:00. Only tests, documentation,
recording and rehearsal.

---

## 8. Day 5 — Friday 18 September, until 12:00 CEST

Buffer and submission. Assume something breaks.

| Time | Task |
|---|---|
| 07:00–08:30 | Final run of the full path on Base Sepolia. Confirm the mainnet link resolves. Re-run `verifyReceiptChain`. |
| 08:30–09:30 | Tag the repository. Ensure `receipts/` is committed, `.env` is not, no secrets in history (`git log -p \| grep -i` for key prefixes). |
| 09:30–10:30 | **Submit BUIDL #1 — main track.** Source link, demo video, transaction link. All three are mandatory; an incomplete submission cannot be judged. |
| 10:30–11:15 | **Submit BUIDL #2 — bounty.** Separate BUIDL, as the rules require. Link the PR, the tests, the docs page, and issue #1241. |
| 11:15–12:00 | Buffer. Re-read both submissions. Confirm the contact details are reachable — email plus an X or Discord handle, both actually monitored, because finalists are invited by email. |

Do not start anything new on Friday. Friday is for submitting a thing that already works.

---

## 9. Cut lines

Cut in this order, without debate, when time runs short.

| # | Cut | Keep instead |
|---|---|---|
| C1 | Receipt anchoring on chain (RC-6) | Off-chain hash chain only |
| C2 | `safe.propose` node | The three Roles-path nodes |
| C3 | Console review screen (G3 UI) | G3 as a CLI approval prompt; the gate still exists |
| C4 | Fork-simulated balance delta in review | Decoded action only |
| C5 | Remit owner signatures (RM-5) | Unsigned Remit; the on-chain preset is the real authority anyway |
| C6 | Almanak adapter | The same architecture with **Safe + Zodiac Roles** as the named live project. ENS DAO, GnosisDAO, Balancer and Gnosis Pay run Roles in production; it satisfies "live project" without argument. Rewrite the pitch, keep the build. |
| C7 | Console entirely | A single static ledger page generated from `receipts/` |

**Never cut:** the four gates, the mainnet transaction, the receipt chain, the bounty PR.
Those four are the submission.

---

## 10. Demo video and live panel

The video is three minutes. The brief says up to ten finalists present the working build,
not slides, and get asked about it. Build the demo so it can be run live, twice, on a call.

Script:

1. **0:00–0:20** The Safe holds funds. Here is the Roles preset. Note this line:
   `onBehalfOf EqualTo SAFE`. That is the whole talk.
2. **0:20–0:50** Start the Almanak strategy. It decides to supply USDC. Watch it pass G1,
   preflight clean at G2, execute through KeeperHub. Transaction hash on Basescan.
3. **0:50–1:40** Now poison it. Same strategy, crafted input, redirect to an attacker
   address. G1 rejects in microseconds — no network call. Disable G1. G2 rejects with a
   decoded reason — no gas spent. Disable G2. The chain reverts. Three receipts, three
   independent refusals.
4. **1:40–2:10** The receipt chain. Strategy version → Remit → workflow → role →
   transaction hash. Verify it from a clean clone.
5. **2:10–2:35** Kill switch. One owner transaction. The agent has no authority. Nothing
   in our stack was consulted.
6. **2:35–3:00** The upstream PR closing issue #1241, and the mainnet transaction.

Questions to have answers ready for:

- *What stops KeeperHub itself from draining the Safe?* The preset. KeeperHub holds a
  signer that is a member of a role scoped to two functions with the recipient pinned to
  the Safe. Worst case is griefing, not theft.
- *Why not put the Remit on chain?* Because an unaudited contract written in five days
  holding funds is worse than an honest off-chain document over an audited preset. Named
  as a limitation in the submission rather than hidden.
- *What is actually new here?* The provenance receipt. Almanak scopes permissions and
  KeeperHub keeps an audit trail, but nothing today links a transaction hash back to the
  exact strategy version and the authority it acted under, verifiably, by a third party.
- *Why Roles instead of a Safe guard or a session key?* Roles v2 is audited, in production
  at ENS DAO and GnosisDAO, and expresses per-parameter conditions — which is what pins the
  recipient. A guard can only say yes or no to a whole transaction.

---

## 11. Submission checklist

Main track BUIDL:
- [ ] Source code link, public, with `README.md` and `receipts/`
- [ ] Demo video showing the integration working
- [ ] Link to a transaction executed through KeeperHub (Base mainnet)
- [ ] Form: integrated project and what the integration does
- [ ] Form: KeeperHub surfaces used
- [ ] Form: testnet or mainnet — both, with the caps stated
- [ ] Form: what still breaks — answered candidly per PRD.md §8
- [ ] Form: reachable email plus X or Discord handle, both monitored

Bounty BUIDL (separate, per the rules):
- [ ] PR open against `KeeperHub/keeperhub`, referencing and closing #1241
- [ ] Four nodes, unit tests, Base Sepolia fork test, docs page
- [ ] Plugin directory copies cleanly into `keeperhub/plugins/safe/` with no edits
- [ ] PR description includes the output of a real run against Base Sepolia

Housekeeping:
- [ ] No `.env`, no keys, no credentials anywhere in the git history
- [ ] `docs/VERIFIED.md` complete: every external address and endpoint, with source and date
- [ ] `docs/OPEN_QUESTIONS.md` empty or honestly populated
- [ ] Eligibility confirmed: 18+, not resident in an OFAC-restricted jurisdiction

---

## 12. Between submission and the panel (18–25 September)

- Keep the bounty PR alive. Respond to review comments within hours, not days. A merged PR
  before judging ends is worth more than any slide.
- Keep the demo environment funded and running. If you are shortlisted you present the
  working build, and a dead RPC key on the call is an avoidable loss.
- Rehearse the injection demo until it is boring. It must work on the second attempt, on
  someone else's network, with a judge interrupting.
- Watch the email account you submitted. Finalists are invited by email, with the time
  stated in both CEST and UTC.
