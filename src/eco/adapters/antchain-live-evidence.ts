export const REQUIRED_LIVE_OPERATIONS = Object.freeze(
  [
    "deploy:AlgorithmRegistry",
    "deploy:EcoLabelRegistry",
    "initialize:AlgorithmRegistry",
    "initialize:EcoLabelRegistry",
    "register:Algorithm",
    "activate:Algorithm",
    "sync:AlgorithmState",
    "issue:SyntheticResearchLabel",
  ] as const,
);

export interface LiveTargetBinding {
  protocol: string;
  host: string;
  port: string;
  bizIdCommitment: string;
  tenantIdCommitment: string;
  accountCommitment: string;
  kmsIdCommitment: string;
  profileCommitment: string;
}

export type LiveClosureStatus =
  | "COMPLETED_WITH_TRANSACTION_EVIDENCE"
  | "PREEXISTING_STATE_VERIFIED"
  | "STATE_RECOVERED_WITHOUT_TRANSACTION_EVIDENCE"
  | "INCOMPLETE_TRANSACTION_EVIDENCE";

export interface LiveClosureAssessment {
  status: LiveClosureStatus;
  completed: boolean;
  requiredOperations: readonly string[];
  missingTransactionEvidence: string[];
  stateRecoveredOperations: string[];
  preexistingOperations: string[];
}

async function sha256Reference(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  }`;
}

export async function createLiveTargetBinding(input: {
  restUrl: string;
  bizId: string;
  tenantId: string;
  account: string;
  kmsId: string;
}): Promise<LiveTargetBinding> {
  const endpoint = new URL(input.restUrl);
  const routingProfile = {
    schemaVersion: "eddl-antchain-target-profile/v1",
    protocol: endpoint.protocol,
    host: endpoint.hostname,
    port: endpoint.port,
    bizId: input.bizId,
    tenantId: input.tenantId,
    account: input.account,
    kmsId: input.kmsId,
  };
  return Object.freeze({
    protocol: endpoint.protocol,
    host: endpoint.hostname,
    port: endpoint.port,
    bizIdCommitment: await sha256Reference({
      field: "bizId",
      value: input.bizId,
    }),
    tenantIdCommitment: await sha256Reference({
      field: "tenantId",
      value: input.tenantId,
    }),
    accountCommitment: await sha256Reference({
      field: "account",
      value: input.account,
    }),
    kmsIdCommitment: await sha256Reference({
      field: "kmsId",
      value: input.kmsId,
    }),
    profileCommitment: await sha256Reference(routingProfile),
  });
}

export function assessLiveTransactionClosure(input: {
  operations: Array<{ operation: string }>;
  stateRecoveries: Array<{ operation: string }>;
}): LiveClosureAssessment {
  const confirmed = new Set(input.operations.map((item) => item.operation));
  const recovered = new Set(
    input.stateRecoveries.map((item) => item.operation),
  );
  const requiredOperations = [...REQUIRED_LIVE_OPERATIONS];
  const missingTransactionEvidence = requiredOperations.filter((operation) =>
    !confirmed.has(operation)
  );
  const stateRecoveredOperations = missingTransactionEvidence.filter(
    (operation) => recovered.has(operation),
  );
  const preexistingOperations = missingTransactionEvidence.filter(
    (operation) => !recovered.has(operation),
  );
  let status: LiveClosureStatus = "COMPLETED_WITH_TRANSACTION_EVIDENCE";
  if (missingTransactionEvidence.length > 0) {
    status = preexistingOperations.length === missingTransactionEvidence.length
      ? "PREEXISTING_STATE_VERIFIED"
      : stateRecoveredOperations.length === missingTransactionEvidence.length
      ? "STATE_RECOVERED_WITHOUT_TRANSACTION_EVIDENCE"
      : "INCOMPLETE_TRANSACTION_EVIDENCE";
  }
  return {
    status,
    completed: missingTransactionEvidence.length === 0,
    requiredOperations,
    missingTransactionEvidence,
    stateRecoveredOperations,
    preexistingOperations,
  };
}
