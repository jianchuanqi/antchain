/**
 * Runtime-neutral model shared by the deterministic contract simulator and
 * conformance tests. These types mirror the fields accepted by the WASM
 * contracts. They intentionally contain commitments, never product data.
 */

export type AlgorithmContractStatus =
  | "DRAFT"
  | "ACTIVE"
  | "SUSPENDED"
  | "RETIRED";

export type LabelContractStatus =
  | "ACTIVE"
  | "SUSPENDED"
  | "REVOKED"
  | "EXPIRED"
  | "SUPERSEDED";

export type AlgorithmRole = "DEFAULT_ADMIN" | "ALGORITHM_ADMIN";
export type LabelRole =
  | "DEFAULT_ADMIN"
  | "ALGORITHM_MIRROR_ADMIN"
  | "LABEL_ISSUER"
  | "LABEL_LIFECYCLE_ADMIN";

export interface AlgorithmRegistration {
  id: string;
  schemeId: string;
  version: string;
  algorithmHash: string;
  evaluatorHash: string;
}

export interface AlgorithmContractRecord extends AlgorithmRegistration {
  status: AlgorithmContractStatus;
  publisher: string;
  registeredAtEpochMs: number;
  updatedAtEpochMs: number;
}

export interface AlgorithmMirrorSyncCommand extends AlgorithmRegistration {
  status: AlgorithmContractStatus;
  sourceStateHash: string;
  sourceBlockHeight: number;
  validUntilEpochMs: number;
}

export interface AlgorithmMirrorRecord extends AlgorithmMirrorSyncCommand {
  syncer: string;
  updatedAtEpochMs: number;
}

export interface LabelIssueCommand {
  labelId: string;
  taskId: string;
  algorithmId: string;
  algorithmHash: string;
  inputHash: string;
  resultHash: string;
  evidenceHash: string;
  authorizationHash: string;
  proofHash: string;
  /** Zero denotes no expiry. */
  expiresAtEpochMs: number;
}

export interface LabelContractRecord extends LabelIssueCommand {
  status: LabelContractStatus;
  issuer: string;
  issuedAtEpochMs: number;
  updatedAtEpochMs: number;
  reasonHash?: string;
  replacesLabelId?: string;
  replacedByLabelId?: string;
  /** Exact independently verified AlgorithmRegistry snapshot used at issue. */
  algorithmSourceStateHash: string;
  algorithmSourceBlockHeight: number;
}

export interface ContractEvent {
  sequence: number;
  contract: "AlgorithmRegistry" | "EcoLabelRegistry";
  name: string;
  actor: string;
  data: Readonly<Record<string, string | number | boolean>>;
}

export class ContractRuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ContractRuleError";
  }
}

export function sha256Commitment(hex: string): string {
  return `sha256:${hex.toLowerCase()}`;
}
