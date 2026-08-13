import { Buffer } from "node:buffer";
import {
  CloudCryptoRestProvider,
  WasmContract,
} from "npm:@antchain/jssdk@1.2.1";
import { ApiResponse } from "../deps.ts";
import {
  AntChainLiveConfig,
  resolveAntChainLiveConfig,
} from "../eco/adapters/antchain-live-config.ts";
import { chainCodeMatchesFrozenWasc } from "../eco/adapters/antchain-live-chain-code.ts";

type JsonRecord = Record<string, unknown>;

interface FrozenIntent {
  operation: string;
  orderId: string;
  requestCommitment: string;
  persistedAt: string;
  submissionCount: 0 | 1;
  transactionHash?: string;
  submittedAt?: string;
}

interface UnifiedEvidence {
  schemaVersion: "eddl-antchain-unified-live-evidence/v1";
  assurance: "RESEARCH_TRIAL";
  status: "RUNNING" | "RESEARCH_STATE_CONFIRMED" | "BLOCKED";
  startedAt: string;
  confirmedAt?: string;
  target: {
    gatewayOrigin: string;
    profileCommitment: string;
    contractName: string;
    contractIdentity: string;
    wascDigest: string;
    abiDigest: string;
  };
  release: {
    algorithmId: string;
    schemeId: string;
    version: string;
    algorithmHash: string;
    evaluatorHash: string;
  };
  pilot: {
    labelId: string;
    taskId: string;
    inputHash: string;
    resultHash: string;
    evidenceHash: string;
    authorizationHash: string;
    proofHash: string;
  };
  accountIdentity?: string;
  intents: FrozenIntent[];
  observations: Record<string, unknown>;
  failure?: { name: string; message: string };
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function parseRecord(value: unknown): JsonRecord | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function normalizeHash(value: string): string {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("AntChain did not return a 32-byte hexadecimal hash");
  }
  return normalized.toLowerCase();
}

function normalizeIdentity(value: string): string {
  return normalizeHash(value);
}

function findTransactionHash(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return normalizeHash(value);
    } catch {
      const parsed = parseRecord(value);
      return parsed ? findTransactionHash(parsed) : undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTransactionHash(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["txHash", "transactionHash", "hash", "txData", "data"]) {
    const found = findTransactionHash(record[key]);
    if (found) return found;
  }
  return undefined;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes).buffer,
  );
  return `sha256:${
    Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")).join("")
  }`;
}

async function sha256Text(value: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(value));
}

async function contractIdentity(name: string): Promise<string> {
  return (await sha256Text(name)).slice(7);
}

function safeFailure(error: unknown, config: AntChainLiveConfig) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: (error instanceof Error ? error.message : String(error))
      .replaceAll(config.accessId, "<redacted-access-id>")
      .replaceAll(config.accessSecret, "<redacted-access-secret>"),
  };
}

class UnifiedGateway {
  private token?: string;

  constructor(
    private readonly provider: CloudCryptoRestProvider,
    private readonly config: AntChainLiveConfig,
  ) {}

  private async request(path: string, body: JsonRecord): Promise<ApiResponse> {
    this.token ??= await this.provider.getToken();
    const response = await fetch(new URL(path, this.config.restUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.config.receiptTimeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, token: this.token }),
    });
    const parsed = await response.json() as JsonRecord;
    if (String(parsed.code) === "202") {
      this.token = await this.provider.getToken();
      return await this.request(path, body);
    }
    return {
      success: response.ok && parsed.success === true &&
        ["0", "200"].includes(String(parsed.code)),
      code: String(parsed.code ?? response.status),
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      data: typeof parsed.data === "string"
        ? (parseRecord(parsed.data) ?? parsed.data)
        : parsed.data,
    };
  }

  async deploy(contractName: string, code: Uint8Array, orderId: string) {
    const response = await this.request("/api/contract/chainCallForBiz", {
      accessId: this.config.accessId,
      bizid: this.config.bizId,
      method: "DEPLOYWASMCONTRACT",
      contractCode: Buffer.from(code).toString("base64"),
      account: this.config.account,
      tenantid: this.config.tenantId,
      mykmsKeyId: this.config.kmsId,
      orderId,
      contractName,
      gas: 100_000_000,
    });
    if (!response.success) {
      throw new Error(`AntChain deployment was rejected (${response.code})`);
    }
    const hash = findTransactionHash(response.data);
    if (!hash) throw new Error("Deployment response has no transaction hash");
    return hash;
  }

  async call(
    contractName: string,
    methodSignature: string,
    values: string[],
    outputType: string | undefined,
    orderId: string,
  ) {
    const response = await this.request("/api/contract/chainCallForBiz", {
      accessId: this.config.accessId,
      bizid: this.config.bizId,
      account: this.config.account,
      contractName,
      methodSignature,
      isLocalTransaction: false,
      method: "CALLWASMCONTRACTASYNC",
      orderId,
      mykmsKeyId: this.config.kmsId,
      inputParamListStr: JSON.stringify(values),
      outTypes: outputType ? JSON.stringify([outputType]) : "[]",
      tenantid: this.config.tenantId,
      gas: 100_000_000,
      withGasHold: false,
    });
    if (!response.success) {
      throw new Error(`AntChain contract call was rejected (${response.code})`);
    }
    const hash = findTransactionHash(response.data);
    if (!hash) throw new Error("Contract response has no transaction hash");
    return hash;
  }

  async queryReceipt(hash: string): Promise<JsonRecord | undefined> {
    const response = await this.request("/api/contract/chainCall", {
      accessId: this.config.accessId,
      bizid: this.config.bizId,
      method: "QUERYRECEIPT",
      hash,
    });
    return parseRecord(response.data);
  }

  async latestBlock(): Promise<JsonRecord> {
    const response = await this.request("/api/contract/chainCall", {
      accessId: this.config.accessId,
      bizid: this.config.bizId,
      method: "QUERYLASTBLOCK",
    });
    if (!response.success) throw new Error("Latest block query failed");
    const data = parseRecord(response.data);
    const block = asRecord(data?.block);
    const header = asRecord(block?.blockHeader) ??
      asRecord(data?.blockHeader) ??
      data;
    if (!header) throw new Error("Latest block query has no header");
    return header;
  }
}

const resolution = await resolveAntChainLiveConfig();
console.log(JSON.stringify(resolution.report, null, 2));
if (!resolution.config) Deno.exit(2);
const config = resolution.config;
if (config.contractProfile !== "unified-myfish-v1") {
  console.error("Set ECO_ANTCHAIN_CONTRACT_PROFILE=unified-myfish-v1.");
  Deno.exit(2);
}
if (!resolution.report.liveWriteEnabled) {
  console.error(
    "Set RUN_ANTCHAIN_ECO_LABEL_LIVE=true after reviewing preflight.",
  );
  Deno.exit(3);
}

const contractName = config.ecoLabelRegistryName;
const identity = await contractIdentity(contractName);
const wasc = await Deno.readFile(
  "contracts/eco-label/unified-registry/dist/index.wasc",
);
const abi = await Deno.readTextFile(
  "contracts/eco-label/unified-registry/dist/index.abi",
);
const wascDigest = await sha256Bytes(wasc);
const abiDigest = await sha256Text(abi);
const profileCommitment = await sha256Text(JSON.stringify({
  restUrl: new URL(config.restUrl).origin,
  bizId: config.bizId,
  tenantId: config.tenantId,
  account: config.account,
  kmsId: config.kmsId,
  contractName,
  identity,
  wascDigest,
  abiDigest,
}));
const hashFor = async (name: string, configured?: string) =>
  configured || await sha256Text(`R-2026-001:${name}:unified-myfish-v1`);
const pilot = {
  labelId: config.pilotLabelId,
  taskId: config.pilotTaskId,
  inputHash: await hashFor("input", config.pilotInputHash),
  resultHash: await hashFor("result", config.pilotResultHash),
  evidenceHash: await hashFor("evidence", config.pilotEvidenceHash),
  authorizationHash: await hashFor(
    "authorization",
    config.pilotAuthorizationHash,
  ),
  proofHash: await hashFor("proof", config.pilotProofHash),
};
const evidenceDirectory = config.evidenceDirectory.replace(
  /eco-label-antchain-live$/,
  "eco-label-antchain-unified-live",
);
await Deno.mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
const evidencePath = `${evidenceDirectory}/evidence.json`;
const fresh: UnifiedEvidence = {
  schemaVersion: "eddl-antchain-unified-live-evidence/v1",
  assurance: "RESEARCH_TRIAL",
  status: "RUNNING",
  startedAt: new Date().toISOString(),
  target: {
    gatewayOrigin: new URL(config.restUrl).origin,
    profileCommitment,
    contractName,
    contractIdentity: identity,
    wascDigest,
    abiDigest,
  },
  release: {
    algorithmId: config.algorithmId,
    schemeId: config.schemeId,
    version: config.algorithmVersion,
    algorithmHash: config.algorithmHash,
    evaluatorHash: config.evaluatorHash,
  },
  pilot,
  intents: [],
  observations: {},
};
let evidence = fresh;
try {
  const stored = JSON.parse(
    await Deno.readTextFile(evidencePath),
  ) as UnifiedEvidence;
  if (
    stored.schemaVersion !== fresh.schemaVersion ||
    stored.target.profileCommitment !== profileCommitment ||
    JSON.stringify(stored.release) !== JSON.stringify(fresh.release) ||
    JSON.stringify(stored.pilot) !== JSON.stringify(fresh.pilot)
  ) {
    throw new Error("Stored evidence belongs to another target or release");
  }
  evidence = { ...stored, failure: undefined };
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
const persist = async () => {
  await Deno.writeTextFile(
    evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  await Deno.chmod(evidencePath, 0o600);
};
await persist();

try {
  const provider = new CloudCryptoRestProvider({
    restUrl: config.restUrl,
    bizid: config.bizId,
    accessId: config.accessId,
    accessSecret: config.accessSecret,
    account: config.account,
    tenantId: config.tenantId,
    kmsId: config.kmsId,
  });
  await provider.getToken();
  const account = await provider.queryAccount({ account: config.account });
  evidence.accountIdentity = normalizeIdentity(account.address);
  await persist();
  const gateway = new UnifiedGateway(provider, config);
  const contract = new WasmContract({ contractName, abi }, provider);
  const read = async <T>(
    methodName: string,
    args: string[],
    argsType: string[],
    returnType: string,
  ): Promise<T> =>
    (await contract.call<T>({
      methodName,
      args,
      argsType,
      returnType,
      local: true,
      tee: false,
      timeout: config.receiptTimeoutMs,
    })).returnValue;

  const ensureIntent = async (operation: string, request: JsonRecord) => {
    const requestCommitment = await sha256Text(JSON.stringify({
      schemaVersion: "eddl-antchain-unified-intent/v1",
      profileCommitment,
      operation,
      request,
    }));
    const existing = evidence.intents.find((item) =>
      item.operation === operation
    );
    if (existing) {
      if (existing.requestCommitment !== requestCommitment) {
        throw new Error(`${operation} conflicts with its frozen intent`);
      }
      return existing;
    }
    const intent: FrozenIntent = {
      operation,
      orderId: `eddl-unified-${requestCommitment.slice(7, 39)}`,
      requestCommitment,
      persistedAt: new Date().toISOString(),
      submissionCount: 0,
    };
    evidence.intents.push(intent);
    await persist();
    return intent;
  };

  const submitOnce = async (
    intent: FrozenIntent,
    dispatch: () => Promise<string>,
  ) => {
    if (intent.transactionHash) return intent.transactionHash;
    if (intent.submissionCount !== 0) {
      throw new Error(
        `${intent.operation} outcome is unknown; it will not be resubmitted`,
      );
    }
    intent.submissionCount = 1;
    intent.submittedAt = new Date().toISOString();
    await persist();
    const transactionHash = normalizeHash(await dispatch());
    intent.transactionHash = transactionHash;
    await persist();
    return transactionHash;
  };

  const observeIncluded = async (operation: string, hash: string) => {
    const deadline = Date.now() + config.receiptTimeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        const transaction = await provider.queryTransaction({ hash });
        const blockHeight = Number(transaction.blockNumber);
        const target = normalizeIdentity(transaction.to);
        if (!Number.isSafeInteger(blockHeight) || blockHeight <= 0) {
          throw new Error("transaction has no valid block height");
        }
        if (target !== identity) throw new Error("transaction target mismatch");
        const block = await provider.queryBlockHeader({
          blockNumber: blockHeight,
        });
        if (Number(block.number) !== blockHeight) {
          throw new Error("block mismatch");
        }
        const receipt = await gateway.queryReceipt(hash);
        const observation = {
          transactionHash: hash,
          blockHeight,
          blockHash: normalizeHash(block.hash),
          transactionTarget: target,
          receiptFlags: receipt
            ? {
              txFinish: receipt.txFinish,
              txSuccess: receipt.txSuccess,
              code: receipt.code,
              result: receipt.result,
              blockNumber: receipt.blockNumber,
            }
            : null,
          observedAt: new Date().toISOString(),
        };
        evidence.observations[operation] = observation;
        await persist();
        return observation;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw lastError ?? new Error(`${operation} was not observed in a block`);
  };

  let queriedContract: { code: string } | undefined;
  try {
    queriedContract = await provider.queryContract({ contractName });
  } catch {
    queriedContract = undefined;
  }
  if (!queriedContract) {
    const request = { contractName, identity, wascDigest, gas: 100_000_000 };
    const intent = await ensureIntent("deploy:UnifiedRegistry", request);
    const hash = await submitOnce(
      intent,
      () => gateway.deploy(contractName, wasc, intent.orderId),
    );
    await observeIncluded("deploy:UnifiedRegistry", hash);
    queriedContract = await provider.queryContract({ contractName });
  }
  if (!await chainCodeMatchesFrozenWasc(queriedContract.code, wascDigest)) {
    throw new Error("Unified registry chain code does not match frozen WASC");
  }
  evidence.observations.contractCode = { verified: true, wascDigest };
  await persist();

  const write = async (
    operation: string,
    methodName: string,
    values: string[],
    types: string[],
  ) => {
    const signature = `${methodName}(${types.join(",")})`;
    const intent = await ensureIntent(operation, {
      contractName,
      identity,
      methodSignature: signature,
      values,
      outputType: "string",
    });
    const hash = await submitOnce(
      intent,
      () =>
        gateway.call(contractName, signature, values, "string", intent.orderId),
    );
    return await observeIncluded(operation, hash);
  };

  const isAdmin = await read<boolean>(
    "hasRole",
    ["DEFAULT_ADMIN", evidence.accountIdentity!],
    ["string", "string"],
    "bool",
  ).catch(() => false);
  if (!isAdmin) await write("initialize:UnifiedRegistry", "initialize", [], []);
  if (
    !await read<boolean>(
      "hasRole",
      ["DEFAULT_ADMIN", evidence.accountIdentity!],
      ["string", "string"],
      "bool",
    )
  ) throw new Error("Unified registry initialization readback failed");

  const algorithmValues = [
    config.algorithmId,
    config.schemeId,
    config.algorithmVersion,
    config.algorithmHash,
    config.evaluatorHash,
  ];
  let algorithm = await read<string>(
    "getAlgorithm",
    [config.algorithmId],
    ["string"],
    "string",
  ).then(parseRecord).catch(() => undefined);
  if (!algorithm) {
    await write(
      "register:Algorithm",
      "registerAlgorithm",
      algorithmValues,
      ["string", "string", "string", "string", "string"],
    );
  }
  algorithm = parseRecord(
    await read<string>(
      "getAlgorithm",
      [config.algorithmId],
      ["string"],
      "string",
    ),
  );
  if (
    !algorithm || algorithm.schemeId !== config.schemeId ||
    algorithm.version !== config.algorithmVersion ||
    algorithm.algorithmHash !== config.algorithmHash ||
    algorithm.evaluatorHash !== config.evaluatorHash
  ) throw new Error("Rule readback does not match frozen release");
  if (algorithm.status !== "ACTIVE") {
    if (algorithm.status !== "DRAFT") {
      throw new Error(`Rule has unexpected status ${String(algorithm.status)}`);
    }
    await write(
      "activate:Algorithm",
      "setAlgorithmStatus",
      [config.algorithmId, "ACTIVE"],
      ["string", "string"],
    );
  }
  algorithm = parseRecord(
    await read<string>(
      "getAlgorithm",
      [config.algorithmId],
      ["string"],
      "string",
    ),
  );
  const activeId = await read<string>(
    "getActiveAlgorithmId",
    [config.schemeId],
    ["string"],
    "string",
  );
  const active = await read<string>(
    "isAlgorithmActive",
    [config.algorithmId, config.algorithmHash],
    ["string", "string"],
    "string",
  );
  if (
    algorithm?.status !== "ACTIVE" || activeId !== config.algorithmId ||
    active !== "1"
  ) {
    throw new Error("Atomic rule-state readback is not ACTIVE");
  }

  let label = await read<string>(
    "getLabel",
    [pilot.labelId],
    ["string"],
    "string",
  ).then(parseRecord).catch(() => undefined);
  if (!label) {
    await write(
      "issue:Label",
      "issueLabel",
      [
        pilot.labelId,
        pilot.taskId,
        config.algorithmId,
        config.algorithmHash,
        pilot.inputHash,
        pilot.resultHash,
        pilot.evidenceHash,
        pilot.authorizationHash,
        pilot.proofHash,
        "0",
      ],
      [
        "string",
        "string",
        "string",
        "string",
        "string",
        "string",
        "string",
        "string",
        "string",
        "uint64",
      ],
    );
  }
  label = parseRecord(
    await read<string>(
      "getLabel",
      [pilot.labelId],
      ["string"],
      "string",
    ),
  );
  const byTask = parseRecord(
    await read<string>(
      "getLabelByTaskId",
      [pilot.taskId],
      ["string"],
      "string",
    ),
  );
  const expectedLabel = {
    labelId: pilot.labelId,
    taskId: pilot.taskId,
    algorithmId: config.algorithmId,
    algorithmHash: config.algorithmHash,
    inputHash: pilot.inputHash,
    resultHash: pilot.resultHash,
    evidenceHash: pilot.evidenceHash,
    authorizationHash: pilot.authorizationHash,
    proofHash: pilot.proofHash,
    status: "ACTIVE",
  };
  for (const [field, value] of Object.entries(expectedLabel)) {
    if (label?.[field] !== value || byTask?.[field] !== value) {
      throw new Error(`Label double-read mismatch at ${field}`);
    }
  }
  if (JSON.stringify(label) !== JSON.stringify(byTask)) {
    throw new Error("labelId and taskId readbacks are not identical");
  }

  const issueObservation = asRecord(evidence.observations["issue:Label"]);
  const issueHeight = Number(issueObservation?.blockHeight);
  if (!Number.isSafeInteger(issueHeight) || issueHeight <= 0) {
    throw new Error("Issue transaction has no fixed block observation");
  }
  const deadline = Date.now() + config.receiptTimeoutMs;
  let laterHeader: JsonRecord | undefined;
  while (Date.now() <= deadline) {
    const candidate = await gateway.latestBlock();
    if (Number(candidate.number) > issueHeight) {
      laterHeader = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!laterHeader) throw new Error("No later block was available for recheck");
  const fixedBlock = await provider.queryBlockHeader({
    blockNumber: issueHeight,
  });
  if (normalizeHash(fixedBlock.hash) !== issueObservation?.blockHash) {
    throw new Error("Issue block hash changed during later-block recheck");
  }
  const algorithmAfter = parseRecord(
    await read<string>(
      "getAlgorithm",
      [config.algorithmId],
      ["string"],
      "string",
    ),
  );
  const labelAfter = parseRecord(
    await read<string>(
      "getLabel",
      [pilot.labelId],
      ["string"],
      "string",
    ),
  );
  if (JSON.stringify(algorithmAfter) !== JSON.stringify(algorithm)) {
    throw new Error("Rule state changed before later-block confirmation");
  }
  if (JSON.stringify(labelAfter) !== JSON.stringify(label)) {
    throw new Error("Label state changed before later-block confirmation");
  }
  evidence.observations.finalReadback = {
    contractCodeDigest: wascDigest,
    algorithm: algorithmAfter,
    activeAlgorithmId: activeId,
    algorithmActive: active,
    labelById: labelAfter,
    labelByTaskId: byTask,
    fixedIssueBlock: {
      height: issueHeight,
      hash: issueObservation?.blockHash,
    },
    laterBlock: {
      height: Number(laterHeader.number),
      hash: normalizeHash(String(laterHeader.hash)),
    },
    verification: "RESEARCH_STATE_CONFIRMED",
  };
  evidence.status = "RESEARCH_STATE_CONFIRMED";
  evidence.confirmedAt = new Date().toISOString();
  await persist();
  console.log(JSON.stringify(
    {
      status: evidence.status,
      contractName,
      contractIdentity: identity,
      labelId: pilot.labelId,
      taskId: pilot.taskId,
      evidencePath,
    },
    null,
    2,
  ));
} catch (error) {
  evidence.status = "BLOCKED";
  evidence.failure = safeFailure(error, config);
  await persist();
  console.error(JSON.stringify(evidence.failure, null, 2));
  Deno.exit(4);
}
