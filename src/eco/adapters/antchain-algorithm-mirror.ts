import { canonicalJson, sha256 } from "../hash.ts";

export type AntChainTimestampUnit = "seconds" | "milliseconds";

export interface AlgorithmRegistryReadback {
  algorithmId: string;
  schemeId: string;
  version: string;
  algorithmHash: string;
  evaluatorHash: string;
  status: "DRAFT" | "ACTIVE" | "SUSPENDED" | "RETIRED";
  publisher: string;
  registeredAt: string;
  updatedAt: string;
}

export interface AnchoredAlgorithmSnapshot {
  schemaVersion: "eddl-algorithm-registry-state-snapshot/v1";
  algorithmRegistryIdentity: string;
  algorithm: AlgorithmRegistryReadback;
  activeAlgorithmId: string;
  algorithmActiveState: "1";
  sourceBlock: {
    height: string;
    hash: string;
    timestamp: string;
    timestampUnit: AntChainTimestampUnit;
    observationMode:
      | "LATEST_BLOCK_STABLE_WINDOW"
      | "RECENT_WRITE_ANCHOR_DOUBLE_READ";
  };
}

export interface AlgorithmMirrorSync {
  snapshot: AnchoredAlgorithmSnapshot;
  canonicalSnapshot: string;
  sourceStateHash: string;
  sourceBlockHeight: number;
  validUntil: string;
  values: string[];
}

const commitmentPattern = /^sha256:[0-9a-f]{64}$/;
const identityPattern = /^[0-9a-f]{64}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const identifierPattern = /^[A-Za-z0-9._:-]+$/;
const algorithmKeys = [
  "algorithmHash",
  "algorithmId",
  "evaluatorHash",
  "publisher",
  "registeredAt",
  "schemeId",
  "status",
  "updatedAt",
  "version",
];

function requireSafePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function requireDecimal(value: string, field: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal string`);
  }
  requireSafePositiveInteger(Number(value), field);
}

function validateAlgorithmReadback(
  value: Record<string, unknown>,
): AlgorithmRegistryReadback {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(algorithmKeys)) {
    throw new Error(
      "AlgorithmRegistry readback fields are incomplete or unexpected",
    );
  }
  for (const key of keys) {
    if (typeof value[key] !== "string") {
      throw new Error(`AlgorithmRegistry readback ${key} must be a string`);
    }
  }
  const algorithm = value as unknown as AlgorithmRegistryReadback;
  for (
    const [field, content, max] of [
      ["algorithmId", algorithm.algorithmId, 128],
      ["schemeId", algorithm.schemeId, 128],
      ["version", algorithm.version, 64],
    ] as const
  ) {
    if (!content || content.length > max || !identifierPattern.test(content)) {
      throw new Error(`Invalid ${field} in AlgorithmRegistry readback`);
    }
  }
  if (
    !commitmentPattern.test(algorithm.algorithmHash) ||
    !commitmentPattern.test(algorithm.evaluatorHash)
  ) {
    throw new Error("AlgorithmRegistry readback commitments are invalid");
  }
  if (!identityPattern.test(algorithm.publisher)) {
    throw new Error("AlgorithmRegistry publisher identity is invalid");
  }
  if (!["DRAFT", "ACTIVE", "SUSPENDED", "RETIRED"].includes(algorithm.status)) {
    throw new Error("AlgorithmRegistry status is invalid");
  }
  requireDecimal(algorithm.registeredAt, "registeredAt");
  requireDecimal(algorithm.updatedAt, "updatedAt");
  return { ...algorithm };
}

/**
 * Builds the exact payload used by syncAlgorithmState(). All snapshot values
 * are strings, so canonicalJson is RFC 8785 compatible for this restricted
 * schema: object keys are sorted and JSON strings use JSON serialization.
 */
export async function buildAlgorithmMirrorSync(input: {
  algorithmRegistryIdentity: string;
  algorithmReadback: Record<string, unknown>;
  activeAlgorithmId: string;
  algorithmActiveState: string;
  sourceBlockHeight: number;
  sourceBlockHash: string;
  sourceBlockTimestamp: number;
  timestampUnit: AntChainTimestampUnit;
  observationMode:
    | "LATEST_BLOCK_STABLE_WINDOW"
    | "RECENT_WRITE_ANCHOR_DOUBLE_READ";
  validityMs?: number;
}): Promise<AlgorithmMirrorSync> {
  const registryIdentity = input.algorithmRegistryIdentity.toLowerCase();
  const blockHash = input.sourceBlockHash.replace(/^0x/, "").toLowerCase();
  if (!identityPattern.test(registryIdentity)) {
    throw new Error("AlgorithmRegistry identity is invalid");
  }
  if (!hashPattern.test(blockHash)) {
    throw new Error("Source block hash is invalid");
  }
  requireSafePositiveInteger(input.sourceBlockHeight, "sourceBlockHeight");
  requireSafePositiveInteger(
    input.sourceBlockTimestamp,
    "sourceBlockTimestamp",
  );
  const algorithm = validateAlgorithmReadback(input.algorithmReadback);
  const registeredAt = Number(algorithm.registeredAt);
  const updatedAt = Number(algorithm.updatedAt);
  const timestampFloor = input.timestampUnit === "seconds"
    ? 946_684_800
    : 946_684_800_000;
  const timestampCeiling = input.timestampUnit === "seconds"
    ? 4_102_444_800
    : 4_102_444_800_000;
  if (
    input.sourceBlockTimestamp < timestampFloor ||
    input.sourceBlockTimestamp > timestampCeiling ||
    registeredAt < timestampFloor || registeredAt > timestampCeiling ||
    updatedAt < timestampFloor || updatedAt > timestampCeiling ||
    registeredAt > updatedAt || updatedAt > input.sourceBlockTimestamp
  ) {
    throw new Error(
      "AlgorithmRegistry timestamps do not match the anchored block and unit",
    );
  }
  if (
    input.observationMode !== "LATEST_BLOCK_STABLE_WINDOW" &&
    input.observationMode !== "RECENT_WRITE_ANCHOR_DOUBLE_READ"
  ) {
    throw new Error("AlgorithmRegistry observation mode is invalid");
  }
  if (
    algorithm.status !== "ACTIVE" ||
    input.activeAlgorithmId !== algorithm.algorithmId ||
    input.algorithmActiveState !== "1"
  ) {
    throw new Error("AlgorithmRegistry snapshot is not consistently ACTIVE");
  }

  const validityMs = input.validityMs ?? 86_400_000;
  if (
    !Number.isSafeInteger(validityMs) || validityMs < 3_600_000 ||
    validityMs > 86_400_000 ||
    (input.timestampUnit === "seconds" && validityMs % 1_000 !== 0)
  ) {
    throw new Error("Mirror validity must be between 1 and 24 hours");
  }
  const validityDelta = input.timestampUnit === "seconds"
    ? validityMs / 1_000
    : validityMs;
  const validUntilNumber = input.sourceBlockTimestamp + validityDelta;
  requireSafePositiveInteger(validUntilNumber, "validUntil");

  const snapshot: AnchoredAlgorithmSnapshot = {
    schemaVersion: "eddl-algorithm-registry-state-snapshot/v1",
    algorithmRegistryIdentity: registryIdentity,
    algorithm,
    activeAlgorithmId: input.activeAlgorithmId,
    algorithmActiveState: "1",
    sourceBlock: {
      height: String(input.sourceBlockHeight),
      hash: blockHash,
      timestamp: String(input.sourceBlockTimestamp),
      timestampUnit: input.timestampUnit,
      observationMode: input.observationMode,
    },
  };
  const canonicalSnapshot = canonicalJson(snapshot);
  const sourceStateHash = `sha256:${await sha256(snapshot)}`;
  const validUntil = String(validUntilNumber);
  return {
    snapshot,
    canonicalSnapshot,
    sourceStateHash,
    sourceBlockHeight: input.sourceBlockHeight,
    validUntil,
    values: [
      algorithm.algorithmId,
      algorithm.schemeId,
      algorithm.version,
      algorithm.algorithmHash,
      algorithm.evaluatorHash,
      algorithm.status,
      sourceStateHash,
      String(input.sourceBlockHeight),
      validUntil,
    ],
  };
}
