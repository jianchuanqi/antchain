import { canonicalJson } from "../hash.ts";
import {
  AlgorithmContractRecord,
  AlgorithmContractStatus,
  AlgorithmMirrorRecord,
  AlgorithmMirrorSyncCommand,
  AlgorithmRegistration,
  AlgorithmRole,
  ContractEvent,
  ContractRuleError,
  LabelContractRecord,
  LabelIssueCommand,
  LabelRole,
} from "./model.ts";

const identifierPattern = /^[A-Za-z0-9._:-]+$/;
const hashPattern = /^sha256:[0-9a-f]{64}$/;

function fail(code: string, message: string): never {
  throw new ContractRuleError(code, message);
}

function requireIdentifier(
  value: string,
  name: string,
  maxLength = 128,
): void {
  if (
    !value || value.length > maxLength || !identifierPattern.test(value)
  ) {
    fail("INVALID_ARGUMENT", `${name} is not a safe identifier`);
  }
}

function requireCommitment(value: string, name: string): void {
  if (!hashPattern.test(value)) {
    fail("INVALID_COMMITMENT", `${name} must be sha256:<64 lowercase hex>`);
  }
}

function cloneAlgorithm(
  record: AlgorithmContractRecord,
): AlgorithmContractRecord {
  return { ...record };
}

function cloneLabel(record: LabelContractRecord): LabelContractRecord {
  return { ...record };
}

function cloneMirror(record: AlgorithmMirrorRecord): AlgorithmMirrorRecord {
  return { ...record };
}

/**
 * Deterministic executable specification for AlgorithmRegistry. It is not a
 * blockchain emulator: it is the frozen business-rule oracle used before a
 * real WASM deployment is available.
 */
export class AlgorithmRegistrySimulator {
  private readonly roles = new Map<AlgorithmRole, Set<string>>();
  private readonly records = new Map<string, AlgorithmContractRecord>();
  private readonly activeByScheme = new Map<string, string>();
  readonly events: ContractEvent[] = [];

  constructor(
    admin: string,
    private clockEpochMs = 1_700_000_000_000,
  ) {
    requireIdentifier(admin, "admin");
    this.roles.set("DEFAULT_ADMIN", new Set([admin]));
    this.roles.set("ALGORITHM_ADMIN", new Set([admin]));
  }

  setClock(epochMs: number): void {
    if (!Number.isSafeInteger(epochMs) || epochMs < this.clockEpochMs) {
      fail("INVALID_TIME", "clock must advance monotonically");
    }
    this.clockEpochMs = epochMs;
  }

  grantRole(actor: string, role: AlgorithmRole, account: string): void {
    this.requireRole(actor, "DEFAULT_ADMIN");
    requireIdentifier(account, "account");
    const members = this.roles.get(role) ?? new Set<string>();
    if (members.has(account)) return;
    members.add(account);
    this.roles.set(role, members);
    this.emit("RoleGranted", actor, { role, account });
  }

  revokeRole(actor: string, role: AlgorithmRole, account: string): void {
    this.requireRole(actor, "DEFAULT_ADMIN");
    if (role === "DEFAULT_ADMIN" && account === actor) {
      fail("LAST_ADMIN_GUARD", "an administrator cannot revoke itself");
    }
    const members = this.roles.get(role);
    if (!members?.delete(account)) return;
    this.emit("RoleRevoked", actor, { role, account });
  }

  hasRole(role: AlgorithmRole, account: string): boolean {
    return this.roles.get(role)?.has(account) ?? false;
  }

  registerAlgorithm(
    actor: string,
    input: AlgorithmRegistration,
  ): AlgorithmContractRecord {
    this.requireRole(actor, "ALGORITHM_ADMIN");
    this.validateRegistration(input);
    const existing = this.records.get(input.id);
    if (existing) {
      const same = existing.schemeId === input.schemeId &&
        existing.version === input.version &&
        existing.algorithmHash === input.algorithmHash &&
        existing.evaluatorHash === input.evaluatorHash;
      if (!same) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          `algorithm id ${input.id} already has a different payload`,
        );
      }
      return cloneAlgorithm(existing);
    }
    const record: AlgorithmContractRecord = {
      ...input,
      status: "DRAFT",
      publisher: actor,
      registeredAtEpochMs: this.clockEpochMs,
      updatedAtEpochMs: this.clockEpochMs,
    };
    this.records.set(record.id, record);
    this.emit("AlgorithmRegistered", actor, {
      algorithmId: record.id,
      schemeId: record.schemeId,
      version: record.version,
      algorithmHash: record.algorithmHash,
      evaluatorHash: record.evaluatorHash,
      status: record.status,
    });
    return cloneAlgorithm(record);
  }

  setAlgorithmStatus(
    actor: string,
    id: string,
    next: AlgorithmContractStatus,
  ): AlgorithmContractRecord {
    this.requireRole(actor, "ALGORITHM_ADMIN");
    const record = this.requireAlgorithm(id);
    if (record.status === next) return cloneAlgorithm(record);
    if (record.status === "RETIRED") {
      fail("TERMINAL_STATE", "a retired algorithm cannot change status");
    }
    const allowed: Record<AlgorithmContractStatus, AlgorithmContractStatus[]> =
      {
        DRAFT: ["ACTIVE", "RETIRED"],
        ACTIVE: ["SUSPENDED", "RETIRED"],
        SUSPENDED: ["ACTIVE", "RETIRED"],
        RETIRED: [],
      };
    if (!allowed[record.status].includes(next)) {
      fail(
        "INVALID_TRANSITION",
        `algorithm cannot transition from ${record.status} to ${next}`,
      );
    }
    if (next === "ACTIVE") {
      const active = this.activeByScheme.get(record.schemeId);
      if (active && active !== record.id) {
        fail(
          "ACTIVE_VERSION_CONFLICT",
          `scheme ${record.schemeId} already has active algorithm ${active}`,
        );
      }
      this.activeByScheme.set(record.schemeId, record.id);
    } else if (record.status === "ACTIVE") {
      this.activeByScheme.delete(record.schemeId);
    }
    const previous = record.status;
    record.status = next;
    record.updatedAtEpochMs = this.clockEpochMs;
    this.emit("AlgorithmStatusChanged", actor, {
      algorithmId: record.id,
      previousStatus: previous,
      status: next,
    });
    return cloneAlgorithm(record);
  }

  replaceActiveAlgorithm(
    actor: string,
    currentId: string,
    replacementId: string,
  ): AlgorithmContractRecord {
    this.requireRole(actor, "ALGORITHM_ADMIN");
    const current = this.requireAlgorithm(currentId);
    const replacement = this.requireAlgorithm(replacementId);
    if (current.status !== "ACTIVE") {
      fail("INVALID_TRANSITION", "the replaced algorithm must be ACTIVE");
    }
    if (
      replacement.status !== "DRAFT" && replacement.status !== "SUSPENDED"
    ) {
      fail(
        "INVALID_TRANSITION",
        "the replacement must be DRAFT or SUSPENDED",
      );
    }
    if (current.schemeId !== replacement.schemeId) {
      fail("SCHEME_MISMATCH", "replacement must belong to the same scheme");
    }
    current.status = "SUSPENDED";
    current.updatedAtEpochMs = this.clockEpochMs;
    replacement.status = "ACTIVE";
    replacement.updatedAtEpochMs = this.clockEpochMs;
    this.activeByScheme.set(current.schemeId, replacement.id);
    this.emit("AlgorithmStatusChanged", actor, {
      algorithmId: current.id,
      previousStatus: "ACTIVE",
      status: "SUSPENDED",
    });
    this.emit("AlgorithmStatusChanged", actor, {
      algorithmId: replacement.id,
      previousStatus: "DRAFT_OR_SUSPENDED",
      status: "ACTIVE",
    });
    this.emit("AlgorithmReplaced", actor, {
      schemeId: current.schemeId,
      previousAlgorithmId: current.id,
      algorithmId: replacement.id,
    });
    return cloneAlgorithm(replacement);
  }

  getAlgorithm(id: string): AlgorithmContractRecord | undefined {
    const record = this.records.get(id);
    return record ? cloneAlgorithm(record) : undefined;
  }

  getActiveAlgorithmId(schemeId: string): string | undefined {
    return this.activeByScheme.get(schemeId);
  }

  isAlgorithmActive(id: string, algorithmHash: string): boolean {
    const record = this.records.get(id);
    return Boolean(
      record && record.status === "ACTIVE" &&
        record.algorithmHash === algorithmHash &&
        this.activeByScheme.get(record.schemeId) === id,
    );
  }

  get size(): number {
    return this.records.size;
  }

  private validateRegistration(input: AlgorithmRegistration): void {
    requireIdentifier(input.id, "algorithmId");
    requireIdentifier(input.schemeId, "schemeId");
    requireIdentifier(input.version, "version", 64);
    requireCommitment(input.algorithmHash, "algorithmHash");
    requireCommitment(input.evaluatorHash, "evaluatorHash");
  }

  private requireAlgorithm(id: string): AlgorithmContractRecord {
    const record = this.records.get(id);
    if (!record) fail("NOT_FOUND", `algorithm ${id} does not exist`);
    return record;
  }

  private requireRole(actor: string, role: AlgorithmRole): void {
    if (!this.hasRole(role, actor)) {
      fail("UNAUTHORIZED", `${actor} does not have ${role}`);
    }
  }

  private emit(
    name: string,
    actor: string,
    data: ContractEvent["data"],
  ): void {
    this.events.push({
      sequence: this.events.length + 1,
      contract: "AlgorithmRegistry",
      name,
      actor,
      data: { ...data },
    });
  }
}

/** Deterministic executable specification for EcoLabelRegistry. */
export class EcoLabelRegistrySimulator {
  private readonly roles = new Map<LabelRole, Set<string>>();
  private readonly algorithmMirrors = new Map<string, AlgorithmMirrorRecord>();
  private readonly activeMirrorByScheme = new Map<string, string>();
  private readonly labels = new Map<string, LabelContractRecord>();
  private readonly taskToLabel = new Map<string, string>();
  private readonly payloads = new Map<string, string>();
  readonly events: ContractEvent[] = [];

  constructor(
    admin: string,
    private clockEpochMs = 1_700_000_000_000,
    private readonly algorithmRegistryContractId = "a".repeat(64),
  ) {
    requireIdentifier(admin, "admin");
    this.roles.set("DEFAULT_ADMIN", new Set([admin]));
    this.roles.set("ALGORITHM_MIRROR_ADMIN", new Set([admin]));
    this.roles.set("LABEL_ISSUER", new Set([admin]));
    this.roles.set("LABEL_LIFECYCLE_ADMIN", new Set([admin]));
  }

  getAlgorithmRegistryContractId(): string {
    return this.algorithmRegistryContractId;
  }

  setClock(epochMs: number): void {
    if (!Number.isSafeInteger(epochMs) || epochMs < this.clockEpochMs) {
      fail("INVALID_TIME", "clock must advance monotonically");
    }
    this.clockEpochMs = epochMs;
  }

  grantRole(actor: string, role: LabelRole, account: string): void {
    this.requireRole(actor, "DEFAULT_ADMIN");
    requireIdentifier(account, "account");
    const members = this.roles.get(role) ?? new Set<string>();
    if (members.has(account)) return;
    members.add(account);
    this.roles.set(role, members);
    this.emit("RoleGranted", actor, { role, account });
  }

  revokeRole(actor: string, role: LabelRole, account: string): void {
    this.requireRole(actor, "DEFAULT_ADMIN");
    if (role === "DEFAULT_ADMIN" && account === actor) {
      fail("LAST_ADMIN_GUARD", "an administrator cannot revoke itself");
    }
    const members = this.roles.get(role);
    if (!members?.delete(account)) return;
    this.emit("RoleRevoked", actor, { role, account });
  }

  syncAlgorithmState(
    actor: string,
    command: AlgorithmMirrorSyncCommand,
  ): AlgorithmMirrorRecord {
    this.requireRole(actor, "ALGORITHM_MIRROR_ADMIN");
    this.validateMirrorCommand(command);
    const existing = this.algorithmMirrors.get(command.id);
    if (existing) {
      if (
        existing.schemeId !== command.schemeId ||
        existing.version !== command.version ||
        existing.algorithmHash !== command.algorithmHash ||
        existing.evaluatorHash !== command.evaluatorHash
      ) {
        fail(
          "MIRROR_METADATA_CONFLICT",
          "immutable mirrored algorithm metadata changed",
        );
      }
      if (command.sourceBlockHeight < existing.sourceBlockHeight) {
        fail("STALE_SOURCE_STATE", "source block height moved backwards");
      }
      if (command.sourceBlockHeight === existing.sourceBlockHeight) {
        const same = existing.status === command.status &&
          existing.sourceStateHash === command.sourceStateHash &&
          existing.validUntilEpochMs === command.validUntilEpochMs;
        if (!same) {
          fail(
            "IDEMPOTENCY_CONFLICT",
            "the same source block has a different mirror payload",
          );
        }
        return cloneMirror(existing);
      }
      if (existing.status === "RETIRED" && command.status !== "RETIRED") {
        fail("TERMINAL_STATE", "a retired mirror cannot be reactivated");
      }
      if (existing.status === "ACTIVE" && command.status !== "ACTIVE") {
        if (this.activeMirrorByScheme.get(command.schemeId) === command.id) {
          this.activeMirrorByScheme.delete(command.schemeId);
        }
      }
    }
    if (command.status === "ACTIVE") {
      const active = this.activeMirrorByScheme.get(command.schemeId);
      if (active && active !== command.id) {
        fail(
          "ACTIVE_VERSION_CONFLICT",
          `scheme ${command.schemeId} already has active mirror ${active}`,
        );
      }
      this.activeMirrorByScheme.set(command.schemeId, command.id);
    }
    const record: AlgorithmMirrorRecord = {
      ...command,
      syncer: actor,
      updatedAtEpochMs: this.clockEpochMs,
    };
    this.algorithmMirrors.set(command.id, record);
    this.emit("AlgorithmStateMirrored", actor, {
      algorithmId: command.id,
      schemeId: command.schemeId,
      algorithmHash: command.algorithmHash,
      status: command.status,
      sourceStateHash: command.sourceStateHash,
      sourceBlockHeight: command.sourceBlockHeight,
      validUntilEpochMs: command.validUntilEpochMs,
    });
    return cloneMirror(record);
  }

  getAlgorithmStateMirror(id: string): AlgorithmMirrorRecord | undefined {
    const record = this.algorithmMirrors.get(id);
    return record ? cloneMirror(record) : undefined;
  }

  getActiveMirroredAlgorithmId(schemeId: string): string | undefined {
    return this.activeMirrorByScheme.get(schemeId);
  }

  isMirroredAlgorithmActive(id: string, algorithmHash: string): boolean {
    const record = this.algorithmMirrors.get(id);
    return Boolean(
      record && record.status === "ACTIVE" &&
        record.algorithmHash === algorithmHash &&
        record.validUntilEpochMs > this.clockEpochMs &&
        this.activeMirrorByScheme.get(record.schemeId) === id,
    );
  }

  issueLabel(actor: string, command: LabelIssueCommand): LabelContractRecord {
    this.requireRole(actor, "LABEL_ISSUER");
    this.validateIssueCommand(command);
    const payload = canonicalJson(command);
    const existing = this.labels.get(command.labelId);
    if (existing) {
      if (this.payloads.get(command.labelId) !== payload) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          `label id ${command.labelId} already has a different payload`,
        );
      }
      return cloneLabel(existing);
    }
    const existingLabelId = this.taskToLabel.get(command.taskId);
    if (existingLabelId) {
      fail(
        "IDEMPOTENCY_CONFLICT",
        `task ${command.taskId} is already bound to ${existingLabelId}`,
      );
    }
    const mirror = this.algorithmMirrors.get(command.algorithmId);
    if (
      !this.isMirroredAlgorithmActive(
        command.algorithmId,
        command.algorithmHash,
      )
    ) {
      fail(
        "ALGORITHM_NOT_ACTIVE",
        "algorithm id and hash must refer to a fresh active mirror",
      );
    }
    const record: LabelContractRecord = {
      ...command,
      status: "ACTIVE",
      issuer: actor,
      issuedAtEpochMs: this.clockEpochMs,
      updatedAtEpochMs: this.clockEpochMs,
      algorithmSourceStateHash: mirror!.sourceStateHash,
      algorithmSourceBlockHeight: mirror!.sourceBlockHeight,
    };
    this.labels.set(record.labelId, record);
    this.taskToLabel.set(record.taskId, record.labelId);
    this.payloads.set(record.labelId, payload);
    this.emit("LabelIssued", actor, this.publicEventData(record));
    return cloneLabel(record);
  }

  suspendLabel(actor: string, labelId: string): LabelContractRecord {
    this.requireRole(actor, "LABEL_LIFECYCLE_ADMIN");
    const record = this.requireLabel(labelId);
    if (record.status === "SUSPENDED") return cloneLabel(record);
    if (record.status !== "ACTIVE") {
      fail("INVALID_TRANSITION", `${record.status} label cannot be suspended`);
    }
    return this.changeStatus(actor, record, "SUSPENDED");
  }

  resumeLabel(actor: string, labelId: string): LabelContractRecord {
    this.requireRole(actor, "LABEL_LIFECYCLE_ADMIN");
    const record = this.requireLabel(labelId);
    if (record.status === "ACTIVE") return cloneLabel(record);
    if (record.status !== "SUSPENDED") {
      fail("INVALID_TRANSITION", `${record.status} label cannot be resumed`);
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
  ): LabelContractRecord {
    this.requireRole(actor, "LABEL_LIFECYCLE_ADMIN");
    requireCommitment(reasonHash, "reasonHash");
    const record = this.requireLabel(labelId);
    if (record.status === "REVOKED") {
      if (record.reasonHash !== reasonHash) {
        fail(
          "IDEMPOTENCY_CONFLICT",
          "revocation retry has a different reason commitment",
        );
      }
      return cloneLabel(record);
    }
    if (record.status === "EXPIRED" || record.status === "SUPERSEDED") {
      fail("TERMINAL_STATE", `${record.status} label cannot be revoked`);
    }
    const previousStatus = record.status;
    record.status = "REVOKED";
    record.reasonHash = reasonHash;
    record.updatedAtEpochMs = this.clockEpochMs;
    this.emit("LabelRevoked", actor, {
      labelId,
      previousStatus,
      status: record.status,
      reasonHash,
    });
    return cloneLabel(record);
  }

  expireLabel(actor: string, labelId: string): LabelContractRecord {
    requireIdentifier(actor, "actor");
    const record = this.requireLabel(labelId);
    if (record.status === "EXPIRED") return cloneLabel(record);
    if (record.status !== "ACTIVE" && record.status !== "SUSPENDED") {
      fail("TERMINAL_STATE", `${record.status} label cannot expire`);
    }
    if (
      record.expiresAtEpochMs === 0 ||
      record.expiresAtEpochMs > this.clockEpochMs
    ) {
      fail("NOT_DUE", "label has not reached its expiry time");
    }
    return this.changeStatus(actor, record, "EXPIRED");
  }

  replaceLabel(
    actor: string,
    previousLabelId: string,
    command: LabelIssueCommand,
  ): LabelContractRecord {
    this.requireRole(actor, "LABEL_ISSUER");
    this.requireRole(actor, "LABEL_LIFECYCLE_ADMIN");
    const previous = this.requireLabel(previousLabelId);
    if (previous.status !== "ACTIVE" && previous.status !== "SUSPENDED") {
      fail(
        "TERMINAL_STATE",
        `${previous.status} label cannot be replaced`,
      );
    }
    if (command.labelId === previousLabelId) {
      fail("INVALID_ARGUMENT", "replacement must use a new label id");
    }
    const replacement = this.issueLabel(actor, command);
    previous.status = "SUPERSEDED";
    previous.replacedByLabelId = replacement.labelId;
    previous.updatedAtEpochMs = this.clockEpochMs;
    const storedReplacement = this.requireLabel(replacement.labelId);
    storedReplacement.replacesLabelId = previousLabelId;
    this.emit("LabelSuperseded", actor, {
      labelId: previousLabelId,
      replacedByLabelId: replacement.labelId,
      status: previous.status,
    });
    return cloneLabel(storedReplacement);
  }

  getLabel(labelId: string): LabelContractRecord | undefined {
    const record = this.labels.get(labelId);
    return record ? cloneLabel(record) : undefined;
  }

  getLabelByTaskId(taskId: string): LabelContractRecord | undefined {
    const labelId = this.taskToLabel.get(taskId);
    return labelId ? this.getLabel(labelId) : undefined;
  }

  get size(): number {
    return this.labels.size;
  }

  private validateIssueCommand(command: LabelIssueCommand): void {
    requireIdentifier(command.labelId, "labelId");
    requireIdentifier(command.taskId, "taskId");
    requireIdentifier(command.algorithmId, "algorithmId");
    requireCommitment(command.algorithmHash, "algorithmHash");
    requireCommitment(command.inputHash, "inputHash");
    requireCommitment(command.resultHash, "resultHash");
    requireCommitment(command.evidenceHash, "evidenceHash");
    requireCommitment(command.authorizationHash, "authorizationHash");
    requireCommitment(command.proofHash, "proofHash");
    if (
      !Number.isSafeInteger(command.expiresAtEpochMs) ||
      command.expiresAtEpochMs < 0 ||
      (command.expiresAtEpochMs > 0 &&
        command.expiresAtEpochMs <= this.clockEpochMs)
    ) {
      fail(
        "INVALID_EXPIRY",
        "expiry must be zero or a future epoch-millisecond value",
      );
    }
  }

  private validateMirrorCommand(command: AlgorithmMirrorSyncCommand): void {
    requireIdentifier(command.id, "algorithmId");
    requireIdentifier(command.schemeId, "schemeId");
    requireIdentifier(command.version, "version", 64);
    requireCommitment(command.algorithmHash, "algorithmHash");
    requireCommitment(command.evaluatorHash, "evaluatorHash");
    requireCommitment(command.sourceStateHash, "sourceStateHash");
    if (
      !Number.isSafeInteger(command.sourceBlockHeight) ||
      command.sourceBlockHeight <= 0
    ) {
      fail(
        "INVALID_SOURCE_BLOCK_HEIGHT",
        "source block height must be positive",
      );
    }
    if (
      !Number.isSafeInteger(command.validUntilEpochMs) ||
      command.validUntilEpochMs < 0
    ) {
      fail("INVALID_TIME", "mirror validity must be a non-negative integer");
    }
    if (
      command.status === "ACTIVE" &&
      command.validUntilEpochMs <= this.clockEpochMs
    ) {
      fail("MIRROR_EXPIRED", "an active mirror requires future validity");
    }
  }

  private changeStatus(
    actor: string,
    record: LabelContractRecord,
    status: LabelContractRecord["status"],
  ): LabelContractRecord {
    const previousStatus = record.status;
    record.status = status;
    record.updatedAtEpochMs = this.clockEpochMs;
    this.emit("LabelStatusChanged", actor, {
      labelId: record.labelId,
      previousStatus,
      status,
    });
    return cloneLabel(record);
  }

  private requireLabel(labelId: string): LabelContractRecord {
    const record = this.labels.get(labelId);
    if (!record) fail("NOT_FOUND", `label ${labelId} does not exist`);
    return record;
  }

  private requireRole(actor: string, role: LabelRole): void {
    if (!this.roles.get(role)?.has(actor)) {
      fail("UNAUTHORIZED", `${actor} does not have ${role}`);
    }
  }

  private publicEventData(
    record: LabelContractRecord,
  ): ContractEvent["data"] {
    return {
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
      algorithmSourceStateHash: record.algorithmSourceStateHash,
      algorithmSourceBlockHeight: record.algorithmSourceBlockHeight,
      status: record.status,
    };
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
