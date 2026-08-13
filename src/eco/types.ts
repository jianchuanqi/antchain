/** Domain types for the Eco Design Label trusted-computing workflow. */
export type ViewerRole =
  | "public"
  | "partner"
  | "enterprise"
  | "evaluator"
  | "regulator"
  | "admin";

export type AlgorithmStatus = "DRAFT" | "ACTIVE" | "SUSPENDED" | "RETIRED";
export type TaskStatus = "SUBMITTED" | "RUNNING" | "COMPLETED" | "FAILED";
export type LabelStatus =
  | "PENDING_CHAIN"
  | "ACTIVE"
  | "PENDING_REVOCATION"
  | "REVOKED"
  | "EXPIRED"
  | "SUSPENDED"
  | "CHAIN_FAILED";
export type MetricDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";

export interface MetricDefinition {
  id: string;
  name: string;
  /** Key read from ProductData.attributes. */
  inputKey: string;
  weight: number;
  min: number;
  max: number;
  direction: MetricDirection;
  unit?: string;
}

export interface AlgorithmVersion {
  id: string;
  version: string;
  name: string;
  /** Stable identifier scheme namespace used by AlgorithmRegistry. */
  schemeId?: string;
  /** Signed evaluator/OCI commitment when separate from the rule hash. */
  evaluatorHash?: string;
  metrics: MetricDefinition[];
  status: AlgorithmStatus;
  algorithmHash: string;
  createdAt: string;
  activatedAt?: string;
}

/** Raw product data is confined to the sandbox store and is never ledger data. */
export interface ProductData {
  productId: string;
  productName: string;
  enterpriseId: string;
  attributes: Record<string, number>;
  sensitiveFields: string[];
  submittedAt: string;
}

export interface MetricResult {
  metricId: string;
  normalizedScore: number;
  weightedScore: number;
}

export interface CalculationResult {
  score: number;
  level: string;
  metricResults: MetricResult[];
}

export interface CalculationEvidence {
  evidenceId: string;
  taskId: string;
  sandboxType: "LOCAL_DETERMINISTIC" | "TCS";
  sandboxInstanceId: string;
  inputHash: string;
  algorithmHash: string;
  resultHash: string;
  evidenceHash: string;
  startedAt: string;
  completedAt: string;
  sandboxSignature: string;
  /** TCS/TEE remote-attestation reference, when one is available. */
  attestationRef?: string;
}

export interface EvaluationTask {
  id: string;
  product: ProductData;
  algorithmId: string;
  status: TaskStatus;
  createdAt: string;
  result?: CalculationResult;
  evidence?: CalculationEvidence;
  failureReason?: string;
}

export interface LedgerAnchor {
  transactionId: string;
  /** Gateway request/receipt reference. It is not a transaction hash. */
  requestId?: string;
  network: string;
  contract: "AlgorithmRegistry" | "EcoLabelRegistry";
  anchoredAt: string;
  status: "CONFIRMED" | "PENDING" | "FAILED";
  blockHeight?: number;
  finalizedAt?: string;
  failureCode?: string;
  failureMessage?: string;
  /** Non-sensitive values required to independently verify a final receipt. */
  receiptVerification?: {
    contractName: string;
    methodSignature: string;
    expectedEvent: string;
    payloadHash: string;
  };
}

export interface EcoLabel {
  id: string;
  taskId: string;
  productId: string;
  enterpriseId: string;
  algorithmId: string;
  algorithmVersion: string;
  score: number;
  level: string;
  status: LabelStatus;
  requestedAt: string;
  /** Set only after a confirmed ledger receipt. */
  issuedAt?: string;
  expiresAt?: string;
  evidence: CalculationEvidence;
  ledgerAnchor: LedgerAnchor;
  revokedAt?: string;
  revocationReason?: string;
  /** Internal recovery state; never placed on chain. */
  pendingLedgerAction?: "ISSUE" | "REVOKE";
  statusBeforePendingLedgerAction?: LabelStatus;
}

export interface ViewerContext {
  role: ViewerRole;
  enterpriseId?: string;
  /** Explicit scopes issued by a trusted IAM, gateway, or B2B authorizer. */
  authorizedEnterpriseIds?: string[];
  principalId?: string;
}

/** Resolves a request to trusted identity claims. Returning null is anonymous. */
export interface ViewerResolver {
  resolve(request: Request): Promise<ViewerContext | null>;
}

export interface PublicLabelView {
  labelId: string;
  productName: string;
  status: LabelStatus;
  issuedAt?: string;
  expiresAt?: string;
  algorithm: Pick<AlgorithmVersion, "id" | "version" | "name">;
  sandbox: Pick<
    CalculationEvidence,
    "sandboxType" | "sandboxInstanceId" | "evidenceHash" | "attestationRef"
  >;
  ledger: Pick<
    LedgerAnchor,
    | "transactionId"
    | "network"
    | "contract"
    | "anchoredAt"
    | "status"
    | "blockHeight"
    | "finalizedAt"
    | "failureCode"
  >;
  verification: {
    inputCommitment: boolean;
    algorithmCommitment: boolean;
    resultCommitment: boolean;
    evidenceHashConsistent: boolean;
    /** True only after a non-local ledger adapter reports a confirmed anchor. */
    ledgerConfirmed: boolean;
  };
  verifyUrl: string;
  qrPayload: string;
}
