import { ApiResponse } from "../../deps.ts";
import { BlockchainContract } from "../../core/blockchain/contract/index.ts";
import { ContractMethodParams } from "../../core/blockchain/contract/types.ts";
import { BlockchainData } from "../../core/blockchain/data/index.ts";
import { sha256 } from "../hash.ts";
import { LedgerPort } from "../ports.ts";
import { AlgorithmVersion, LedgerAnchor } from "../types.ts";

export const ECO_CONTRACT_ABI = {
  AlgorithmRegistry: {
    initialize: "initialize()",
    grantRole: "grantRole(string,string)",
    revokeRole: "revokeRole(string,string)",
    hasRole: "hasRole(string,string)",
    registerAlgorithm: "registerAlgorithm(string,string,string,string,string)",
    setAlgorithmStatus: "setAlgorithmStatus(string,string)",
    replaceActiveAlgorithm: "replaceActiveAlgorithm(string,string)",
    getAlgorithm: "getAlgorithm(string)",
    getActiveAlgorithmId: "getActiveAlgorithmId(string)",
    isAlgorithmActive: "isAlgorithmActive(string,string)",
  },
  EcoLabelRegistry: {
    initialize: "initialize(string)",
    grantRole: "grantRole(string,string)",
    revokeRole: "revokeRole(string,string)",
    hasRole: "hasRole(string,string)",
    getAlgorithmRegistryContractId: "getAlgorithmRegistryContractId()",
    syncAlgorithmState:
      "syncAlgorithmState(string,string,string,string,string,string,string,uint64,uint64)",
    getAlgorithmStateMirror: "getAlgorithmStateMirror(string)",
    getActiveMirroredAlgorithmId: "getActiveMirroredAlgorithmId(string)",
    isMirroredAlgorithmActive: "isMirroredAlgorithmActive(string,string)",
    issueLabel:
      "issueLabel(string,string,string,string,string,string,string,string,string,uint64)",
    suspendLabel: "suspendLabel(string)",
    resumeLabel: "resumeLabel(string)",
    revokeLabel: "revokeLabel(string,string)",
    expireLabel: "expireLabel(string)",
    replaceLabel:
      "replaceLabel(string,string,string,string,string,string,string,string,string,string,uint64)",
    getLabel: "getLabel(string)",
    getLabelByTaskId: "getLabelByTaskId(string)",
  },
} as const;

export interface ContractCallClient {
  callMethod(params: ContractMethodParams): Promise<ApiResponse>;
}

export interface ContractReceiptClient {
  queryReceipt(requestId: string): Promise<ApiResponse>;
}

/**
 * Canonical deployment-specific receipt shape expected by the strict mapper.
 * A gateway integration must normalize its raw response into this shape. A
 * mere HTTP 200, `success: true`, request hash, or mempool acceptance is not a
 * final receipt.
 */
export type NormalizedContractReceipt =
  | { state: "PENDING" }
  | {
    state: "FAILED";
    failureCode: string;
    failureMessage?: string;
  }
  | {
    state: "CONFIRMED";
    finality: "FINAL";
    executionStatus: "SUCCESS";
    transactionHash: string;
    blockHeight: number;
    finalizedAt: string;
    contractName: string;
    methodSignature: string;
    eventName: string;
    /** Canonical decoded transaction inputs obtained from the chain query. */
    inputValues: string[];
  };

export type ContractReceiptNormalizer = (
  response: ApiResponse,
) => NormalizedContractReceipt;

export type AntChainBlockTimestampUnit = "seconds" | "milliseconds";

export function normalizeSha256Commitment(value: string): string {
  const normalized = value.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(normalized)) return `sha256:${normalized}`;
  if (/^sha256:[0-9a-f]{64}$/.test(normalized)) return normalized;
  throw new Error("Commitment must be a SHA-256 hex digest");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseReceiptData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

/**
 * Conservative default: only a fully normalized FINAL/SUCCESS object can be
 * confirmed. Unknown raw gateway shapes remain pending until an operator
 * supplies and tests a deployment-specific normalizer.
 */
export function strictNormalizedReceiptMapper(
  response: ApiResponse,
): NormalizedContractReceipt {
  if (!response.success) return { state: "PENDING" };
  const data = parseReceiptData(response.data);
  if (!data) return { state: "PENDING" };
  const finality = data.finality;
  const executionStatus = data.executionStatus;
  if (finality !== "FINAL") return { state: "PENDING" };
  if (executionStatus === "FAILED" || executionStatus === "REVERTED") {
    return {
      state: "FAILED",
      failureCode: typeof data.failureCode === "string"
        ? data.failureCode
        : "CONTRACT_EXECUTION_FAILED",
      failureMessage: typeof data.failureMessage === "string"
        ? data.failureMessage
        : undefined,
    };
  }
  if (executionStatus !== "SUCCESS") return { state: "PENDING" };
  const transactionHash = data.transactionHash;
  const blockHeight = data.blockHeight;
  const finalizedAt = data.finalizedAt;
  const contractName = data.contractName;
  const methodSignature = data.methodSignature;
  const eventName = data.eventName;
  const inputValues = data.inputValues;
  if (
    typeof transactionHash !== "string" ||
    !/^(0x)?[0-9a-fA-F]{64}$/.test(transactionHash) ||
    typeof blockHeight !== "number" || !Number.isSafeInteger(blockHeight) ||
    blockHeight < 0 || typeof finalizedAt !== "string" ||
    !Number.isFinite(Date.parse(finalizedAt)) ||
    typeof contractName !== "string" ||
    typeof methodSignature !== "string" || typeof eventName !== "string" ||
    !Array.isArray(inputValues) ||
    !inputValues.every((value) => typeof value === "string")
  ) {
    return { state: "PENDING" };
  }
  return {
    state: "CONFIRMED",
    finality: "FINAL",
    executionStatus: "SUCCESS",
    transactionHash: transactionHash.toLowerCase(),
    blockHeight,
    finalizedAt,
    contractName,
    methodSignature,
    eventName,
    inputValues: [...inputValues] as string[],
  };
}

function submissionReference(response: ApiResponse, orderId: string): string {
  if (typeof response.data === "string" && response.data.trim()) {
    return response.data.trim();
  }
  const data = asRecord(response.data);
  for (const key of ["requestId", "receiptId", "hash", "orderId"]) {
    const candidate = data?.[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  // The stable order ID is a request correlation key, not a chain tx hash.
  return orderId;
}

/**
 * AntChain call adapter for the deployable Myfish contracts. All writes return
 * PENDING first. `reconcile` is the only method that can promote an anchor,
 * after finality, execution, contract, method, event, and payload checks.
 */
export class AntChainLedgerAdapter implements LedgerPort {
  constructor(
    private readonly contract: ContractCallClient = new BlockchainContract(),
    private readonly algorithmRegistryName =
      Deno.env.get("ECO_ALGORITHM_REGISTRY_CONTRACT") || "",
    private readonly ecoLabelRegistryName =
      Deno.env.get("ECO_LABEL_REGISTRY_CONTRACT") || "",
    private readonly receipts: ContractReceiptClient = new BlockchainData(),
    private readonly receiptNormalizer: ContractReceiptNormalizer =
      strictNormalizedReceiptMapper,
    private readonly blockTimestampUnit =
      Deno.env.get("ECO_ANTCHAIN_BLOCK_TIMESTAMP_UNIT") || "",
  ) {}

  private chainExpiry(epochMs: number): string {
    if (epochMs === 0) return "0";
    if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
      throw new Error("expiresAtEpochMs must be a non-negative safe integer");
    }
    if (this.blockTimestampUnit === "milliseconds") return String(epochMs);
    if (this.blockTimestampUnit === "seconds") {
      return String(Math.floor(epochMs / 1_000));
    }
    throw new Error(
      "ECO_ANTCHAIN_BLOCK_TIMESTAMP_UNIT must be verified and set to seconds or milliseconds before issuing expiring labels",
    );
  }

  private async call(
    contractName: string,
    contract: LedgerAnchor["contract"],
    methodSignature: string,
    expectedEvent: string,
    values: string[],
  ): Promise<LedgerAnchor> {
    if (!contractName) {
      throw new Error(`Missing deployed ${contract} contract name`);
    }
    const payloadHash = normalizeSha256Commitment(
      await sha256({ contractName, methodSignature, values }),
    );
    const orderId = `eddl-${payloadHash.slice(7, 39)}`;
    const response = await this.contract.callMethod({
      contractName,
      methodSignature,
      inputParamListStr: JSON.stringify(values),
      outputTypes: "[string]",
      isLocalTransaction: false,
      orderId,
    });
    if (!response.success) {
      throw new Error(response.message || `${contract} contract call failed`);
    }
    const requestId = submissionReference(response, orderId);
    return {
      // Deliberately not the gateway-returned string: until reconciliation it
      // is only a pending request reference, even if it happens to look like a
      // 64-character transaction hash.
      transactionId: `pending-request-${orderId.slice(5)}`,
      requestId,
      network: "AntChain",
      contract,
      anchoredAt: new Date().toISOString(),
      status: "PENDING",
      receiptVerification: {
        contractName,
        methodSignature,
        expectedEvent,
        payloadHash,
      },
    };
  }

  async reconcile(anchor: LedgerAnchor): Promise<LedgerAnchor> {
    if (anchor.status !== "PENDING") return { ...anchor };
    if (!anchor.requestId || !anchor.receiptVerification) {
      throw new Error("Pending anchor lacks receipt verification context");
    }
    const response = await this.receipts.queryReceipt(anchor.requestId);
    const receipt = this.receiptNormalizer(response);
    if (receipt.state === "PENDING") return { ...anchor };
    if (receipt.state === "FAILED") {
      return {
        ...anchor,
        status: "FAILED",
        failureCode: receipt.failureCode,
        failureMessage: receipt.failureMessage,
        finalizedAt: new Date().toISOString(),
      };
    }
    const expected = anchor.receiptVerification;
    const receiptPayloadHash = normalizeSha256Commitment(
      await sha256({
        contractName: receipt.contractName,
        methodSignature: receipt.methodSignature,
        values: receipt.inputValues,
      }),
    );
    const matches = receipt.contractName === expected.contractName &&
      receipt.methodSignature === expected.methodSignature &&
      receipt.eventName === expected.expectedEvent &&
      receiptPayloadHash === expected.payloadHash;
    if (!matches) {
      return {
        ...anchor,
        status: "FAILED",
        failureCode: "RECEIPT_MISMATCH",
        failureMessage:
          "Final receipt does not match the fixed contract, method, event, and payload commitment",
        finalizedAt: receipt.finalizedAt,
      };
    }
    return {
      ...anchor,
      transactionId: receipt.transactionHash,
      status: "CONFIRMED",
      blockHeight: receipt.blockHeight,
      finalizedAt: receipt.finalizedAt,
      failureCode: undefined,
      failureMessage: undefined,
    };
  }

  async registerAlgorithm(algorithm: AlgorithmVersion): Promise<LedgerAnchor> {
    if (!algorithm.schemeId || !algorithm.evaluatorHash) {
      throw new Error(
        "AntChain algorithm registration requires an explicit schemeId and signed evaluatorHash",
      );
    }
    return await this.call(
      this.algorithmRegistryName,
      "AlgorithmRegistry",
      ECO_CONTRACT_ABI.AlgorithmRegistry.registerAlgorithm,
      "AlgorithmRegistered",
      [
        algorithm.id,
        algorithm.schemeId,
        algorithm.version,
        normalizeSha256Commitment(algorithm.algorithmHash),
        normalizeSha256Commitment(algorithm.evaluatorHash),
      ],
    );
  }

  setAlgorithmStatus(algorithm: AlgorithmVersion): Promise<LedgerAnchor> {
    return this.call(
      this.algorithmRegistryName,
      "AlgorithmRegistry",
      ECO_CONTRACT_ABI.AlgorithmRegistry.setAlgorithmStatus,
      "AlgorithmStatusChanged",
      [algorithm.id, algorithm.status],
    );
  }

  async issueLabel(
    label: {
      labelId: string;
      taskId: string;
      algorithmId: string;
      algorithmHash: string;
      inputHash: string;
      resultHash: string;
      evidenceHash: string;
      authorizationHash: string;
      proofHash: string;
      authorizationAssurance:
        | "DEVELOPMENT_SELF_ASSERTED"
        | "VERIFIED_DATA_USE_GRANT";
      computeAssurance: "LOCAL_DETERMINISTIC" | "VERIFIED_TCS";
      expiresAtEpochMs: number;
    },
  ): Promise<LedgerAnchor> {
    if (label.authorizationAssurance !== "VERIFIED_DATA_USE_GRANT") {
      throw new Error(
        "AntChain issuance requires a verified eco-design-labelling DataUseGrant",
      );
    }
    if (label.computeAssurance !== "VERIFIED_TCS") {
      throw new Error(
        "AntChain issuance requires a verified TCS compute proof",
      );
    }
    return await this.call(
      this.ecoLabelRegistryName,
      "EcoLabelRegistry",
      ECO_CONTRACT_ABI.EcoLabelRegistry.issueLabel,
      "LabelIssued",
      [
        label.labelId,
        label.taskId,
        label.algorithmId,
        normalizeSha256Commitment(label.algorithmHash),
        normalizeSha256Commitment(label.inputHash),
        normalizeSha256Commitment(label.resultHash),
        normalizeSha256Commitment(label.evidenceHash),
        normalizeSha256Commitment(label.authorizationHash),
        normalizeSha256Commitment(label.proofHash),
        this.chainExpiry(label.expiresAtEpochMs),
      ],
    );
  }

  suspendLabel(labelId: string): Promise<LedgerAnchor> {
    return this.call(
      this.ecoLabelRegistryName,
      "EcoLabelRegistry",
      ECO_CONTRACT_ABI.EcoLabelRegistry.suspendLabel,
      "LabelStatusChanged",
      [labelId],
    );
  }

  resumeLabel(labelId: string): Promise<LedgerAnchor> {
    return this.call(
      this.ecoLabelRegistryName,
      "EcoLabelRegistry",
      ECO_CONTRACT_ABI.EcoLabelRegistry.resumeLabel,
      "LabelStatusChanged",
      [labelId],
    );
  }

  revokeLabel(labelId: string, reasonHash: string): Promise<LedgerAnchor> {
    return this.call(
      this.ecoLabelRegistryName,
      "EcoLabelRegistry",
      ECO_CONTRACT_ABI.EcoLabelRegistry.revokeLabel,
      "LabelRevoked",
      [labelId, normalizeSha256Commitment(reasonHash)],
    );
  }

  expireLabel(labelId: string): Promise<LedgerAnchor> {
    return this.call(
      this.ecoLabelRegistryName,
      "EcoLabelRegistry",
      ECO_CONTRACT_ABI.EcoLabelRegistry.expireLabel,
      "LabelStatusChanged",
      [labelId],
    );
  }

  async replaceLabel(
    previousLabelId: string,
    label: {
      labelId: string;
      taskId: string;
      algorithmId: string;
      algorithmHash: string;
      inputHash: string;
      resultHash: string;
      evidenceHash: string;
      authorizationHash: string;
      proofHash: string;
      authorizationAssurance:
        | "DEVELOPMENT_SELF_ASSERTED"
        | "VERIFIED_DATA_USE_GRANT";
      computeAssurance: "LOCAL_DETERMINISTIC" | "VERIFIED_TCS";
      expiresAtEpochMs: number;
    },
  ): Promise<LedgerAnchor> {
    if (label.authorizationAssurance !== "VERIFIED_DATA_USE_GRANT") {
      throw new Error(
        "AntChain replacement requires a verified eco-design-labelling DataUseGrant",
      );
    }
    if (label.computeAssurance !== "VERIFIED_TCS") {
      throw new Error(
        "AntChain replacement requires a verified TCS compute proof",
      );
    }
    return await this.call(
      this.ecoLabelRegistryName,
      "EcoLabelRegistry",
      ECO_CONTRACT_ABI.EcoLabelRegistry.replaceLabel,
      "LabelSuperseded",
      [
        previousLabelId,
        label.labelId,
        label.taskId,
        label.algorithmId,
        normalizeSha256Commitment(label.algorithmHash),
        normalizeSha256Commitment(label.inputHash),
        normalizeSha256Commitment(label.resultHash),
        normalizeSha256Commitment(label.evidenceHash),
        normalizeSha256Commitment(label.authorizationHash),
        normalizeSha256Commitment(label.proofHash),
        this.chainExpiry(label.expiresAtEpochMs),
      ],
    );
  }
}
