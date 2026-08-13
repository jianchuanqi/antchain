import { assert, assertEquals, assertRejects } from "@std/assert";
import { ContractRuleError, sha256Commitment } from "./model.ts";
import { UnifiedEcoLabelRegistrySimulator } from "./unified-simulator.ts";

const ADMIN = "admin";
const NOW = 1_700_000_000_000;
const H1 = sha256Commitment("1".repeat(64));
const H2 = sha256Commitment("2".repeat(64));
const H3 = sha256Commitment("3".repeat(64));
const H4 = sha256Commitment("4".repeat(64));
const H5 = sha256Commitment("5".repeat(64));
const H6 = sha256Commitment("6".repeat(64));
const H7 = sha256Commitment("7".repeat(64));

function registration(id = "eddl-1.0.0") {
  return {
    id,
    schemeId: "eco-design-digital-identifier",
    version: id === "eddl-1.0.0" ? "1.0.0" : "1.1.0",
    algorithmHash: id === "eddl-1.0.0" ? H1 : H2,
    evaluatorHash: H3,
  };
}

function issue(overrides = {}) {
  return {
    labelId: "EDDL-0001",
    taskId: "task-0001",
    algorithmId: "eddl-1.0.0",
    algorithmHash: H1,
    inputHash: H3,
    resultHash: H4,
    evidenceHash: H5,
    authorizationHash: H6,
    proofHash: H7,
    expiresAtEpochMs: NOW + 86_400_000,
    ...overrides,
  };
}

function activeFixture() {
  const contract = new UnifiedEcoLabelRegistrySimulator(ADMIN, NOW);
  contract.registerAlgorithm(ADMIN, registration());
  contract.setAlgorithmStatus(ADMIN, "eddl-1.0.0", "ACTIVE");
  return contract;
}

Deno.test("unified ABI contains rule and label methods without mirror methods", async () => {
  const abi = JSON.parse(
    await Deno.readTextFile(
      "contracts/eco-label/unified-registry/dist/index.abi",
    ),
  ) as { interfaces: Array<{ name: string }> };
  const methods = new Set(abi.interfaces.map((entry) => entry.name));
  for (
    const method of [
      "initialize",
      "registerAlgorithm",
      "setAlgorithmStatus",
      "replaceActiveAlgorithm",
      "getAlgorithm",
      "getActiveAlgorithmId",
      "isAlgorithmActive",
      "issueLabel",
      "suspendLabel",
      "resumeLabel",
      "revokeLabel",
      "expireLabel",
      "replaceLabel",
      "getLabel",
      "getLabelByTaskId",
    ]
  ) {
    assert(methods.has(method), `missing ${method}`);
  }
  assert(!methods.has("syncAlgorithmState"));
  assert(!methods.has("getAlgorithmStateMirror"));
});

Deno.test("unified source has no cross-contract or algorithm mirror dependency", async () => {
  const source = await Deno.readTextFile(
    "contracts/eco-label/unified-registry/assembly/index.ts",
  );
  assert(!source.includes("callContract"));
  assert(!source.includes("syncAlgorithmState"));
  assert(!source.includes("ALGORITHM_MIRROR_ADMIN"));
  assert(source.includes("this.isAlgorithmActiveInternal"));
  assert(source.includes("parts.length == 16"));
});

Deno.test("unified issue atomically requires the exact active rule", async () => {
  const contract = new UnifiedEcoLabelRegistrySimulator(ADMIN, NOW);
  contract.registerAlgorithm(ADMIN, registration());
  await assertRejects(
    async () => contract.issueLabel(ADMIN, issue()),
    ContractRuleError,
    "ALGORITHM_NOT_ACTIVE",
  );
  contract.setAlgorithmStatus(ADMIN, "eddl-1.0.0", "ACTIVE");
  const label = contract.issueLabel(ADMIN, issue());
  assertEquals(label.status, "ACTIVE");
  assertEquals(contract.getLabelByTaskId("task-0001")?.labelId, "EDDL-0001");
  contract.setAlgorithmStatus(ADMIN, "eddl-1.0.0", "SUSPENDED");
  await assertRejects(
    async () =>
      contract.issueLabel(
        ADMIN,
        issue({ labelId: "EDDL-0002", taskId: "task-0002" }),
      ),
    ContractRuleError,
    "ALGORITHM_NOT_ACTIVE",
  );
  assertEquals(contract.size, 1);
});

Deno.test("unified issue is idempotent and rejects changed or reused identities", async () => {
  const contract = activeFixture();
  const first = contract.issueLabel(ADMIN, issue());
  const repeated = contract.issueLabel(ADMIN, issue());
  assertEquals(repeated, first);
  assertEquals(contract.size, 1);
  await assertRejects(
    async () => contract.issueLabel(ADMIN, issue({ resultHash: H2 })),
    ContractRuleError,
    "IDEMPOTENCY_CONFLICT",
  );
  await assertRejects(
    async () => contract.issueLabel(ADMIN, issue({ labelId: "EDDL-0002" })),
    ContractRuleError,
    "IDEMPOTENCY_CONFLICT",
  );
});

Deno.test("exact issue retry survives later rule suspension and label expiry", () => {
  const contract = activeFixture();
  const first = contract.issueLabel(ADMIN, issue());
  contract.setAlgorithmStatus(ADMIN, "eddl-1.0.0", "SUSPENDED");
  contract.setClock(NOW + 86_400_001);
  assertEquals(contract.issueLabel(ADMIN, issue()), first);
  assertEquals(contract.size, 1);
});

Deno.test("unified rule replacement changes the atomic issuance gate", async () => {
  const contract = activeFixture();
  contract.registerAlgorithm(ADMIN, registration("eddl-1.1.0"));
  contract.replaceActiveAlgorithm(ADMIN, "eddl-1.0.0", "eddl-1.1.0");
  assertEquals(
    contract.getActiveAlgorithmId("eco-design-digital-identifier"),
    "eddl-1.1.0",
  );
  await assertRejects(
    async () => contract.issueLabel(ADMIN, issue()),
    ContractRuleError,
    "ALGORITHM_NOT_ACTIVE",
  );
  const label = contract.issueLabel(
    ADMIN,
    issue({ algorithmId: "eddl-1.1.0", algorithmHash: H2 }),
  );
  assertEquals(label.algorithmId, "eddl-1.1.0");
});

Deno.test("unified lifecycle enforces roles and terminal revocation", async () => {
  const contract = activeFixture();
  contract.issueLabel(ADMIN, issue());
  await assertRejects(
    async () => contract.suspendLabel("intruder", "EDDL-0001"),
    ContractRuleError,
    "UNAUTHORIZED",
  );
  assertEquals(contract.suspendLabel(ADMIN, "EDDL-0001").status, "SUSPENDED");
  assertEquals(contract.resumeLabel(ADMIN, "EDDL-0001").status, "ACTIVE");
  assertEquals(contract.revokeLabel(ADMIN, "EDDL-0001", H2).status, "REVOKED");
  await assertRejects(
    async () => contract.resumeLabel(ADMIN, "EDDL-0001"),
    ContractRuleError,
    "INVALID_TRANSITION",
  );
});

Deno.test("unified contract state and events contain commitments but no rating data", () => {
  const contract = activeFixture();
  contract.issueLabel(ADMIN, issue());
  const serialized = JSON.stringify({
    label: contract.getLabel("EDDL-0001"),
    events: contract.events,
  }).toLowerCase();
  for (
    const forbidden of [
      "bom",
      "supplier",
      "indicatorvalue",
      "score",
      "grade",
      "rawdata",
    ]
  ) {
    assert(!serialized.includes(forbidden), `found forbidden ${forbidden}`);
  }
});
