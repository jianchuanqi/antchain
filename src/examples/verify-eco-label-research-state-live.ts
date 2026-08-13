import {
  CloudCryptoRestProvider,
  WasmContract,
} from "npm:@antchain/jssdk@1.2.1";
import { resolveAntChainLiveConfig } from "../eco/adapters/antchain-live-config.ts";
import { chainCodeMatchesFrozenWasc } from "../eco/adapters/antchain-live-chain-code.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function parseRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function normalizeHash(value: unknown): string {
  const text = String(value ?? "").replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error("Expected a 32-byte hexadecimal hash");
  }
  return text;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return `sha256:${
    Array.from(digest, (item) => item.toString(16).padStart(2, "0")).join("")
  }`;
}

function exactJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const resolution = await resolveAntChainLiveConfig();
if (!resolution.config) {
  console.error(
    JSON.stringify({ ready: false, blockers: resolution.report.blockers }),
  );
  Deno.exit(2);
}
const config = resolution.config;
const evidencePath = Deno.env.get("ECO_ANTCHAIN_RESEARCH_EVIDENCE_PATH") ??
  `${config.evidenceDirectory}/evidence.json`;
const evidence = asRecord(JSON.parse(await Deno.readTextFile(evidencePath)));
if (!evidence) throw new Error("Research evidence is not a JSON object");
const recoveries = Array.isArray(evidence.stateRecoveries)
  ? evidence.stateRecoveries.map(asRecord).filter(Boolean) as JsonRecord[]
  : [];
const issue = recoveries.find((item) =>
  item.operation === "issue:SyntheticResearchLabel"
);
const expectedReadback = asRecord(issue?.readback);
const expectedById = asRecord(expectedReadback?.labelById);
const expectedByTask = asRecord(expectedReadback?.labelByTaskId);
if (!issue || !expectedById || !expectedByTask) {
  throw new Error(
    "Evidence does not contain a recovered label transaction and dual readback",
  );
}
const txHash = normalizeHash(issue.transactionHash);
const fixedHeight = Number(issue.blockHeight);
const fixedHash = normalizeHash(issue.blockHash);
if (!Number.isSafeInteger(fixedHeight) || fixedHeight <= 0) {
  throw new Error("Evidence fixed block height is invalid");
}

const provider = new CloudCryptoRestProvider({
  restUrl: config.restUrl,
  bizid: config.bizId,
  accessId: config.accessId,
  accessSecret: config.accessSecret,
  account: config.account,
  tenantId: config.tenantId,
  kmsId: config.kmsId,
});
const token = await provider.getToken();

const gatewayQuery = async (body: JsonRecord): Promise<JsonRecord> => {
  const response = await fetch(
    new URL("/api/contract/chainCall", config.restUrl),
    {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accessId: config.accessId,
        bizid: config.bizId,
        ...body,
        token,
      }),
    },
  );
  const outer = asRecord(await response.json());
  if (
    !response.ok || outer?.success !== true ||
    !["0", "200"].includes(String(outer.code))
  ) {
    throw new Error(
      `Read-only AntChain query failed with code ${
        String(outer?.code ?? response.status)
      }`,
    );
  }
  return parseRecord(outer.data) ?? {};
};

const labelAbi = await Deno.readTextFile(
  "contracts/eco-label/releases/target-chain-compat-v2/eco-label-registry/index.abi",
);
const algorithmAbi = await Deno.readTextFile(
  "contracts/eco-label/releases/target-chain-compat-v2/algorithm-registry/index.abi",
);
const labelWasc = await Deno.readFile(
  "contracts/eco-label/releases/target-chain-compat-v2/eco-label-registry/index.wasc",
);
const expectedCodeDigest = await sha256Bytes(labelWasc);
const labelContract = new WasmContract({
  contractName: config.ecoLabelRegistryName,
  abi: labelAbi,
}, provider);
const algorithmContract = new WasmContract({
  contractName: config.algorithmRegistryName,
  abi: algorithmAbi,
}, provider);
const read = async <T>(
  contract: WasmContract,
  methodName: string,
  args: string[],
  argsType: string[],
  returnType: string,
): Promise<T> => {
  const result = await contract.call<T>({
    methodName,
    args,
    argsType,
    returnType,
    local: true,
    tee: false,
    timeout: config.receiptTimeoutMs,
  });
  return result.returnValue;
};

const transaction = await provider.queryTransaction({ hash: txHash });
const transactionTarget = normalizeHash(transaction.to);
const expectedTarget = normalizeHash(issue.transactionTarget);
if (transactionTarget !== expectedTarget) {
  throw new Error(
    "Transaction target does not match the fixed EcoLabelRegistry",
  );
}
if (Number(transaction.blockNumber) !== fixedHeight) {
  throw new Error("Transaction is not included in the fixed evidence block");
}
const fixedBlockFirst = await provider.queryBlockHeader({
  blockNumber: fixedHeight,
});
if (normalizeHash(fixedBlockFirst.hash) !== fixedHash) {
  throw new Error("Fixed block hash does not match the stored evidence");
}

const receipt = await gatewayQuery({ method: "QUERYRECEIPT", hash: txHash });
if (
  normalizeHash(receipt.hash) !== txHash ||
  Number(receipt.blockNumber) !== fixedHeight ||
  Number(receipt.code) !== 0 ||
  Number(receipt.result) !== 0
) {
  throw new Error(
    "Receipt execution fields do not match the successful fixed transaction",
  );
}

const deployedCode = await provider.queryContract({
  contractName: config.ecoLabelRegistryName,
});
if (!await chainCodeMatchesFrozenWasc(deployedCode.code, expectedCodeDigest)) {
  throw new Error(
    "On-chain EcoLabelRegistry code does not match the frozen WASC digest",
  );
}

const labelId = String(expectedById.labelId);
const taskId = String(expectedById.taskId);
const algorithmId = String(expectedById.algorithmId);
const algorithmHash = String(expectedById.algorithmHash);
const schemeId = String(
  asRecord(asRecord(evidence.release))?.schemeId ?? config.schemeId,
);
const readState = async () => {
  const labelById = parseRecord(
    await read<string>(
      labelContract,
      "getLabel",
      [labelId],
      ["string"],
      "string",
    ),
  );
  const labelByTaskId = parseRecord(
    await read<string>(
      labelContract,
      "getLabelByTaskId",
      [taskId],
      ["string"],
      "string",
    ),
  );
  const algorithm = parseRecord(
    await read<string>(
      algorithmContract,
      "getAlgorithm",
      [algorithmId],
      ["string"],
      "string",
    ),
  );
  const activeAlgorithmId = await read<string>(
    algorithmContract,
    "getActiveAlgorithmId",
    [schemeId],
    ["string"],
    "string",
  );
  const algorithmActive = await read<string>(
    algorithmContract,
    "isAlgorithmActive",
    [algorithmId, algorithmHash],
    ["string", "string"],
    "string",
  );
  const mirror = parseRecord(
    await read<string>(
      labelContract,
      "getAlgorithmStateMirror",
      [algorithmId],
      ["string"],
      "string",
    ),
  );
  const activeMirroredAlgorithmId = await read<string>(
    labelContract,
    "getActiveMirroredAlgorithmId",
    [schemeId],
    ["string"],
    "string",
  );
  const mirrorActive = await read<string>(
    labelContract,
    "isMirroredAlgorithmActive",
    [algorithmId, algorithmHash],
    ["string", "string"],
    "string",
  );
  return {
    labelById,
    labelByTaskId,
    algorithm,
    activeAlgorithmId,
    algorithmActive,
    mirror,
    activeMirroredAlgorithmId,
    mirrorActive,
  };
};

const firstState = await readState();
if (
  !firstState.labelById ||
  !firstState.labelByTaskId ||
  !exactJsonEqual(firstState.labelById, firstState.labelByTaskId) ||
  !exactJsonEqual(firstState.labelById, expectedById) ||
  !exactJsonEqual(firstState.labelByTaskId, expectedByTask) ||
  firstState.labelById.status !== "ACTIVE" ||
  firstState.algorithm?.status !== "ACTIVE" ||
  firstState.activeAlgorithmId !== algorithmId ||
  firstState.algorithmActive !== "1" ||
  firstState.activeMirroredAlgorithmId !== algorithmId ||
  firstState.mirrorActive !== "1" ||
  firstState.mirror?.sourceStateHash !== expectedById.algorithmSourceStateHash
) {
  throw new Error("Rule state or label dual readback is inconsistent");
}

const latest = await gatewayQuery({ method: "QUERYLASTBLOCK" });
const latestBlock = asRecord(asRecord(latest.block)?.blockHeader) ??
  asRecord(latest.blockHeader) ?? latest;
const laterHeight = Number(latestBlock.number);
if (!Number.isSafeInteger(laterHeight) || laterHeight <= fixedHeight) {
  throw new Error("No later AntChain block is available for recheck");
}
const laterHash = normalizeHash(latestBlock.hash);
const fixedBlockSecond = await provider.queryBlockHeader({
  blockNumber: fixedHeight,
});
if (!exactJsonEqual(fixedBlockSecond, fixedBlockFirst)) {
  throw new Error(
    "The fixed transaction block changed during later-block recheck",
  );
}
const secondCode = await provider.queryContract({
  contractName: config.ecoLabelRegistryName,
});
if (!await chainCodeMatchesFrozenWasc(secondCode.code, expectedCodeDigest)) {
  throw new Error("On-chain contract code changed during later-block recheck");
}
const secondState = await readState();
if (!exactJsonEqual(secondState, firstState)) {
  throw new Error("Rule or label state changed during later-block recheck");
}

console.log(JSON.stringify(
  {
    schemaVersion: "eddl-antchain-research-state-confirmation/v1",
    status: "RESEARCH_STATE_CONFIRMED",
    standardFinalityConfirmed: false,
    confirmedAt: new Date().toISOString(),
    transaction: {
      hash: txHash,
      targetContractIdentity: transactionTarget,
      fixedBlockHeight: fixedHeight,
      fixedBlockHash: fixedHash,
    },
    standardReceiptFlags: {
      txFinish: receipt.txFinish === true,
      txSuccess: receipt.txSuccess === true,
      code: Number(receipt.code),
      result: Number(receipt.result),
    },
    contract: {
      name: config.ecoLabelRegistryName,
      identity: expectedTarget,
      chainCodeDigest: expectedCodeDigest,
      codeMatchesFrozenRelease: true,
    },
    rule: {
      algorithmId,
      algorithmHash,
      status: firstState.algorithm?.status,
      activeAlgorithmId: firstState.activeAlgorithmId,
      algorithmActive: firstState.algorithmActive,
      mirrorSourceStateHash: firstState.mirror?.sourceStateHash,
      mirrorActive: firstState.mirrorActive,
    },
    label: {
      labelId,
      taskId,
      status: firstState.labelById.status,
      inputHash: firstState.labelById.inputHash,
      resultHash: firstState.labelById.resultHash,
      evidenceHash: firstState.labelById.evidenceHash,
      proofHash: firstState.labelById.proofHash,
      dualReadConsistent: true,
    },
    laterObservationBlock: {
      height: laterHeight,
      hash: laterHash,
      timestamp: String(latestBlock.timestamp),
    },
    rechecks: {
      fixedBlockStable: true,
      targetContractStable: true,
      chainCodeStable: true,
      ruleStateStable: true,
      labelDualReadStable: true,
    },
  },
  null,
  2,
));
