import { Buffer } from "node:buffer";
import {
  CloudCryptoRestProvider,
  WasmContract,
} from "npm:@antchain/jssdk@1.2.1";
import { ApiResponse } from "../deps.ts";
import {
  createLegacyAntChainReceiptNormalizer,
  findLegacyAntChainEventTimestamp,
  inferAntChainTimestampUnit,
} from "../eco/adapters/antchain-legacy-receipt.ts";
import {
  AntChainLiveConfig,
  resolveAntChainLiveConfig,
} from "../eco/adapters/antchain-live-config.ts";
import {
  AlgorithmMirrorSync,
  buildAlgorithmMirrorSync,
} from "../eco/adapters/antchain-algorithm-mirror.ts";
import {
  assessLiveTransactionClosure,
  createLiveTargetBinding,
  LiveClosureAssessment,
  LiveTargetBinding,
} from "../eco/adapters/antchain-live-evidence.ts";
import { chainCodeMatchesFrozenWasc } from "../eco/adapters/antchain-live-chain-code.ts";

type JsonRecord = Record<string, unknown>;
type TimestampUnit = "seconds" | "milliseconds";

interface OperationEvidence {
  operation: string;
  transactionHash: string;
  blockHeight: number;
  receipt: JsonRecord;
  transactionTarget?: string;
  readback?: unknown;
}

interface OperationIntent {
  operation: string;
  orderId: string;
  requestCommitment: string;
  persistedAt: string;
  submittedAt?: string;
  transactionHash?: string;
}

interface StateSatisfiedRecoveryEvidence {
  operation: string;
  disposition: "STATE_ALREADY_SATISFIED";
  requestCommitment: string;
  verifiedAt: string;
  transactionHash?: string;
  blockHeight?: number;
  transactionTarget?: string;
  blockHash?: string;
  readback: unknown;
}

interface LiveEvidence {
  schemaVersion: "eddl-antchain-live-evidence/v2";
  assurance: "RESEARCH_TRIAL";
  startedAt: string;
  completedAt?: string;
  target: LiveTargetBinding;
  release: unknown;
  artifacts: unknown;
  accountIdentity?: string;
  blockTimestampUnit?: TimestampUnit;
  contracts: Record<string, unknown>;
  intents: OperationIntent[];
  operations: OperationEvidence[];
  stateRecoveries: StateSatisfiedRecoveryEvidence[];
  algorithmMirror?: AlgorithmMirrorSync;
  closure?: LiveClosureAssessment;
  finalReadback?: unknown;
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
    throw new Error("Gateway did not return a valid 32-byte transaction hash");
  }
  return normalized.toLowerCase();
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
      const hash = findTransactionHash(item);
      if (hash) return hash;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["txHash", "transactionHash", "hash", "txData", "data"]) {
    const hash = findTransactionHash(record[key]);
    if (hash) return hash;
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

function safeFailure(error: unknown, config: AntChainLiveConfig) {
  const source = error instanceof Error ? error.message : String(error);
  const message = source
    .replaceAll(config.accessId, "<redacted-access-id>")
    .replaceAll(config.accessSecret, "<redacted-access-secret>");
  return {
    name: error instanceof Error ? error.name : "Error",
    message,
  };
}

class RawReceiptGateway {
  private token?: string;

  constructor(
    private readonly provider: CloudCryptoRestProvider,
    private readonly config: AntChainLiveConfig,
  ) {}

  private async request(
    path: string,
    body: JsonRecord,
    refresh = false,
  ): Promise<ApiResponse> {
    if (!this.token || refresh) this.token = await this.provider.getToken();
    const response = await fetch(new URL(path, this.config.restUrl), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.config.receiptTimeoutMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, token: this.token }),
    });
    const parsed = await response.json() as JsonRecord;
    if (String(parsed.code) === "202" && !refresh) {
      return await this.request(path, body, true);
    }
    return {
      success: response.ok && parsed.success === true &&
        ["0", "200"].includes(String(parsed.code)),
      code: typeof parsed.code === "string"
        ? parsed.code
        : String(parsed.code ?? response.status),
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      data: typeof parsed.data === "string"
        ? (parseRecord(parsed.data) ?? parsed.data)
        : parsed.data,
    };
  }

  async waitForFinalReceipt(hash: string): Promise<ApiResponse> {
    const deadline = Date.now() + this.config.receiptTimeoutMs;
    let last: ApiResponse | undefined;
    while (Date.now() <= deadline) {
      last = await this.request("/api/contract/chainCall", {
        accessId: this.config.accessId,
        bizid: this.config.bizId,
        method: "QUERYRECEIPT",
        hash,
      });
      const data = parseRecord(last.data);
      if (last.success && data?.txFinish === true) return last;
      if (!last.success && !["404", "414"].includes(String(last.code))) {
        throw new Error(
          `Receipt query failed with code ${String(last.code ?? "UNKNOWN")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const data = parseRecord(last?.data);
    throw new Error(
      `Timed out before AntChain returned txFinish=true (last txFinish=${
        String(data?.txFinish)
      })`,
    );
  }

  async queryLatestBlockHeader(): Promise<JsonRecord> {
    const response = await this.request("/api/contract/chainCall", {
      accessId: this.config.accessId,
      bizid: this.config.bizId,
      method: "QUERYLASTBLOCK",
    });
    if (!response.success) {
      throw new Error(
        `Latest block query failed with code ${
          String(response.code ?? "UNKNOWN")
        }`,
      );
    }
    const data = parseRecord(response.data);
    const block = asRecord(data?.block);
    const header = asRecord(block?.blockHeader) ??
      asRecord(data?.blockHeader) ??
      data;
    if (!header) throw new Error("Latest block query has no block header");
    return header;
  }

  async deployWasm(input: {
    contractName: string;
    code: Uint8Array;
    orderId: string;
  }): Promise<string> {
    const response = await this.request("/api/contract/chainCallForBiz", {
      accessId: this.config.accessId,
      bizid: this.config.bizId,
      method: "DEPLOYWASMCONTRACT",
      contractCode: Buffer.from(input.code).toString("base64"),
      account: this.config.account,
      tenantid: this.config.tenantId,
      mykmsKeyId: this.config.kmsId,
      orderId: input.orderId,
      contractName: input.contractName,
      gas: 100_000_000,
    });
    if (!response.success) {
      throw new Error(
        `AntChain deployment request failed with code ${
          String(response.code ?? "UNKNOWN")
        }`,
      );
    }
    const hash = findTransactionHash(response.data);
    if (!hash) throw new Error("Deployment response has no transaction hash");
    return hash;
  }

  async callWasm(input: {
    contractName: string;
    methodSignature: string;
    values: string[];
    outputType?: string;
    orderId: string;
  }): Promise<string> {
    const response = await this.request("/api/contract/chainCallForBiz", {
      accessId: this.config.accessId,
      bizid: this.config.bizId,
      account: this.config.account,
      contractName: input.contractName,
      methodSignature: input.methodSignature,
      isLocalTransaction: false,
      method: "CALLWASMCONTRACTASYNC",
      orderId: input.orderId,
      mykmsKeyId: this.config.kmsId,
      inputParamListStr: JSON.stringify(input.values),
      outTypes: input.outputType ? `["${input.outputType}"]` : "[]",
      tenantid: this.config.tenantId,
      gas: 100_000_000,
      withGasHold: false,
    });
    if (!response.success) {
      throw new Error(
        `AntChain contract request failed with code ${
          String(response.code ?? "UNKNOWN")
        }`,
      );
    }
    const hash = findTransactionHash(response.data);
    if (!hash) throw new Error("Contract response has no transaction hash");
    return hash;
  }
}

function rawReceiptData(response: ApiResponse): JsonRecord {
  const data = parseRecord(response.data);
  if (!data || data.txFinish !== true || data.txSuccess !== true) {
    throw new Error("Receipt is not terminal and successful");
  }
  if (data.code !== 0 || data.result !== 0) {
    throw new Error(
      `Contract execution failed (code=${String(data.code)}, result=${
        String(data.result)
      })`,
    );
  }
  if (
    typeof data.blockNumber !== "number" ||
    !Number.isSafeInteger(data.blockNumber) || data.blockNumber < 0
  ) {
    throw new Error("Final receipt does not contain a valid block number");
  }
  normalizeHash(String(data.hash ?? ""));
  return data;
}

async function contractIdentity(contractName: string): Promise<string> {
  return (await sha256Text(contractName)).slice(7);
}

function normalizeIdentity(value: string): string {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("AntChain identity is not 64 hexadecimal characters");
  }
  return normalized.toLowerCase();
}

function timestampMillis(value: string | number, unit: TimestampUnit): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new Error("Invalid block timestamp");
  }
  return unit === "seconds" ? numeric * 1_000 : numeric;
}

function recordMatches(
  actual: JsonRecord | undefined,
  expected: object,
): boolean {
  return Boolean(
    actual &&
      Object.entries(expected).every(([field, value]) =>
        actual[field] === value
      ),
  );
}

function isNotFound(error: unknown): boolean {
  const code = asRecord(error)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return ["404", "10750"].includes(String(code)) ||
    /not[ _-]?found|不存在|查询无结果/i.test(message);
}

const resolution = await resolveAntChainLiveConfig();
console.log(JSON.stringify(resolution.report, null, 2));
if (!resolution.config) Deno.exit(2);
if (resolution.config.contractProfile === "unified-myfish-v1") {
  console.error(
    "The unified Myfish profile must use `deno task contracts:run-unified-live`.",
  );
  Deno.exit(3);
}
if (!resolution.report.liveWriteEnabled) {
  console.error(
    "Live writes are disabled. Set RUN_ANTCHAIN_ECO_LABEL_LIVE=true after reviewing the preflight target.",
  );
  Deno.exit(3);
}
const config = resolution.config;
await Deno.mkdir(config.evidenceDirectory, { recursive: true });
const evidencePath = `${config.evidenceDirectory}/evidence.json`;
const liveTarget = await createLiveTargetBinding({
  restUrl: config.restUrl,
  bizId: config.bizId,
  tenantId: config.tenantId,
  account: config.account,
  kmsId: config.kmsId,
});
const freshEvidence: LiveEvidence = {
  schemaVersion: "eddl-antchain-live-evidence/v2",
  assurance: "RESEARCH_TRIAL",
  startedAt: new Date().toISOString(),
  target: liveTarget,
  release: resolution.report.release,
  artifacts: resolution.report.artifacts,
  contracts: {},
  intents: [],
  operations: [],
  stateRecoveries: [],
};
let evidence = freshEvidence;
try {
  const stored = JSON.parse(
    await Deno.readTextFile(evidencePath),
  ) as LiveEvidence;
  if (
    stored.schemaVersion !== freshEvidence.schemaVersion ||
    stored.target.protocol !== freshEvidence.target.protocol ||
    stored.target.host !== freshEvidence.target.host ||
    stored.target.port !== freshEvidence.target.port ||
    stored.target.profileCommitment !== freshEvidence.target.profileCommitment
  ) {
    throw new Error(
      "Stored AntChain evidence belongs to another schema or target",
    );
  }
  evidence = {
    ...stored,
    release: freshEvidence.release,
    artifacts: freshEvidence.artifacts,
    failure: undefined,
    completedAt: undefined,
    closure: undefined,
    intents: Array.isArray(stored.intents) ? stored.intents : [],
    operations: Array.isArray(stored.operations) ? stored.operations : [],
    stateRecoveries: Array.isArray(stored.stateRecoveries)
      ? stored.stateRecoveries
      : [],
  };
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) {
    throw error;
  }
}
const persist = async () => {
  await Deno.writeTextFile(
    evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
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
  // A successful handshake and account query proves that the access key,
  // tenant, business chain, account and KMS binding are mutually usable.
  await provider.getToken();
  const account = await provider.queryAccount({ account: config.account });
  const accountIdentity = normalizeIdentity(account.address);
  evidence.accountIdentity = accountIdentity;

  const algorithmIdentity = await contractIdentity(
    config.algorithmRegistryName,
  );
  const labelIdentity = await contractIdentity(config.ecoLabelRegistryName);
  const algorithmAbi = await Deno.readTextFile(
    "contracts/eco-label/algorithm-registry/dist/index.abi",
  );
  const labelAbi = await Deno.readTextFile(
    "contracts/eco-label/eco-label-registry/dist/index.abi",
  );
  const algorithmWasc = await Deno.readFile(
    "contracts/eco-label/algorithm-registry/dist/index.wasc",
  );
  const labelWasc = await Deno.readFile(
    "contracts/eco-label/eco-label-registry/dist/index.wasc",
  );
  const algorithmDigest = await sha256Bytes(algorithmWasc);
  const labelDigest = await sha256Bytes(labelWasc);
  const algorithmContract = new WasmContract({
    contractName: config.algorithmRegistryName,
    abi: algorithmAbi,
  }, provider);
  const labelContract = new WasmContract({
    contractName: config.ecoLabelRegistryName,
    abi: labelAbi,
  }, provider);
  const rawGateway = new RawReceiptGateway(provider, config);

  const ensureIntent = async (
    operation: string,
    request: JsonRecord,
  ): Promise<OperationIntent> => {
    const requestCommitment = await sha256Text(JSON.stringify({
      schemaVersion: "eddl-antchain-operation-intent/v1",
      operation,
      targetProfileCommitment: evidence.target.profileCommitment,
      request,
    }));
    const existing = evidence.intents.find((intent) =>
      intent.operation === operation
    );
    if (existing) {
      if (existing.requestCommitment !== requestCommitment) {
        throw new Error(
          `${operation} recovery intent conflicts with the frozen request`,
        );
      }
      return existing;
    }
    const intent: OperationIntent = {
      operation,
      orderId: `eddl-${requestCommitment.slice(7, 39)}`,
      requestCommitment,
      persistedAt: new Date().toISOString(),
    };
    evidence.intents.push(intent);
    await persist();
    return intent;
  };

  const markSubmitted = async (
    intent: OperationIntent,
    transactionHash: string,
  ) => {
    const normalized = normalizeHash(transactionHash);
    if (intent.transactionHash && intent.transactionHash !== normalized) {
      throw new Error(
        `${intent.operation} stable order id returned a different transaction hash`,
      );
    }
    intent.transactionHash = normalized;
    intent.submittedAt = intent.submittedAt ?? new Date().toISOString();
    await persist();
  };

  const operationAccountedFor = (operation: string): boolean =>
    evidence.operations.some((item) => item.operation === operation) ||
    evidence.stateRecoveries.some((item) => item.operation === operation);

  const needsRecovery = (operation: string): boolean =>
    evidence.intents.some((intent) => intent.operation === operation) &&
    !operationAccountedFor(operation);

  const contractWriteRequest = (
    contract: WasmContract,
    identity: string,
    methodName: string,
    args: string[],
    argsType: string[],
    returnType?: string,
  ): JsonRecord => ({
    contractName: contract.contractName,
    contractIdentity: identity,
    methodSignature: `${methodName}(${argsType.join(",")})`,
    values: args,
    outputType: returnType ?? null,
  });

  const recoverSatisfiedIntent = async (
    operation: string,
    request: JsonRecord,
    readback: unknown,
  ): Promise<boolean> => {
    const existingIntent = evidence.intents.find((intent) =>
      intent.operation === operation
    );
    if (!existingIntent) return false;
    const intent = await ensureIntent(operation, request);
    if (evidence.operations.some((item) => item.operation === operation)) {
      return true;
    }
    const existingRecovery = evidence.stateRecoveries.find((item) =>
      item.operation === operation
    );
    if (existingRecovery) return true;
    let transactionContext: Pick<
      StateSatisfiedRecoveryEvidence,
      "transactionHash" | "blockHeight" | "transactionTarget" | "blockHash"
    > = {};
    if (intent.transactionHash) {
      const transactionHash = normalizeHash(intent.transactionHash);
      const transaction = await provider.queryTransaction({
        hash: transactionHash,
      });
      const transactionTarget = normalizeIdentity(transaction.to);
      const expectedTarget = typeof request.contractIdentity === "string"
        ? normalizeIdentity(request.contractIdentity)
        : undefined;
      if (expectedTarget && transactionTarget !== expectedTarget) {
        throw new Error(
          `${operation} recovered transaction target does not match the frozen request`,
        );
      }
      const blockHeight = Number(transaction.blockNumber);
      if (!Number.isSafeInteger(blockHeight) || blockHeight < 0) {
        throw new Error(
          `${operation} recovered transaction is not included in a valid block`,
        );
      }
      const block = await provider.queryBlockHeader({
        blockNumber: blockHeight,
      });
      if (Number(block.number) !== blockHeight) {
        throw new Error(
          `${operation} recovered transaction block header does not match`,
        );
      }
      transactionContext = {
        transactionHash,
        blockHeight,
        transactionTarget,
        blockHash: normalizeHash(block.hash),
      };
    }
    evidence.stateRecoveries.push({
      operation,
      disposition: "STATE_ALREADY_SATISFIED",
      requestCommitment: intent.requestCommitment,
      verifiedAt: new Date().toISOString(),
      ...transactionContext,
      readback,
    });
    await persist();
    return true;
  };

  const saveOperation = async (
    operation: string,
    txHash: string,
    receiptResponse: ApiResponse,
    readback?: unknown,
  ) => {
    const receipt = rawReceiptData(receiptResponse);
    const tx = await provider.queryTransaction({ hash: txHash });
    const operationEvidence: OperationEvidence = {
      operation,
      transactionHash: normalizeHash(txHash),
      blockHeight: receipt.blockNumber as number,
      receipt,
      transactionTarget: normalizeIdentity(tx.to),
      readback,
    };
    const existingIndex = evidence.operations.findIndex((item) =>
      item.operation === operation
    );
    if (existingIndex >= 0) {
      if (
        evidence.operations[existingIndex].transactionHash !==
          operationEvidence.transactionHash
      ) {
        throw new Error(`${operation} has conflicting final transactions`);
      }
      evidence.operations[existingIndex] = operationEvidence;
    } else {
      evidence.operations.push(operationEvidence);
    }
    await persist();
  };

  const ensureContract = async (
    role: "AlgorithmRegistry" | "EcoLabelRegistry",
    contract: WasmContract,
    identity: string,
    wasc: Uint8Array,
    wascDigest: string,
  ) => {
    const operation = `deploy:${role}`;
    const deploymentRequest: JsonRecord = {
      contractName: contract.contractName,
      contractIdentity: identity,
      wascDigest,
      gas: 100_000_000,
      tee: false,
    };
    let existing: { code: string } | undefined;
    try {
      existing = await provider.queryContract({
        contractName: contract.contractName,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (existing) {
      if (!await chainCodeMatchesFrozenWasc(existing.code, wascDigest)) {
        throw new Error(`${role} chain code does not match the frozen WASC`);
      }
      let recordedDeployment = operationAccountedFor(operation);
      const pendingIntent = evidence.intents.find((intent) =>
        intent.operation === operation
      );
      if (!recordedDeployment && pendingIntent) {
        recordedDeployment = await recoverSatisfiedIntent(
          operation,
          deploymentRequest,
          {
            contractName: contract.contractName,
            contractIdentity: identity,
            chainCodeMatchesRelease: true,
            wascDigest,
            receiptFinality: pendingIntent.transactionHash
              ? "PROVIDER_FLAGS_NOT_FINAL"
              : "NO_TRANSACTION_REFERENCE",
          },
        );
      }
      if (!config.allowExistingContracts && !recordedDeployment) {
        throw new Error(
          `${role} already exists; set ECO_ANTCHAIN_ALLOW_EXISTING=true only after checking the stored deployment evidence`,
        );
      }
    } else {
      const existingIntent = evidence.intents.find((intent) =>
        intent.operation === operation
      );
      const intent = await ensureIntent(operation, deploymentRequest);
      if (existingIntent && !intent.transactionHash) {
        throw new Error(
          `${operation} outcome is unknown; do not resubmit the persisted deployment intent`,
        );
      }
      const txHash = intent.transactionHash ?? await rawGateway.deployWasm({
        contractName: contract.contractName,
        code: wasc,
        orderId: intent.orderId,
      });
      await markSubmitted(intent, txHash);
      const receipt = await rawGateway.waitForFinalReceipt(txHash);
      rawReceiptData(receipt);
      const queried = await provider.queryContract({
        contractName: contract.contractName,
      });
      if (!await chainCodeMatchesFrozenWasc(queried.code, wascDigest)) {
        throw new Error(
          `${role} independent query does not match the deployed WASC digest`,
        );
      }
      await saveOperation(operation, txHash, receipt, {
        deployedCodeDigest: wascDigest,
      });
    }
    evidence.contracts[role] = {
      name: contract.contractName,
      identity,
      wascDigest,
      independentlyQueried: true,
    };
    await persist();
  };

  await ensureContract(
    "AlgorithmRegistry",
    algorithmContract,
    algorithmIdentity,
    algorithmWasc,
    algorithmDigest,
  );
  await ensureContract(
    "EcoLabelRegistry",
    labelContract,
    labelIdentity,
    labelWasc,
    labelDigest,
  );

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

  let verifiedUnit: TimestampUnit | undefined = config.blockTimestampUnit ===
      "auto"
    ? undefined
    : config.blockTimestampUnit;

  const verifyTimestamp = async (
    response: ApiResponse,
    eventName: string,
    identity: string,
  ) => {
    const timestamp = findLegacyAntChainEventTimestamp(
      response,
      eventName,
      identity,
    );
    if (!timestamp) throw new Error(`${eventName} lacks a block timestamp`);
    const inferred = inferAntChainTimestampUnit(timestamp);
    if (!inferred) throw new Error("Could not infer contract timestamp unit");
    if (verifiedUnit && inferred !== verifiedUnit) {
      throw new Error("Contract timestamp contradicts the pinned unit");
    }
    const data = rawReceiptData(response);
    const header = await provider.queryBlockHeader({
      blockNumber: data.blockNumber as number,
    });
    const headerUnit = inferAntChainTimestampUnit(header.timestamp);
    if (!headerUnit) {
      throw new Error("Could not infer block-header timestamp unit");
    }
    const eventMillis = timestampMillis(timestamp, inferred);
    const headerMillis = timestampMillis(header.timestamp, headerUnit);
    if (Math.abs(eventMillis - headerMillis) > 60_000) {
      throw new Error(
        "Contract event timestamp does not match its block header",
      );
    }
    verifiedUnit = inferred;
    evidence.blockTimestampUnit = inferred;
    await persist();
  };

  const write = async (
    operation: string,
    contract: WasmContract,
    identity: string,
    methodName: string,
    args: string[],
    argsType: string[],
    returnType?: string,
    expectedEvent?: string,
  ): Promise<void> => {
    const methodSignature = `${methodName}(${argsType.join(",")})`;
    const existingIntent = evidence.intents.find((intent) =>
      intent.operation === operation
    );
    const intent = await ensureIntent(
      operation,
      contractWriteRequest(
        contract,
        identity,
        methodName,
        args,
        argsType,
        returnType,
      ),
    );
    if (existingIntent && !intent.transactionHash) {
      throw new Error(
        `${operation} outcome is unknown; do not resubmit the persisted contract-write intent`,
      );
    }
    const txHash = intent.transactionHash ?? await rawGateway.callWasm({
      contractName: contract.contractName,
      methodSignature,
      values: args,
      outputType: returnType,
      orderId: intent.orderId,
    });
    await markSubmitted(intent, txHash);
    const receipt = await rawGateway.waitForFinalReceipt(txHash);
    rawReceiptData(receipt);
    const transaction = await provider.queryTransaction({
      hash: txHash,
    });
    if (normalizeIdentity(transaction.to) !== identity) {
      throw new Error(
        `${operation} transaction target does not match the contract identity`,
      );
    }
    if (expectedEvent) {
      await verifyTimestamp(receipt, expectedEvent, identity);
      const normalizer = createLegacyAntChainReceiptNormalizer({
        algorithmRegistry: {
          name: config.algorithmRegistryName,
          identity: algorithmIdentity,
        },
        ecoLabelRegistry: {
          name: config.ecoLabelRegistryName,
          identity: labelIdentity,
        },
        blockTimestampUnit: verifiedUnit!,
      });
      const normalized = normalizer(receipt);
      if (
        normalized.state !== "CONFIRMED" ||
        normalized.eventName !== expectedEvent ||
        JSON.stringify(normalized.inputValues) !== JSON.stringify(args)
      ) {
        throw new Error(
          `${operation} final event or input payload does not match`,
        );
      }
    }
    await saveOperation(operation, txHash, receipt);
  };

  const algorithmAdmin = await read<boolean>(
    algorithmContract,
    "hasRole",
    ["DEFAULT_ADMIN", accountIdentity],
    ["string", "string"],
    "bool",
  ).catch(() => false);
  if (algorithmAdmin) {
    await recoverSatisfiedIntent(
      "initialize:AlgorithmRegistry",
      contractWriteRequest(
        algorithmContract,
        algorithmIdentity,
        "initialize",
        [],
        [],
      ),
      { defaultAdmin: accountIdentity, initialized: true },
    );
  }
  if (!algorithmAdmin || needsRecovery("initialize:AlgorithmRegistry")) {
    await write(
      "initialize:AlgorithmRegistry",
      algorithmContract,
      algorithmIdentity,
      "initialize",
      [],
      [],
    );
  }
  const confirmedAlgorithmAdmin = await read<boolean>(
    algorithmContract,
    "hasRole",
    ["DEFAULT_ADMIN", accountIdentity],
    ["string", "string"],
    "bool",
  );
  if (!confirmedAlgorithmAdmin) {
    throw new Error("AlgorithmRegistry initialization readback failed");
  }

  const labelAdmin = await read<boolean>(
    labelContract,
    "hasRole",
    ["DEFAULT_ADMIN", accountIdentity],
    ["string", "string"],
    "bool",
  ).catch(() => false);
  let labelBindingBeforeInitialization: string | undefined;
  if (labelAdmin) {
    labelBindingBeforeInitialization = normalizeIdentity(
      await read<string>(
        labelContract,
        "getAlgorithmRegistryContractId",
        [],
        [],
        "string",
      ),
    );
    if (labelBindingBeforeInitialization !== algorithmIdentity) {
      throw new Error(
        "Existing EcoLabelRegistry initialization has an unexpected AlgorithmRegistry binding",
      );
    }
    await recoverSatisfiedIntent(
      "initialize:EcoLabelRegistry",
      contractWriteRequest(
        labelContract,
        labelIdentity,
        "initialize",
        [algorithmIdentity],
        ["string"],
      ),
      {
        defaultAdmin: accountIdentity,
        algorithmRegistryIdentity: labelBindingBeforeInitialization,
        initialized: true,
      },
    );
  }
  if (!labelAdmin || needsRecovery("initialize:EcoLabelRegistry")) {
    await write(
      "initialize:EcoLabelRegistry",
      labelContract,
      labelIdentity,
      "initialize",
      [algorithmIdentity],
      ["string"],
    );
  }
  const confirmedLabelAdmin = await read<boolean>(
    labelContract,
    "hasRole",
    ["DEFAULT_ADMIN", accountIdentity],
    ["string", "string"],
    "bool",
  );
  if (!confirmedLabelAdmin) {
    throw new Error("EcoLabelRegistry initialization readback failed");
  }
  const boundAlgorithmRegistryIdentity = normalizeIdentity(
    await read<string>(
      labelContract,
      "getAlgorithmRegistryContractId",
      [],
      [],
      "string",
    ),
  );
  if (boundAlgorithmRegistryIdentity !== algorithmIdentity) {
    throw new Error(
      "EcoLabelRegistry is bound to an unexpected AlgorithmRegistry identity",
    );
  }
  const algorithmCodeAfterBinding = await provider.queryContract({
    contractName: config.algorithmRegistryName,
  });
  const algorithmCodeMatchesRelease = await chainCodeMatchesFrozenWasc(
    algorithmCodeAfterBinding.code,
    algorithmDigest,
  );
  if (!algorithmCodeMatchesRelease) {
    throw new Error(
      "Bound AlgorithmRegistry chain code does not match the frozen WASC",
    );
  }

  let algorithm: JsonRecord | undefined;
  try {
    algorithm = parseRecord(
      await read<string>(
        algorithmContract,
        "getAlgorithm",
        [config.algorithmId],
        ["string"],
        "string",
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const algorithmValues = [
    config.algorithmId,
    config.schemeId,
    config.algorithmVersion,
    config.algorithmHash,
    config.evaluatorHash,
  ];
  const algorithmMatchesRelease = Boolean(
    algorithm && algorithm.schemeId === config.schemeId &&
      algorithm.version === config.algorithmVersion &&
      algorithm.algorithmHash === config.algorithmHash &&
      algorithm.evaluatorHash === config.evaluatorHash,
  );
  if (algorithmMatchesRelease) {
    await recoverSatisfiedIntent(
      "register:Algorithm",
      contractWriteRequest(
        algorithmContract,
        algorithmIdentity,
        "registerAlgorithm",
        algorithmValues,
        ["string", "string", "string", "string", "string"],
        "string",
      ),
      { algorithm, registrationMatchesRelease: true },
    );
  }
  if (!algorithm || needsRecovery("register:Algorithm")) {
    await write(
      "register:Algorithm",
      algorithmContract,
      algorithmIdentity,
      "registerAlgorithm",
      algorithmValues,
      ["string", "string", "string", "string", "string"],
      "string",
      "AlgorithmRegistered",
    );
  }
  algorithm = parseRecord(
    await read<string>(
      algorithmContract,
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
  ) {
    throw new Error(
      "AlgorithmRegistry independent readback does not match the release",
    );
  }
  if (algorithm.status === "ACTIVE") {
    const activeIdForRecovery = await read<string>(
      algorithmContract,
      "getActiveAlgorithmId",
      [config.schemeId],
      ["string"],
      "string",
    );
    const activeStateForRecovery = await read<string>(
      algorithmContract,
      "isAlgorithmActive",
      [config.algorithmId, config.algorithmHash],
      ["string", "string"],
      "string",
    );
    if (
      activeIdForRecovery === config.algorithmId &&
      activeStateForRecovery === "1"
    ) {
      await recoverSatisfiedIntent(
        "activate:Algorithm",
        contractWriteRequest(
          algorithmContract,
          algorithmIdentity,
          "setAlgorithmStatus",
          [config.algorithmId, "ACTIVE"],
          ["string", "string"],
          "string",
        ),
        {
          activeAlgorithmId: activeIdForRecovery,
          algorithmActiveState: activeStateForRecovery,
          algorithmHash: config.algorithmHash,
        },
      );
    }
  }
  if (
    algorithm.status !== "ACTIVE" || needsRecovery("activate:Algorithm")
  ) {
    if (
      algorithm.status !== "DRAFT" &&
      !needsRecovery("activate:Algorithm")
    ) {
      throw new Error(
        `Research algorithm has unexpected status ${String(algorithm.status)}`,
      );
    }
    await write(
      "activate:Algorithm",
      algorithmContract,
      algorithmIdentity,
      "setAlgorithmStatus",
      [config.algorithmId, "ACTIVE"],
      ["string", "string"],
      "string",
      "AlgorithmStatusChanged",
    );
  }
  algorithm = parseRecord(
    await read<string>(
      algorithmContract,
      "getAlgorithm",
      [config.algorithmId],
      ["string"],
      "string",
    ),
  );
  if (
    !algorithm || algorithm.status !== "ACTIVE" ||
    algorithm.schemeId !== config.schemeId ||
    algorithm.version !== config.algorithmVersion ||
    algorithm.algorithmHash !== config.algorithmHash ||
    algorithm.evaluatorHash !== config.evaluatorHash
  ) {
    throw new Error(
      "Activated AlgorithmRegistry state does not match the frozen release",
    );
  }
  const activeAlgorithmId = await read<string>(
    algorithmContract,
    "getActiveAlgorithmId",
    [config.schemeId],
    ["string"],
    "string",
  );
  if (activeAlgorithmId !== config.algorithmId) {
    throw new Error(
      "Active algorithm readback does not match the research release",
    );
  }
  const algorithmActiveState = await read<string>(
    algorithmContract,
    "isAlgorithmActive",
    [config.algorithmId, config.algorithmHash],
    ["string", "string"],
    "string",
  );
  if (algorithmActiveState !== "1") {
    throw new Error(
      "AlgorithmRegistry does not confirm the pinned algorithm id and hash as active",
    );
  }

  const buildFreshAlgorithmMirror = async (): Promise<AlgorithmMirrorSync> => {
    const readAlgorithmState = async () => ({
      algorithm: parseRecord(
        await read<string>(
          algorithmContract,
          "getAlgorithm",
          [config.algorithmId],
          ["string"],
          "string",
        ),
      ),
      activeAlgorithmId: await read<string>(
        algorithmContract,
        "getActiveAlgorithmId",
        [config.schemeId],
        ["string"],
        "string",
      ),
      algorithmActiveState: await read<string>(
        algorithmContract,
        "isAlgorithmActive",
        [config.algorithmId, config.algorithmHash],
        ["string", "string"],
        "string",
      ),
    });
    const recentWriteBlockHeight = Math.max(
      0,
      ...evidence.operations.map((item) => item.blockHeight),
      ...evidence.stateRecoveries.map((item) => item.blockHeight ?? 0),
    );
    const queryAnchor = async (): Promise<{
      header: JsonRecord;
      observationMode:
        | "LATEST_BLOCK_STABLE_WINDOW"
        | "RECENT_WRITE_ANCHOR_DOUBLE_READ";
    }> => {
      if (recentWriteBlockHeight <= 0) {
        throw new Error(
          "No verified recent write can anchor the AlgorithmRegistry observation",
        );
      }
      return {
        header: asRecord(
          await provider.queryBlockHeader({
            blockNumber: recentWriteBlockHeight,
          }),
        ) ?? {},
        observationMode: "RECENT_WRITE_ANCHOR_DOUBLE_READ",
      };
    };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const beforeState = await readAlgorithmState();
      const beforeAnchor = await queryAnchor();
      const afterState = await readAlgorithmState();
      const afterAnchor = await queryAnchor();
      const before = beforeAnchor.header;
      const after = afterAnchor.header;
      const beforeHeight = Number(before.number);
      const afterHeight = Number(after.number);
      const beforeHash = normalizeHash(String(before.hash ?? ""));
      const afterHash = normalizeHash(String(after.hash ?? ""));
      if (
        beforeAnchor.observationMode !== afterAnchor.observationMode ||
        beforeHeight !== afterHeight || beforeHash !== afterHash ||
        JSON.stringify(beforeState) !== JSON.stringify(afterState)
      ) continue;
      if (!Number.isSafeInteger(afterHeight) || afterHeight <= 0) {
        throw new Error("Algorithm mirror source block height is invalid");
      }
      const timestamp = Number(after.timestamp);
      const timestampUnit = inferAntChainTimestampUnit(timestamp);
      if (!timestampUnit) {
        throw new Error("Algorithm mirror source block timestamp is invalid");
      }
      if (
        config.blockTimestampUnit !== "auto" &&
        config.blockTimestampUnit !== timestampUnit
      ) {
        throw new Error(
          "Algorithm mirror source block contradicts the pinned timestamp unit",
        );
      }
      if (verifiedUnit && verifiedUnit !== timestampUnit) {
        throw new Error(
          "Algorithm mirror source block contradicts prior timestamp evidence",
        );
      }
      verifiedUnit = timestampUnit;
      evidence.blockTimestampUnit = timestampUnit;
      await persist();
      return await buildAlgorithmMirrorSync({
        algorithmRegistryIdentity: algorithmIdentity,
        algorithmReadback: afterState.algorithm ?? {},
        activeAlgorithmId: afterState.activeAlgorithmId,
        algorithmActiveState: afterState.algorithmActiveState,
        sourceBlockHeight: afterHeight,
        sourceBlockHash: afterHash,
        sourceBlockTimestamp: timestamp,
        timestampUnit,
        observationMode: afterAnchor.observationMode,
        validityMs: 86_400_000,
      });
    }
    throw new Error(
      "Could not anchor AlgorithmRegistry readback within one stable block",
    );
  };

  const restoreAlgorithmMirror = async (
    stored: AlgorithmMirrorSync,
  ): Promise<AlgorithmMirrorSync> => {
    const snapshot = stored.snapshot;
    const timestamp = Number(snapshot.sourceBlock.timestamp);
    const validUntil = Number(stored.validUntil);
    const validityMs = (validUntil - timestamp) *
      (snapshot.sourceBlock.timestampUnit === "seconds" ? 1_000 : 1);
    const rebuilt = await buildAlgorithmMirrorSync({
      algorithmRegistryIdentity: snapshot.algorithmRegistryIdentity,
      algorithmReadback: snapshot.algorithm as unknown as JsonRecord,
      activeAlgorithmId: snapshot.activeAlgorithmId,
      algorithmActiveState: snapshot.algorithmActiveState,
      sourceBlockHeight: Number(snapshot.sourceBlock.height),
      sourceBlockHash: snapshot.sourceBlock.hash,
      sourceBlockTimestamp: timestamp,
      timestampUnit: snapshot.sourceBlock.timestampUnit,
      observationMode: snapshot.sourceBlock.observationMode,
      validityMs,
    });
    if (
      rebuilt.sourceStateHash !== stored.sourceStateHash ||
      rebuilt.canonicalSnapshot !== stored.canonicalSnapshot ||
      JSON.stringify(rebuilt.values) !== JSON.stringify(stored.values)
    ) {
      throw new Error(
        "Stored algorithm mirror snapshot is not self-consistent",
      );
    }
    if (
      !recordMatches(algorithm, snapshot.algorithm) ||
      activeAlgorithmId !== snapshot.activeAlgorithmId ||
      algorithmActiveState !== snapshot.algorithmActiveState
    ) {
      throw new Error(
        "AlgorithmRegistry changed after the frozen mirror intent was recorded",
      );
    }
    const sourceHeader = asRecord(
      await provider.queryBlockHeader({
        blockNumber: Number(snapshot.sourceBlock.height),
      }),
    );
    if (
      !sourceHeader ||
      Number(sourceHeader.number) !== Number(snapshot.sourceBlock.height) ||
      normalizeHash(String(sourceHeader.hash ?? "")) !==
        snapshot.sourceBlock.hash ||
      String(sourceHeader.timestamp) !== snapshot.sourceBlock.timestamp
    ) {
      throw new Error(
        "Stored algorithm mirror source block no longer matches independent readback",
      );
    }
    const latestUnit: TimestampUnit = snapshot.sourceBlock.timestampUnit;
    const latestTimestamp = latestUnit === "seconds"
      ? Math.floor(Date.now() / 1_000)
      : Date.now();
    if (Number(stored.validUntil) <= latestTimestamp) {
      throw new Error(
        "Stored algorithm mirror intent expired; do not silently replace it",
      );
    }
    verifiedUnit = latestUnit;
    evidence.blockTimestampUnit = latestUnit;
    await persist();
    return rebuilt;
  };

  if (!evidence.algorithmMirror && config.priorMirrorEvidencePath) {
    const priorEvidence = parseRecord(
      JSON.parse(await Deno.readTextFile(config.priorMirrorEvidencePath)),
    );
    const priorMirror = asRecord(priorEvidence?.algorithmMirror);
    if (!priorMirror) {
      throw new Error(
        "Prior mirror evidence does not contain an algorithmMirror snapshot",
      );
    }
    evidence.algorithmMirror = priorMirror as unknown as AlgorithmMirrorSync;
    await persist();
  }
  const algorithmMirror = evidence.algorithmMirror
    ? await restoreAlgorithmMirror(evidence.algorithmMirror)
    : await buildFreshAlgorithmMirror();
  if (!evidence.algorithmMirror) {
    evidence.algorithmMirror = algorithmMirror;
    await persist();
  }
  const mirrorFieldNames = [
    "algorithmId",
    "schemeId",
    "version",
    "algorithmHash",
    "evaluatorHash",
    "status",
    "sourceStateHash",
    "sourceBlockHeight",
    "validUntil",
  ];
  const mirrorExpected = Object.fromEntries(
    mirrorFieldNames.map((
      field,
      index,
    ) => [field, algorithmMirror.values[index]]),
  );
  const mirrorOperationalMetadataMatches = (
    value: JsonRecord | undefined,
  ): boolean => {
    const updatedAt = Number(value?.updatedAt);
    const updatedAtUnit = inferAntChainTimestampUnit(updatedAt);
    return value?.syncer === accountIdentity &&
      updatedAtUnit === verifiedUnit &&
      Number.isSafeInteger(updatedAt) &&
      updatedAt >= Number(algorithmMirror.snapshot.sourceBlock.timestamp) &&
      updatedAt < Number(algorithmMirror.validUntil);
  };
  let mirroredAlgorithm: JsonRecord | undefined;
  try {
    mirroredAlgorithm = parseRecord(
      await read<string>(
        labelContract,
        "getAlgorithmStateMirror",
        [config.algorithmId],
        ["string"],
        "string",
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const mirrorIsActive = mirroredAlgorithm
    ? await read<string>(
      labelContract,
      "isMirroredAlgorithmActive",
      [config.algorithmId, config.algorithmHash],
      ["string", "string"],
      "string",
    )
    : "0";
  const activeMirroredId = mirroredAlgorithm
    ? await read<string>(
      labelContract,
      "getActiveMirroredAlgorithmId",
      [config.schemeId],
      ["string"],
      "string",
    )
    : "";
  const mirrorMatches = recordMatches(mirroredAlgorithm, mirrorExpected) &&
    mirrorOperationalMetadataMatches(mirroredAlgorithm) &&
    mirrorIsActive === "1" && activeMirroredId === config.algorithmId;
  if (mirrorMatches) {
    await recoverSatisfiedIntent(
      "sync:AlgorithmState",
      contractWriteRequest(
        labelContract,
        labelIdentity,
        "syncAlgorithmState",
        algorithmMirror.values,
        [
          "string",
          "string",
          "string",
          "string",
          "string",
          "string",
          "string",
          "uint64",
          "uint64",
        ],
        "string",
      ),
      {
        sourceSnapshot: algorithmMirror.snapshot,
        mirror: mirroredAlgorithm,
        activeMirroredAlgorithmId: activeMirroredId,
        mirrorActiveState: mirrorIsActive,
      },
    );
  }
  if (!mirrorMatches || needsRecovery("sync:AlgorithmState")) {
    await write(
      "sync:AlgorithmState",
      labelContract,
      labelIdentity,
      "syncAlgorithmState",
      algorithmMirror.values,
      [
        "string",
        "string",
        "string",
        "string",
        "string",
        "string",
        "string",
        "uint64",
        "uint64",
      ],
      "string",
      "AlgorithmStateMirrored",
    );
  }
  mirroredAlgorithm = parseRecord(
    await read<string>(
      labelContract,
      "getAlgorithmStateMirror",
      [config.algorithmId],
      ["string"],
      "string",
    ),
  );
  const confirmedMirrorActiveState = await read<string>(
    labelContract,
    "isMirroredAlgorithmActive",
    [config.algorithmId, config.algorithmHash],
    ["string", "string"],
    "string",
  );
  const confirmedActiveMirroredId = await read<string>(
    labelContract,
    "getActiveMirroredAlgorithmId",
    [config.schemeId],
    ["string"],
    "string",
  );
  if (
    !recordMatches(mirroredAlgorithm, mirrorExpected) ||
    !mirrorOperationalMetadataMatches(mirroredAlgorithm) ||
    confirmedMirrorActiveState !== "1" ||
    confirmedActiveMirroredId !== config.algorithmId
  ) {
    throw new Error("EcoLabelRegistry algorithm mirror readback failed");
  }

  const verifyRegistryStillMatchesMirror = async () => {
    const currentAlgorithm = parseRecord(
      await read<string>(
        algorithmContract,
        "getAlgorithm",
        [config.algorithmId],
        ["string"],
        "string",
      ),
    );
    const currentActiveId = await read<string>(
      algorithmContract,
      "getActiveAlgorithmId",
      [config.schemeId],
      ["string"],
      "string",
    );
    const currentActiveState = await read<string>(
      algorithmContract,
      "isAlgorithmActive",
      [config.algorithmId, config.algorithmHash],
      ["string", "string"],
      "string",
    );
    if (
      !recordMatches(currentAlgorithm, algorithmMirror.snapshot.algorithm) ||
      currentActiveId !== algorithmMirror.snapshot.activeAlgorithmId ||
      currentActiveState !== algorithmMirror.snapshot.algorithmActiveState
    ) {
      throw new Error(
        "AlgorithmRegistry changed after mirror synchronization",
      );
    }
    return {
      algorithm: currentAlgorithm,
      activeAlgorithmId: currentActiveId,
      algorithmActiveState: currentActiveState,
    };
  };
  const registryBeforeIssue = await verifyRegistryStillMatchesMirror();

  const pilotCommitment = async (field: string) =>
    await sha256Text(JSON.stringify({
      schemaVersion: "eddl-antchain-synthetic-pilot/v1",
      project: resolution.report.release.projectId,
      taskId: config.pilotTaskId,
      field,
      nonSensitiveSyntheticData: true,
    }));
  const labelValues = [
    config.pilotLabelId,
    config.pilotTaskId,
    config.algorithmId,
    config.algorithmHash,
    config.pilotInputHash ?? await pilotCommitment("input"),
    config.pilotResultHash ?? await pilotCommitment("result"),
    config.pilotEvidenceHash ?? await pilotCommitment("evidence"),
    config.pilotAuthorizationHash ??
      await pilotCommitment("synthetic-data-use-grant"),
    config.pilotProofHash ?? await pilotCommitment("synthetic-compute-proof"),
    "0",
  ];
  const labelFieldNames = [
    "labelId",
    "taskId",
    "algorithmId",
    "algorithmHash",
    "inputHash",
    "resultHash",
    "evidenceHash",
    "authorizationHash",
    "proofHash",
    "expiresAt",
  ];
  const labelExpected = {
    ...Object.fromEntries(
      labelFieldNames.map((field, index) => [field, labelValues[index]]),
    ),
    algorithmSourceStateHash: algorithmMirror.sourceStateHash,
    algorithmSourceBlockHeight: String(algorithmMirror.sourceBlockHeight),
  };
  const issueArgsTypes = [
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
  ];
  let existingLabel: JsonRecord | undefined;
  try {
    existingLabel = parseRecord(
      await read<string>(
        labelContract,
        "getLabelByTaskId",
        [config.pilotTaskId],
        ["string"],
        "string",
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const existingLabelMatches = Boolean(
    existingLabel && existingLabel.status === "ACTIVE" &&
      recordMatches(existingLabel, labelExpected),
  );
  if (existingLabelMatches) {
    const existingByLabel = parseRecord(
      await read<string>(
        labelContract,
        "getLabel",
        [config.pilotLabelId],
        ["string"],
        "string",
      ),
    );
    if (
      existingByLabel &&
      JSON.stringify(existingByLabel) === JSON.stringify(existingLabel)
    ) {
      await recoverSatisfiedIntent(
        "issue:SyntheticResearchLabel",
        contractWriteRequest(
          labelContract,
          labelIdentity,
          "issueLabel",
          labelValues,
          issueArgsTypes,
          "string",
        ),
        {
          labelById: existingByLabel,
          labelByTaskId: existingLabel,
          consistent: true,
        },
      );
    }
  }
  if (
    !existingLabel || needsRecovery("issue:SyntheticResearchLabel")
  ) {
    await write(
      "issue:SyntheticResearchLabel",
      labelContract,
      labelIdentity,
      "issueLabel",
      labelValues,
      issueArgsTypes,
      "string",
      "LabelIssued",
    );
  }
  const byLabel = parseRecord(
    await read<string>(
      labelContract,
      "getLabel",
      [config.pilotLabelId],
      ["string"],
      "string",
    ),
  );
  const byTask = parseRecord(
    await read<string>(
      labelContract,
      "getLabelByTaskId",
      [config.pilotTaskId],
      ["string"],
      "string",
    ),
  );
  if (
    !byLabel || !byTask || JSON.stringify(byLabel) !== JSON.stringify(byTask) ||
    !recordMatches(byLabel, labelExpected) ||
    byLabel.status !== "ACTIVE"
  ) {
    throw new Error(
      "getLabel and getLabelByTaskId independent readback failed",
    );
  }
  const registryAfterIssue = await verifyRegistryStillMatchesMirror();
  const labelCodeAfterIssue = await provider.queryContract({
    contractName: config.ecoLabelRegistryName,
  });
  const labelCodeMatchesRelease = await chainCodeMatchesFrozenWasc(
    labelCodeAfterIssue.code,
    labelDigest,
  );
  if (!labelCodeMatchesRelease) {
    throw new Error(
      "EcoLabelRegistry final code readback does not match the frozen WASC",
    );
  }
  evidence.finalReadback = {
    trustClosure: {
      boundAlgorithmRegistryIdentity,
      expectedAlgorithmRegistryIdentity: algorithmIdentity,
      algorithmRegistryWascDigest: algorithmDigest,
      algorithmRegistryCodeMatchesRelease: algorithmCodeMatchesRelease,
      activeAlgorithmId,
      expectedAlgorithmId: config.algorithmId,
      algorithmActiveState,
      algorithmMirrorSourceStateHash: algorithmMirror.sourceStateHash,
      algorithmMirrorSourceBlock: algorithmMirror.snapshot.sourceBlock,
      mirroredAlgorithm,
      mirrorActiveState: confirmedMirrorActiveState,
      activeMirroredAlgorithmId: confirmedActiveMirroredId,
      compatibilityMode: "GOVERNED_NON_ATOMIC_ALGORITHM_MIRROR",
      registryBeforeIssue,
      registryAfterIssue,
      ecoLabelRegistryWascDigest: labelDigest,
      ecoLabelRegistryCodeMatchesRelease: labelCodeMatchesRelease,
      frozenAlgorithmSnapshot: algorithmMirror.snapshot,
      frozenAlgorithmSnapshotCanonical: algorithmMirror.canonicalSnapshot,
    },
    algorithm,
    activeAlgorithmId,
    labelById: byLabel,
    labelByTaskId: byTask,
    consistent: true,
  };
  const closure = assessLiveTransactionClosure({
    operations: evidence.operations,
    stateRecoveries: evidence.stateRecoveries,
  });
  evidence.closure = closure;
  if (!closure.completed) {
    evidence.completedAt = undefined;
    await persist();
    console.error(JSON.stringify(
      {
        success: false,
        stateVerified: true,
        closureStatus: closure.status,
        evidencePath,
        missingTransactionEvidence: closure.missingTransactionEvidence,
        message:
          "Chain state is consistent, but this evidence set lacks terminal transaction proof for every required write.",
      },
      null,
      2,
    ));
    Deno.exit(4);
  }
  evidence.completedAt = new Date().toISOString();
  await persist();
  console.log(JSON.stringify(
    {
      success: true,
      assurance: evidence.assurance,
      evidencePath,
      algorithmRegistry: config.algorithmRegistryName,
      ecoLabelRegistry: config.ecoLabelRegistryName,
      labelId: config.pilotLabelId,
      taskId: config.pilotTaskId,
      blockTimestampUnit: evidence.blockTimestampUnit,
    },
    null,
    2,
  ));
} catch (error) {
  evidence.failure = safeFailure(error, config);
  await persist();
  console.error(JSON.stringify(
    {
      success: false,
      evidencePath,
      failure: evidence.failure,
    },
    null,
    2,
  ));
  Deno.exit(1);
}
