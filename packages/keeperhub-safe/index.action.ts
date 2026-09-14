/**
 * The action entry for `plugins/safe/index.ts`.
 *
 * `plugins/safe/index.ts` already exists upstream and pushes its actions onto the
 * protocol-registered "safe" integration. This is the entry to add beside
 * `getPendingTransactionsAction`, not a replacement file — a plugin that overwrote
 * theirs would delete a working action, and a reviewer would be right to reject it.
 *
 *     safeProtocol.actions.push(getPendingTransactionsAction);
 *     safeProtocol.actions.push(policyCheckAction);   // <- added
 */

export const policyCheckAction = {
  slug: "policy-check",
  label: "Check Role Policy",
  description:
    "Ask the Zodiac Roles modifier whether a call would be allowed, before sending it. Simulates execTransactionWithRole from the delegate EOA with eth_call, so the preflight takes the same path as the broadcast and a refusal comes back as a named Status rather than a hex blob. Costs no gas whatever the answer.",
  category: "Safe",
  stepFunction: "policyCheckStep",
  stepImportPath: "policy-check",
  requiresCredentials: false,
  outputFields: [
    { field: "success", description: "Whether the check ran" },
    {
      field: "allowed",
      description: "Whether the role would allow this call",
    },
    {
      field: "reason",
      description: "Named reason when the call would be refused",
    },
    {
      field: "revertKind",
      description:
        "Structured classification, e.g. role-condition-violation, role-not-authorized, erc20-insufficient-allowance",
    },
    {
      field: "status",
      description:
        "The modifier's Status label when it refused on a condition, e.g. ParameterNotAllowed",
    },
    {
      field: "refusedByRole",
      description:
        "True when the role refused; false when the role allowed it and the inner call would fail anyway",
    },
    {
      field: "gasEstimate",
      description: "Gas the call would consume if it were sent",
    },
    { field: "error", description: "Error message if the check could not run" },
  ],
  configFields: [
    {
      key: "contractAddress",
      label: "Contract Address",
      type: "template-input" as const,
      placeholder: "0x... or {{NodeName.address}}",
      example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      required: true,
    },
    {
      key: "callData",
      label: "Call Data",
      type: "template-input" as const,
      placeholder: "0x... the calldata the next node would send",
      example: "0x095ea7b3...",
      required: true,
    },
    {
      key: "value",
      label: "Native Value (wei)",
      type: "template-input" as const,
      placeholder: "0",
      example: "0",
      required: false,
    },
  ],
};
