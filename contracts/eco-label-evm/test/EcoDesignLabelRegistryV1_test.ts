import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  ContractFactory,
  JsonRpcProvider,
  keccak256,
  toUtf8Bytes,
} from "npm:ethers@6.15.0";

type JsonRecord = Record<string, unknown>;

const artifact = JSON.parse(
  await Deno.readTextFile(
    new URL("../dist/EcoDesignLabelRegistryV1.json", import.meta.url),
  ),
) as {
  abi: string[];
  bytecode: string;
  deployedBytecode: string;
  compiler: { version: string };
  nativeReference: {
    abi: string[];
    bytecode: string;
    deployedBytecode: string;
  };
};

const provider = new JsonRpcProvider(
  Deno.env.get("ECO_LABEL_EVM_TEST_RPC_URL") ?? "http://127.0.0.1:18545",
);
const [admin, algorithmAdmin, issuer, lifecycle, outsider] = await Promise.all(
  [0, 1, 2, 3, 4].map((index) => provider.getSigner(index)),
);

const bytes32 = (value: string) => keccak256(toUtf8Bytes(value));
const txOptions = { gasLimit: 2_000_000 };
const rule = {
  algorithmId: "ECO-IND-FINAL-20260729",
  schemeId: "eco-design-digital-identifier",
  version: "1.0.0",
  algorithmHash: bytes32("rule-bundle-v1"),
  evaluatorHash: bytes32("evaluator-v1"),
};
const request = (suffix = "001") => ({
  labelId: `EDDL-EVM-RESEARCH-${suffix}`,
  taskId: `R2026001-EVM-${suffix}`,
  algorithmId: rule.algorithmId,
  algorithmHash: rule.algorithmHash,
  inputHash: bytes32(`input-${suffix}`),
  resultHash: bytes32(`result-${suffix}`),
  evidenceHash: bytes32(`evidence-${suffix}`),
  authorizationHash: bytes32(`authorization-${suffix}`),
  proofHash: bytes32(`proof-${suffix}`),
  expiresAt: 0,
});
const issueArgs = (input: ReturnType<typeof request>) =>
  [
    input.labelId,
    input.taskId,
    input.algorithmId,
    input.algorithmHash,
    input.inputHash,
    input.resultHash,
    input.evidenceHash,
    input.authorizationHash,
    input.proofHash,
    input.expiresAt,
  ] as const;

async function deploy() {
  const factory = new ContractFactory(
    artifact.nativeReference.abi,
    artifact.nativeReference.bytecode,
    admin,
  );
  const contract = await factory.deploy({ gasLimit: 12_000_000 });
  await contract.waitForDeployment();
  const role = (name: string) => bytes32(name);
  await (await contract.grantRole(
    role("ALGORITHM_ADMIN_ROLE"),
    await algorithmAdmin.getAddress(),
    txOptions,
  )).wait();
  await (await contract.grantRole(
    role("LABEL_ISSUER_ROLE"),
    await issuer.getAddress(),
    txOptions,
  )).wait();
  await (await contract.grantRole(
    role("LABEL_LIFECYCLE_ROLE"),
    await lifecycle.getAddress(),
    txOptions,
  )).wait();
  return contract;
}

async function registerAndActivate(
  contract: Awaited<ReturnType<typeof deploy>>,
) {
  await (await contract.connect(algorithmAdmin).registerAlgorithm(
    rule.algorithmId,
    rule.schemeId,
    rule.version,
    rule.algorithmHash,
    rule.evaluatorHash,
    txOptions,
  )).wait();
  await (await contract.connect(algorithmAdmin).activateAlgorithm(
    rule.algorithmId,
    txOptions,
  )).wait();
}

Deno.test("EVM artifact is pinned and deployable without sensitive rating fields", async () => {
  assert(artifact.compiler.version.startsWith("0.4.24+commit.6eda33a0.mod"));
  assert(artifact.bytecode.startsWith("0x"));
  assert(artifact.deployedBytecode.startsWith("0x"));
  assert(
    artifact.nativeReference.deployedBytecode.slice(2).length / 2 <= 24_576,
    "native reference runtime must remain within the standard EVM code-size limit",
  );
  const source = await Deno.readTextFile(
    new URL("../EcoDesignLabelRegistryV1.sol", import.meta.url),
  );
  assert(source.includes("pragma solidity ^0.4.0;"));
  assertEquals(/\baddress\b/.test(source), false);
  assert(source.includes("identity issuer;"));
  for (
    const forbiddenSource of [
      "delegatecall",
      "selfdestruct",
      "tx.origin",
      "callcode",
    ]
  ) {
    assertEquals(source.toLowerCase().includes(forbiddenSource), false);
  }
  const abiText = JSON.stringify(artifact.abi).toLowerCase();
  assert(abiText.includes('"type":"identity"'));
  for (
    const forbidden of [
      "bom",
      "supplier",
      "dimensionscores",
      "indicatorvalues",
      "score",
      "grade",
    ]
  ) {
    assertEquals(abiText.includes(forbidden), false);
  }
});

Deno.test("active rule and label issuance are atomic in one contract", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const input = request();
  const transaction = await contract.connect(issuer).issueLabel(
    ...issueArgs(input),
    txOptions,
  );
  const receipt = await transaction.wait();
  const events = receipt.logs.map((log: JsonRecord) => {
    try {
      return contract.interface.parseLog(log as never)?.name;
    } catch {
      return undefined;
    }
  });
  assert(events.includes("LabelIssued"));
  const byId = await contract.getLabel(input.labelId);
  const byTask = await contract.getLabelByTaskId(input.taskId);
  assertEquals(byId.taskId, input.taskId);
  assertEquals(byTask.labelId, input.labelId);
  assertEquals(byId.status, 1n);
  assertEquals(byId.payloadDigest, byTask.payloadDigest);
  assertEquals(
    await contract.getActiveAlgorithmId(rule.schemeId),
    rule.algorithmId,
  );
  assertEquals(
    await contract.isAlgorithmActive(rule.algorithmId, rule.algorithmHash),
    true,
  );
});

Deno.test("unauthorized and inactive-rule issuance fail without state", async () => {
  const contract = await deploy();
  const input = request("002");
  await (await contract.connect(algorithmAdmin).registerAlgorithm(
    rule.algorithmId,
    rule.schemeId,
    rule.version,
    rule.algorithmHash,
    rule.evaluatorHash,
    txOptions,
  )).wait();
  await assertRejects(() =>
    contract.connect(outsider).issueLabel(...issueArgs(input))
  );
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs(input))
  );
  await assertRejects(() => contract.getLabel(input.labelId));
});

Deno.test("exact retry is idempotent and conflicting label/task reuse is rejected", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const input = request("003");
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(input),
    txOptions,
  )).wait();
  const retry = await contract.connect(issuer).issueLabel.staticCall(
    ...issueArgs(input),
  );
  assertEquals(retry, (await contract.getLabel(input.labelId)).payloadDigest);
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(input),
    txOptions,
  )).wait();
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs({
      ...input,
      resultHash: bytes32("changed-result"),
    }))
  );
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs({
      ...request("004"),
      taskId: input.taskId,
    }))
  );
});

Deno.test("algorithm suspension atomically blocks subsequent issuance", async () => {
  const contract = await deploy();
  const suspendedRule = {
    ...rule,
    algorithmId: `${rule.algorithmId}-SUSPENSION-TEST`,
  };
  await (await contract.connect(algorithmAdmin).registerAlgorithm(
    suspendedRule.algorithmId,
    suspendedRule.schemeId,
    suspendedRule.version,
    suspendedRule.algorithmHash,
    suspendedRule.evaluatorHash,
    txOptions,
  )).wait();
  await (await contract.connect(algorithmAdmin).activateAlgorithm(
    suspendedRule.algorithmId,
    txOptions,
  )).wait();
  await (await contract.connect(algorithmAdmin).suspendAlgorithm(
    suspendedRule.algorithmId,
    txOptions,
  )).wait();
  assertEquals(
    await contract.isAlgorithmActive(
      suspendedRule.algorithmId,
      suspendedRule.algorithmHash,
    ),
    false,
  );
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs({
      ...request("005"),
      algorithmId: suspendedRule.algorithmId,
    }))
  );
});

Deno.test("label lifecycle is governed and irreversible at terminal states", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const input = request("006");
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(input),
    txOptions,
  )).wait();
  await (await contract.connect(lifecycle).suspendLabel(
    input.labelId,
    txOptions,
  )).wait();
  assertEquals((await contract.getLabel(input.labelId)).status, 2n);
  await (await contract.connect(lifecycle).resumeLabel(
    input.labelId,
    txOptions,
  )).wait();
  assertEquals((await contract.getLabel(input.labelId)).status, 1n);
  await (await contract.connect(lifecycle).revokeLabel(
    input.labelId,
    bytes32("reason"),
    txOptions,
  )).wait();
  assertEquals((await contract.getLabel(input.labelId)).status, 4n);
  await assertRejects(() =>
    contract.connect(lifecycle).resumeLabel.staticCall(input.labelId)
  );
});

Deno.test("supersede creates a new immutable label and links both records", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const first = request("007-A");
  const second = request("007-B");
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(first),
    txOptions,
  )).wait();
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(second),
    txOptions,
  )).wait();
  await (await contract.connect(issuer).supersedeLabel(
    first.labelId,
    second.labelId,
    { gasLimit: 2_000_000 },
  )).wait();
  await (await contract.connect(issuer).supersedeLabel(
    first.labelId,
    second.labelId,
    { gasLimit: 2_000_000 },
  )).wait();
  const previous = await contract.getLabel(first.labelId);
  const next = await contract.getLabel(second.labelId);
  const previousLifecycle = await contract.getLabelLifecycle(first.labelId);
  const nextLifecycle = await contract.getLabelLifecycle(second.labelId);
  assertEquals(previous.status, 3n);
  assertEquals(previousLifecycle.replacedByLabelId, second.labelId);
  assertEquals(nextLifecycle.previousLabelId, first.labelId);
  assertEquals(next.status, 1n);
});

Deno.test("algorithm registration is idempotent but changed content conflicts", async () => {
  const contract = await deploy();
  const connected = contract.connect(algorithmAdmin);
  await (await connected.registerAlgorithm(
    rule.algorithmId,
    rule.schemeId,
    rule.version,
    rule.algorithmHash,
    rule.evaluatorHash,
    txOptions,
  )).wait();
  await (await connected.registerAlgorithm(
    rule.algorithmId,
    rule.schemeId,
    rule.version,
    rule.algorithmHash,
    rule.evaluatorHash,
    txOptions,
  )).wait();
  await assertRejects(() =>
    connected.registerAlgorithm(
      rule.algorithmId,
      rule.schemeId,
      "2.0.0",
      rule.algorithmHash,
      rule.evaluatorHash,
    )
  );
});

Deno.test("activating a new rule version suspends the previous active version", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const nextId = `${rule.algorithmId}-V2`;
  const nextHash = bytes32("rule-bundle-v2");
  await (await contract.connect(algorithmAdmin).registerAlgorithm(
    nextId,
    rule.schemeId,
    "2.0.0",
    nextHash,
    rule.evaluatorHash,
    txOptions,
  )).wait();
  await (await contract.connect(algorithmAdmin).activateAlgorithm(
    nextId,
    txOptions,
  )).wait();
  assertEquals((await contract.getAlgorithm(rule.algorithmId)).status, 3n);
  assertEquals((await contract.getAlgorithm(nextId)).status, 2n);
  assertEquals(await contract.getActiveAlgorithmId(rule.schemeId), nextId);
});

Deno.test("retired algorithms cannot be reactivated", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  await (await contract.connect(algorithmAdmin).retireAlgorithm(
    rule.algorithmId,
    txOptions,
  )).wait();
  assertEquals((await contract.getAlgorithm(rule.algorithmId)).status, 4n);
  await assertRejects(() =>
    contract.connect(algorithmAdmin).activateAlgorithm.staticCall(
      rule.algorithmId,
    )
  );
});

Deno.test("zero commitments and already-expired labels are rejected", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs({
      ...request("008"),
      proofHash: `0x${"00".repeat(32)}`,
    }))
  );
  const block = await provider.getBlock("latest");
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs({
      ...request("009"),
      expiresAt: Number(block?.timestamp ?? 0),
    }))
  );
});

Deno.test("wrong algorithm commitment cannot issue under an active rule", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs({
      ...request("010"),
      algorithmHash: bytes32("wrong-rule"),
    }))
  );
});

Deno.test("revoking a role immediately removes the associated authority", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  await (await contract.revokeRole(
    bytes32("LABEL_ISSUER_ROLE"),
    await issuer.getAddress(),
    txOptions,
  )).wait();
  await assertRejects(() =>
    contract.connect(issuer).issueLabel(...issueArgs(request("011")))
  );
});

Deno.test("unknown labels and tasks fail closed", async () => {
  const contract = await deploy();
  await assertRejects(() => contract.getLabel("UNKNOWN-LABEL"));
  await assertRejects(() => contract.getLabelByTaskId("UNKNOWN-TASK"));
});

Deno.test("only lifecycle role can suspend, resume and revoke", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const input = request("012");
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(input),
    txOptions,
  )).wait();
  await assertRejects(() =>
    contract.connect(outsider).suspendLabel(input.labelId)
  );
  await assertRejects(() =>
    contract.connect(outsider).revokeLabel(input.labelId, bytes32("reason"))
  );
});

Deno.test("a label expires only after its declared chain time", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const block = await provider.getBlock("latest");
  const input = {
    ...request("013"),
    expiresAt: Number(block?.timestamp ?? 0) + 120,
  };
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(input),
    txOptions,
  )).wait();
  await assertRejects(() => contract.expireLabel.staticCall(input.labelId));
  await provider.send("evm_increaseTime", [121]);
  await provider.send("evm_mine", []);
  await (await contract.expireLabel(input.labelId, txOptions)).wait();
  assertEquals((await contract.getLabel(input.labelId)).status, 5n);
  await assertRejects(() =>
    contract.connect(lifecycle).resumeLabel(input.labelId)
  );
});

Deno.test("terminal revoked labels cannot be superseded", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const first = request("014-A");
  await (await contract.connect(issuer).issueLabel(
    ...issueArgs(first),
    txOptions,
  )).wait();
  await (await contract.connect(lifecycle).revokeLabel(
    first.labelId,
    bytes32("reason"),
    txOptions,
  )).wait();
  await assertRejects(() =>
    contract.connect(issuer).supersedeLabel(
      first.labelId,
      request("014-B").labelId,
    )
  );
  await assertRejects(() => contract.getLabel("EDDL-EVM-RESEARCH-014-B"));
});

Deno.test("event commitments and independent task read remain consistent", async () => {
  const contract = await deploy();
  await registerAndActivate(contract);
  const input = request("015");
  const tx = await contract.connect(issuer).issueLabel(
    ...issueArgs(input),
    txOptions,
  );
  const receipt = await tx.wait();
  const parsed = receipt.logs.map((log: JsonRecord) => {
    try {
      return contract.interface.parseLog(log as never);
    } catch {
      return null;
    }
  }).find((event: JsonRecord | null) => event?.name === "LabelIssued");
  assert(parsed);
  const byTask = await contract.getLabelByTaskId(input.taskId);
  const commitments = await contract.getLabelCommitments(input.labelId);
  assertEquals(parsed.args.resultHash, commitments.resultHash);
  assertEquals(parsed.args.payloadDigest, byTask.payloadDigest);
});
