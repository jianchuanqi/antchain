import { canonicalJson } from "../hash.ts";
import {
  AlgorithmContractRecord,
  AlgorithmContractStatus,
  AlgorithmRegistration,
  ContractEvent,
  ContractRuleError,
  LabelContractStatus,
  LabelIssueCommand,
} from "./model.ts";
import { AlgorithmRegistrySimulator } from "./simulator.ts";

type UnifiedRole =
  | "DEFAULT_ADMIN"
  | "ALGORITHM_ADMIN"
  | "LABEL_ISSUER"
  | "LABEL_LIFECYCLE_ADMIN";

export interface UnifiedLabelRecord extends LabelIssueCommand {
  status: LabelContractStatus;
  issuer: string;
  issuedAtEpochMs: number;
  updatedAtEpochMs: number;
  reasonHash?: string;
  replacesLabelId?: string;
  replacedByLabelId?: string;
}

const identifierPattern = /^[A-Za-z0-9._:-]+$/;
const commitmentPattern = /^sha256:[0-9a-f]{64}$/;

function fail(code: string, message: string): never {
  throw new ContractRuleError(code, message);
}

function requireIdentifier(value: string, field: string): void {
  if (!value || value.length > 128 || !identifierPattern.test(value)) {
    fail("INVALID_ARGUMENT", `${field} is not a safe identifier`);
  }
}

function requireCommitment(value: string, field: string): void {
  if (!commitmentPattern.test(value)) {
    fail("INVALID_COMMITMENT", `${field} is not a sha256 commitment`);
  }
}

/** Executable oracle for the single-storage Myfish contract. */
export class UnifiedEcoLabelRegistrySimulator {
  private readonly algorithms: AlgorithmRegistrySimulator;
  private readonly roles = new Map<UnifiedRole, Set<string>>();
  private readonly labels = new Map<string, UnifiedLabelRecord>();
  private readonly taskToLabel = new Map<string, string>();
  private readonly issuePayloads = new Map<string, string>();
  readonly events: ContractEvent[] = [];

  constructor(
    readonly admin: string,
    private clockEpochMs = 1_700_000_000_000,
  ) {
    requireIdentifier(admin, "admin");
    this.algorithms = new AlgorithmRegistrySimulator(admin, clockEpochMs);
    for (
      const role of [
        "DEFAULT_ADMIN",
        "ALGORITHM_ADMIN",
        "LABEL_ISSUER",
        "LABEL_LIFECYCLE_ADMIN",
      ] as UnifiedRole[]
    ) {
      this.roles.set(role, new Set([admin]));
    }
  }

  setClock(epochMs: number): void {
    if (!Number.isSafeInteger(epochMs) || epochMs < this.clockEpochMs) {
      fail("INVALID_TIME", "clock must advance monotonically");
    }
    this.clockEpochMs = epochMs;
    this.algorithms.setClock(epochMs);
  }

  registerAlgorithm(
    actor: string,
    input: AlgorithmRegistration,
  ): AlgorithmContractRecord {
    this.requireRole(actor, "ALGORITHM_ADMIN");
    return this.algorithms.registerAlgorithm(this.admin, input);
  }

  setAlgorithmStatus(
    actor: string,
    algorithmId: string,
    status: AlgorithmContractStatus,
  ): AlgorithmContractRecord {
    this.requireRole(actor, "ALGORITHM_ADMIN");
    return this.algorithms.setAlgorithmStatus(this.admin, algorithmId, status);
  }

  replaceActiveAlgorithm(
    actor: string,
    currentAlgorithmId: string,
    replacementAlgorithmId: string,
  ): AlgorithmContractRecord {
    this.requireRole(actor, "ALGORITHM_ADMIN");
    return this.algorithms.replaceActiveAlgorithm(
      this.admin,
      currentAlgorithmId,
      replacementAlgorithmId,
    );
  }

  getAlgorithm(algorithmId: string): AlgorithmContractRecord | undefined {
    return this.algorithms.getAlgorithm(algorithmId);
  }

  getActiveAlgorithmId(schemeId: string): string | undefined {
    return this.algorithms.getActiveAlgorithmId(schemeId);
  }

  grantRole(actor: string, role: UnifiedRole, account: string): void {
    this.requireRole(actor, "DEFAULT_ADMIN");
    requireIdentifier(account, "account");
    const members = this.roles.get(role) ?? new Set<string>();
    if (members.has(account)) return;
    members.add(account);
    this.roles.set(role, members);
    this.emit("RoleGranted", actor, { role, account });
  }

  revokeRole(actor: string, role: UnifiedRole, account: string): void {
    this.requireRole(actor, "DEFAULT_ADMIN");
    if (role === "DEFAULT_ADMIN" && actor === account) {
      fail("LAST_ADMIN_GUARD", "an administrator cannot revoke itself");
    }
    if (!this.roles.get(role)?.delete(account)) return;
    this.emit("RoleRevoked", actor, { role, account });
  }

  issueLabel(actor: string, command: LabelIssueCommand): UnifiedLabelRecord {
    this.requireRole(actor, "LABEL_ISSUER");
    this.validateIssueShape(command);
    const payload = canonicalJson(command);
    const existing = this.labels.get(command.labelId);
    if (existing) {
      if (this.issuePayloads.get(command.labelId) !== payload) {
        fail("IDEMPOTENCY_CONFLICT", "label payload changed");
      }
      return { ...existing };
    }
    this.validateNewIssue(command);
    if (
      !this.algorithms.isAlgorithmActive(
        command.algorithmId,
        command.algorithmHash,
      )
    ) {
      fail("ALGORITHM_NOT_ACTIVE", "the exact algorithm must be active");
    }
    if (this.taskToLabel.has(command.taskId)) {
      fail("IDEMPOTENCY_CONFLICT", "task is already bound");
    }
    const record: UnifiedLabelRecord = {
      ...command,
      status: "ACTIVE",
      issuer: actor,
      issuedAtEpochMs: this.clockEpochMs,
      updatedAtEpochMs: this.clockEpochMs,
    };
    this.labels.set(record.labelId, record);
    this.taskToLabel.set(record.taskId, record.labelId);
    this.issuePayloads.set(record.labelId, payload);
    this.emit("LabelIssued", actor, {
      labelId: record.labelId,
      taskId: record.taskId,
      algorithmId: record.algorithmId,
      algorithmHash: record.algorithmHash,
      inputHash: record.inputHash,
      resultHash: record.resultHash,
      evidenceHash: record.evidenceHash,
      authorizationHash: record.authorizationHash,
      proofHash: record.proofHash,
      expiresAtEpochMs: record.expiresAtEpochMs,
      status: record.status,
    });
    return { ...record };
  }

  suspendLabel(actor: string, labelId: string): UnifiedLabelRecord {
    this.requireRole(actor, "LABEL_LIFECYCLE_ADMIN");
    const record = this.requireLabel(labelId);
    if (record.status === "SUSPENDED") return { ...record };
    if (record.status !== "ACTIVE") {
      fail("INVALID_TRANSITION", "only an active label can be suspended");
    }
    return this.changeStatus(actor, record, "SUSPENDED");
  }

  resumeLabel(actor: string, labelId: string): UnifiedLabelRecord {
    this.requireRole(actor, "LABEL_LIFECYCLE_ADMIN");
    const record = this.requireLabel(labelId);
    if (record.status !== "SUSPENDED") {
      fail("INVALID_TRANSITION", "only a suspended label can be resumed");
    }
    if (
      record.expiresAtEpochMs > 0 &&
      record.expiresAtEpochMs <= this.clockEpochMs
    ) {
      fail("LABEL_EXPIRED", "an expired label cannot be resumed");
    }
    return this.changeStatus(actor, record, "ACTIVE");
  }

  revokeLabel(
    actor: string,
    labelId: string,
    reasonHash: string,
  ): UnifiedLabelRecord {
    this.requireRole(actor, "LABEL_LIFECYCLE_ADMIN");
    requireCommitment(reasonHash, "reasonHash");
    const record = this.requireLabel(labelId);
    if (record.status === "REVOKED") {
      if (record.reasonHash !== reasonHash) {
        fail("IDEMPOTENCY_CONFLICT", "revocation reason changed");
      }
      return { ...record };
    }
    if (record.status === "EXPIRED" || record.status === "SUPERSEDED") {
      fail("TERMINAL_STATE", "terminal label cannot be revoked");
    }
    record.reasonHash = reasonHash;
    return this.changeStatus(actor, record, "REVOKED");
  }

  expireLabel(actor: string, labelId: string): UnifiedLabelRecord {
    requireIdentifier(actor, "actor");
    const record = this.requireLabel(labelId);
    if (record.status === "EXPIRED") return { ...record };
    if (record.status !== "ACTIVE" && record.status !== "SUSPENDED") {
      fail("TERMINAL_STATE", "terminal label cannot expire");
    }
    if (
      record.expiresAtEpochMs === 0 ||
      record.expiresAtEpochMs > this.clockEpochMs
    ) {
      fail("NOT_DUE", "label is not due");
    }
    return this.changeStatus(actor, record, "EXPIRED");
  }

  getLabel(labelId: string): UnifiedLabelRecord | undefined {
    const record = this.labels.get(labelId);
    return record ? { ...record } : undefined;
  }

  getLabelByTaskId(taskId: string): UnifiedLabelRecord | undefined {
    const labelId = this.taskToLabel.get(taskId);
    return labelId ? this.getLabel(labelId) : undefined;
  }

  get size(): number {
    return this.labels.size;
  }

  private validateIssueShape(command: LabelIssueCommand): void {
    requireIdentifier(command.labelId, "labelId");
    requireIdentifier(command.taskId, "taskId");
    requireIdentifier(command.algorithmId, "algorithmId");
    for (
      const [name, value] of Object.entries({
        algorithmHash: command.algorithmHash,
        inputHash: command.inputHash,
        resultHash: command.resultHash,
        evidenceHash: command.evidenceHash,
        authorizationHash: command.authorizationHash,
        proofHash: command.proofHash,
      })
    ) {
      requireCommitment(value, name);
    }
  }

  private validateNewIssue(command: LabelIssueCommand): void {
    if (
      !Number.isSafeInteger(command.expiresAtEpochMs) ||
      command.expiresAtEpochMs < 0 ||
      (command.expiresAtEpochMs > 0 &&
        command.expiresAtEpochMs <= this.clockEpochMs)
    ) {
      fail("INVALID_EXPIRY", "expiry must be zero or future epoch ms");
    }
  }

  private requireRole(actor: string, role: UnifiedRole): void {
    if (!this.roles.get(role)?.has(actor)) {
      fail("UNAUTHORIZED", `${actor} lacks ${role}`);
    }
  }

  private requireLabel(labelId: string): UnifiedLabelRecord {
    const record = this.labels.get(labelId);
    if (!record) fail("NOT_FOUND", `label ${labelId} does not exist`);
    return record;
  }

  private changeStatus(
    actor: string,
    record: UnifiedLabelRecord,
    status: LabelContractStatus,
  ): UnifiedLabelRecord {
    const previousStatus = record.status;
    record.status = status;
    record.updatedAtEpochMs = this.clockEpochMs;
    this.emit("LabelStatusChanged", actor, {
      labelId: record.labelId,
      previousStatus,
      status,
    });
    return { ...record };
  }

  private emit(
    name: string,
    actor: string,
    data: ContractEvent["data"],
  ): void {
    this.events.push({
      sequence: this.events.length + 1,
      contract: "EcoLabelRegistry",
      name,
      actor,
      data: { ...data },
    });
  }
}
