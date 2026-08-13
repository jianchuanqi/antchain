import { ApiResponse } from "../../deps.ts";
import {
  ContractReceiptNormalizer,
  ECO_CONTRACT_ABI,
  NormalizedContractReceipt,
} from "./antchain.ts";

export interface DeployedAntChainContract {
  /** Human-readable name fixed in the deployment request. */
  name: string;
  /** 64 lowercase hexadecimal AntChain contract identity. */
  identity: string;
}

export interface LegacyAntChainReceiptOptions {
  algorithmRegistry: DeployedAntChainContract;
  ecoLabelRegistry: DeployedAntChainContract;
  blockTimestampUnit: "seconds" | "milliseconds";
}

type JsonRecord = Record<string, unknown>;

interface ParsedLog {
  contractIdentity: string;
  topics: string[];
  payload?: JsonRecord;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function parseObject(value: unknown): JsonRecord | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function decodeHex(value: string): Uint8Array | undefined {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(normalized) || normalized.length % 2 !== 0) {
    return undefined;
  }
  return Uint8Array.from(
    normalized.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function decodeVariableString(bytes: Uint8Array): string | undefined {
  let length = 0;
  let shift = 0;
  let offset = 0;
  while (offset < bytes.length && offset < 5) {
    const byte = bytes[offset++];
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (length < 0 || offset + length > bytes.length) return undefined;
      return new TextDecoder().decode(bytes.slice(offset, offset + length));
    }
    shift += 7;
  }
  return undefined;
}

function parseJsonBytes(bytes: Uint8Array): JsonRecord | undefined {
  const direct = new TextDecoder().decode(bytes).replace(/\0+$/g, "");
  const parsed = parseObject(direct);
  if (parsed) return parsed;
  const variableString = decodeVariableString(bytes);
  return variableString ? parseObject(variableString) : undefined;
}

function decodeJsonPayload(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const direct = parseObject(value);
  if (direct) return direct;
  for (const bytes of [decodeBase64(value), decodeHex(value)]) {
    if (!bytes) continue;
    const parsed = parseJsonBytes(bytes);
    if (parsed) return parsed;
  }
  return undefined;
}

function decodeIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  const bytes = decodeBase64(value);
  if (bytes?.length === 32) return bytesToHex(bytes);
  return undefined;
}

function parseLog(value: unknown): ParsedLog | undefined {
  const log = asRecord(value);
  const topics = log?.topics;
  const to = asRecord(log?.to);
  if (!log || !Array.isArray(topics)) return undefined;
  const contractIdentity = decodeIdentity(to?.value ?? to?.data ?? log.to);
  if (!contractIdentity) return undefined;
  return {
    contractIdentity,
    topics: topics.filter((topic): topic is string =>
      typeof topic === "string"
    ),
    payload: decodeJsonPayload(log.logData),
  };
}

export function inferAntChainTimestampUnit(
  timestamp: string | number,
): "seconds" | "milliseconds" | undefined {
  const numeric = typeof timestamp === "number" ? timestamp : Number(timestamp);
  if (!Number.isSafeInteger(numeric)) return undefined;
  // Deliberately bounded to plausible Unix times (2000-01-01 through
  // 2100-01-01) so a counter or malformed value is not mistaken for a time.
  if (numeric >= 946_684_800 && numeric <= 4_102_444_800) return "seconds";
  if (
    numeric >= 946_684_800_000 && numeric <= 4_102_444_800_000
  ) return "milliseconds";
  return undefined;
}

export function findLegacyAntChainEventTimestamp(
  response: ApiResponse,
  eventName: string,
  contractIdentity: string,
): string | undefined {
  const data = parseObject(response.data);
  const logs = Array.isArray(data?.logs)
    ? data.logs.map(parseLog).filter((log): log is ParsedLog => Boolean(log))
    : [];
  const matching = logs.find((log) =>
    log.contractIdentity === contractIdentity && log.topics.includes(eventName)
  );
  return matching?.payload
    ? requiredString(matching.payload, "blockTimestamp")
    : undefined;
}

function requiredString(
  payload: JsonRecord,
  field: string,
): string | undefined {
  const value = payload[field];
  return typeof value === "string" ? value : undefined;
}

function pickStrings(
  payload: JsonRecord,
  fields: string[],
): string[] | undefined {
  const values = fields.map((field) => requiredString(payload, field));
  return values.every((value): value is string => value !== undefined)
    ? values
    : undefined;
}

function receiptTime(
  payload: JsonRecord,
  unit: LegacyAntChainReceiptOptions["blockTimestampUnit"],
): string | undefined {
  const raw = requiredString(payload, "blockTimestamp");
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const timestamp = Number(raw);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return undefined;
  const millis = unit === "seconds" ? timestamp * 1_000 : timestamp;
  const result = new Date(millis).toISOString();
  return Number.isFinite(Date.parse(result)) ? result : undefined;
}

function transactionHash(data: JsonRecord): string | undefined {
  const value = data.hash;
  if (typeof value !== "string") return undefined;
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(normalized)
    ? normalized.toLowerCase()
    : undefined;
}

function executionFailure(data: JsonRecord): NormalizedContractReceipt {
  const code = data.result ?? data.code;
  return {
    state: "FAILED",
    failureCode: `ANTCHAIN_EXECUTION_${String(code ?? "UNKNOWN")}`,
    failureMessage: "AntChain returned a terminal unsuccessful receipt",
  };
}

function eventInputs(
  eventName: string,
  eventLog: ParsedLog,
  logs: ParsedLog[],
): { methodSignature: string; values: string[] } | undefined {
  const payload = eventLog.payload;
  if (!payload) return undefined;
  switch (eventName) {
    case "AlgorithmRegistered": {
      const values = pickStrings(payload, [
        "algorithmId",
        "schemeId",
        "version",
        "algorithmHash",
        "evaluatorHash",
      ]);
      return values
        ? {
          methodSignature: ECO_CONTRACT_ABI.AlgorithmRegistry.registerAlgorithm,
          values,
        }
        : undefined;
    }
    case "AlgorithmStatusChanged": {
      const values = pickStrings(payload, ["algorithmId", "status"]);
      return values
        ? {
          methodSignature:
            ECO_CONTRACT_ABI.AlgorithmRegistry.setAlgorithmStatus,
          values,
        }
        : undefined;
    }
    case "AlgorithmStateMirrored": {
      const values = pickStrings(payload, [
        "algorithmId",
        "schemeId",
        "version",
        "algorithmHash",
        "evaluatorHash",
        "status",
        "sourceStateHash",
        "sourceBlockHeight",
        "validUntil",
      ]);
      return values
        ? {
          methodSignature: ECO_CONTRACT_ABI.EcoLabelRegistry.syncAlgorithmState,
          values,
        }
        : undefined;
    }
    case "LabelIssued": {
      const values = pickStrings(payload, [
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
      ]);
      return values
        ? {
          methodSignature: ECO_CONTRACT_ABI.EcoLabelRegistry.issueLabel,
          values,
        }
        : undefined;
    }
    case "LabelRevoked": {
      const values = pickStrings(payload, ["labelId", "reasonHash"]);
      return values
        ? {
          methodSignature: ECO_CONTRACT_ABI.EcoLabelRegistry.revokeLabel,
          values,
        }
        : undefined;
    }
    case "LabelStatusChanged": {
      const values = pickStrings(payload, ["labelId"]);
      const status = requiredString(payload, "status");
      if (!values || !status) return undefined;
      const methodSignature = status === "SUSPENDED"
        ? ECO_CONTRACT_ABI.EcoLabelRegistry.suspendLabel
        : status === "ACTIVE"
        ? ECO_CONTRACT_ABI.EcoLabelRegistry.resumeLabel
        : status === "EXPIRED"
        ? ECO_CONTRACT_ABI.EcoLabelRegistry.expireLabel
        : undefined;
      return methodSignature ? { methodSignature, values } : undefined;
    }
    case "LabelSuperseded": {
      const previousLabelId = requiredString(payload, "labelId");
      const replacementId = requiredString(payload, "replacedByLabelId");
      const issued = logs.find((log) =>
        log.topics.includes("LabelIssued") &&
        requiredString(log.payload ?? {}, "labelId") === replacementId
      )?.payload;
      const replacement = issued
        ? pickStrings(issued, [
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
        ])
        : undefined;
      return previousLabelId && replacement
        ? {
          methodSignature: ECO_CONTRACT_ABI.EcoLabelRegistry.replaceLabel,
          values: [previousLabelId, ...replacement],
        }
        : undefined;
    }
    default:
      return undefined;
  }
}

function validateContract(
  contract: DeployedAntChainContract,
  field: string,
): void {
  if (!contract.name) throw new Error(`${field}.name is required`);
  if (!/^[0-9a-f]{64}$/.test(contract.identity)) {
    throw new Error(`${field}.identity must be 64 lowercase hex characters`);
  }
}

/**
 * Maps the raw response of the currently deployed legacy REST gateway. This
 * mapper deliberately requires both terminal flags and reconstructs the call
 * payload from the contract's public event. A HTTP success, transaction hash,
 * output, or result code alone is never final.
 */
export function createLegacyAntChainReceiptNormalizer(
  options: LegacyAntChainReceiptOptions,
): ContractReceiptNormalizer {
  validateContract(options.algorithmRegistry, "algorithmRegistry");
  validateContract(options.ecoLabelRegistry, "ecoLabelRegistry");
  return (response: ApiResponse): NormalizedContractReceipt => {
    if (!response.success) return { state: "PENDING" };
    const data = parseObject(response.data);
    if (!data || data.txFinish !== true) return { state: "PENDING" };
    if (data.txSuccess !== true || data.result !== 0 || data.code !== 0) {
      return executionFailure(data);
    }
    const hash = transactionHash(data);
    const blockHeight = data.blockNumber;
    if (
      !hash || typeof blockHeight !== "number" ||
      !Number.isSafeInteger(blockHeight) || blockHeight < 0
    ) {
      return {
        state: "FAILED",
        failureCode: "ANTCHAIN_RECEIPT_MALFORMED",
        failureMessage: "Terminal receipt lacks a valid hash or block height",
      };
    }
    const logs = Array.isArray(data.logs)
      ? data.logs.map(parseLog).filter((log): log is ParsedLog => Boolean(log))
      : [];
    for (const log of logs) {
      for (const eventName of log.topics) {
        const contract = eventName === "AlgorithmStateMirrored"
          ? options.ecoLabelRegistry
          : eventName.startsWith("Algorithm")
          ? options.algorithmRegistry
          : eventName.startsWith("Label")
          ? options.ecoLabelRegistry
          : undefined;
        if (!contract || log.contractIdentity !== contract.identity) continue;
        const bound = eventInputs(eventName, log, logs);
        const finalizedAt = log.payload
          ? receiptTime(log.payload, options.blockTimestampUnit)
          : undefined;
        if (!bound || !finalizedAt) continue;
        return {
          state: "CONFIRMED",
          finality: "FINAL",
          executionStatus: "SUCCESS",
          transactionHash: hash,
          blockHeight,
          finalizedAt,
          contractName: contract.name,
          methodSignature: bound.methodSignature,
          eventName,
          inputValues: bound.values,
        };
      }
    }
    return {
      state: "FAILED",
      failureCode: "ANTCHAIN_RECEIPT_UNVERIFIABLE",
      failureMessage:
        "Terminal receipt has no event bound to the configured contract identity and method payload",
    };
  };
}
