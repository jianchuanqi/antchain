import {
  assert,
  BaseContract,
  JSON,
  my,
  Storage,
  StorageMap,
} from "@antchain/myassembly";

const ROLE_DEFAULT_ADMIN = "DEFAULT_ADMIN";
const ROLE_ALGORITHM_ADMIN = "ALGORITHM_ADMIN";
const ROLE_LABEL_ISSUER = "LABEL_ISSUER";
const ROLE_LABEL_LIFECYCLE_ADMIN = "LABEL_LIFECYCLE_ADMIN";

const ALGORITHM_DRAFT = "DRAFT";
const ALGORITHM_ACTIVE = "ACTIVE";
const ALGORITHM_SUSPENDED = "SUSPENDED";
const ALGORITHM_RETIRED = "RETIRED";

const LABEL_ACTIVE = "ACTIVE";
const LABEL_SUSPENDED = "SUSPENDED";
const LABEL_REVOKED = "REVOKED";
const LABEL_EXPIRED = "EXPIRED";
const LABEL_SUPERSEDED = "SUPERSEDED";

/**
 * Unified Myfish registry for EDDL rule governance and label lifecycle.
 * Scoring remains in the version-pinned EDDL service. The contract accepts
 * identifiers and sha256 commitments only.
 */
export default class EcoDesignLabelRegistry extends BaseContract {
  private initialized: Storage<bool> = new Storage<bool>("initialized", false);
  private roles: StorageMap<string, string> = new StorageMap<string, string>(
    "roles",
    new Map<string, string>(),
  );
  private algorithms: StorageMap<string, string> = new StorageMap<
    string,
    string
  >("algorithms", new Map<string, string>());
  private activeAlgorithmByScheme: StorageMap<string, string> = new StorageMap<
    string,
    string
  >("activeAlgorithmByScheme", new Map<string, string>());
  private labels: StorageMap<string, string> = new StorageMap<string, string>(
    "labels",
    new Map<string, string>(),
  );
  private taskToLabel: StorageMap<string, string> = new StorageMap<
    string,
    string
  >("taskToLabel", new Map<string, string>());

  @EXPORT
  public initialize(): void {
    assert(!this.initialized.getData(), "ALREADY_INITIALIZED");
    const sender = my.getSender().str;
    this.roles.setItem(this.roleKey(ROLE_DEFAULT_ADMIN, sender), "1");
    this.roles.setItem(this.roleKey(ROLE_ALGORITHM_ADMIN, sender), "1");
    this.roles.setItem(this.roleKey(ROLE_LABEL_ISSUER, sender), "1");
    this.roles.setItem(
      this.roleKey(ROLE_LABEL_LIFECYCLE_ADMIN, sender),
      "1",
    );
    this.initialized.setData(true);
    this.emitRoleEvent("RoleGranted", ROLE_DEFAULT_ADMIN, sender, sender);
    this.emitRoleEvent("RoleGranted", ROLE_ALGORITHM_ADMIN, sender, sender);
    this.emitRoleEvent("RoleGranted", ROLE_LABEL_ISSUER, sender, sender);
    this.emitRoleEvent(
      "RoleGranted",
      ROLE_LABEL_LIFECYCLE_ADMIN,
      sender,
      sender,
    );
  }

  @EXPORT
  public grantRole(role: string, account: string): void {
    this.requireInitialized();
    this.requireRole(ROLE_DEFAULT_ADMIN);
    this.requireKnownRole(role);
    this.requireIdentity(account, "account");
    const key = this.roleKey(role, account);
    if (this.roles.hasItem(key)) return;
    this.roles.setItem(key, "1");
    this.emitRoleEvent("RoleGranted", role, account, my.getSender().str);
  }

  @EXPORT
  public revokeRole(role: string, account: string): void {
    this.requireInitialized();
    this.requireRole(ROLE_DEFAULT_ADMIN);
    this.requireKnownRole(role);
    this.requireIdentity(account, "account");
    const sender = my.getSender().str;
    assert(
      !(role == ROLE_DEFAULT_ADMIN && account == sender),
      "LAST_ADMIN_GUARD",
    );
    const key = this.roleKey(role, account);
    if (!this.roles.hasItem(key)) return;
    this.roles.deleteItem(key);
    this.emitRoleEvent("RoleRevoked", role, account, sender);
  }

  @EXPORT
  public hasRole(role: string, account: string): bool {
    return this.roles.hasItem(this.roleKey(role, account));
  }

  @EXPORT
  public registerAlgorithm(
    algorithmId: string,
    schemeId: string,
    version: string,
    algorithmHash: string,
    evaluatorHash: string,
  ): string {
    this.requireInitialized();
    this.requireRole(ROLE_ALGORITHM_ADMIN);
    this.requireIdentifier(algorithmId, "algorithmId", 128);
    this.requireIdentifier(schemeId, "schemeId", 128);
    this.requireIdentifier(version, "version", 64);
    this.requireCommitment(algorithmHash, "algorithmHash");
    this.requireCommitment(evaluatorHash, "evaluatorHash");
    const existing = this.algorithms.getItem(algorithmId);
    const now = my.getBlockTimeStamp();
    const sender = my.getSender().str;
    if (existing != null) {
      const parts = (existing as string).split("|");
      assert(parts.length == 8, "CORRUPT_STATE");
      assert(
        parts[0] == schemeId && parts[1] == version &&
          parts[2] == algorithmHash && parts[3] == evaluatorHash,
        "IDEMPOTENCY_CONFLICT",
      );
      return this.algorithmJson(algorithmId, parts);
    }
    const record = schemeId + "|" + version + "|" + algorithmHash + "|" +
      evaluatorHash + "|" + ALGORITHM_DRAFT + "|" + sender + "|" +
      now.toString() + "|" + now.toString();
    this.algorithms.setItem(algorithmId, record);
    const event = JSON.Value.Object();
    event.set("algorithmId", algorithmId);
    event.set("schemeId", schemeId);
    event.set("version", version);
    event.set("algorithmHash", algorithmHash);
    event.set("evaluatorHash", evaluatorHash);
    event.set("status", ALGORITHM_DRAFT);
    event.set("publisher", sender);
    event.set("blockTimestamp", now.toString());
    my.log<string>(event.toString(), [
      "AlgorithmRegistered",
      algorithmId,
      schemeId,
    ]);
    return this.getAlgorithm(algorithmId);
  }

  @EXPORT
  public setAlgorithmStatus(algorithmId: string, status: string): string {
    this.requireInitialized();
    this.requireRole(ROLE_ALGORITHM_ADMIN);
    this.requireAlgorithmStatus(status);
    const parts = this.requireAlgorithmParts(algorithmId);
    const previous = parts[4];
    if (previous == status) return this.algorithmJson(algorithmId, parts);
    assert(previous != ALGORITHM_RETIRED, "TERMINAL_STATE");
    const allowed = (previous == ALGORITHM_DRAFT &&
      (status == ALGORITHM_ACTIVE || status == ALGORITHM_RETIRED)) ||
      (previous == ALGORITHM_ACTIVE &&
        (status == ALGORITHM_SUSPENDED || status == ALGORITHM_RETIRED)) ||
      (previous == ALGORITHM_SUSPENDED &&
        (status == ALGORITHM_ACTIVE || status == ALGORITHM_RETIRED));
    assert(allowed, "INVALID_TRANSITION");
    if (status == ALGORITHM_ACTIVE) {
      const active = this.activeAlgorithmByScheme.getItem(parts[0]);
      assert(
        active == null || (active as string) == algorithmId,
        "ACTIVE_VERSION_CONFLICT",
      );
      this.activeAlgorithmByScheme.setItem(parts[0], algorithmId);
    } else if (previous == ALGORITHM_ACTIVE) {
      this.activeAlgorithmByScheme.deleteItem(parts[0]);
    }
    parts[4] = status;
    parts[7] = my.getBlockTimeStamp().toString();
    this.algorithms.setItem(algorithmId, parts.join("|"));
    this.emitAlgorithmStatusEvent(algorithmId, previous, status);
    return this.algorithmJson(algorithmId, parts);
  }

  @EXPORT
  public replaceActiveAlgorithm(
    currentAlgorithmId: string,
    replacementAlgorithmId: string,
  ): string {
    this.requireInitialized();
    this.requireRole(ROLE_ALGORITHM_ADMIN);
    const current = this.requireAlgorithmParts(currentAlgorithmId);
    const replacement = this.requireAlgorithmParts(replacementAlgorithmId);
    assert(current[4] == ALGORITHM_ACTIVE, "INVALID_TRANSITION");
    assert(
      replacement[4] == ALGORITHM_DRAFT ||
        replacement[4] == ALGORITHM_SUSPENDED,
      "INVALID_TRANSITION",
    );
    assert(current[0] == replacement[0], "SCHEME_MISMATCH");
    const replacementPrevious = replacement[4];
    const timestamp = my.getBlockTimeStamp().toString();
    current[4] = ALGORITHM_SUSPENDED;
    current[7] = timestamp;
    replacement[4] = ALGORITHM_ACTIVE;
    replacement[7] = timestamp;
    this.algorithms.setItem(currentAlgorithmId, current.join("|"));
    this.algorithms.setItem(replacementAlgorithmId, replacement.join("|"));
    this.activeAlgorithmByScheme.setItem(current[0], replacementAlgorithmId);
    this.emitAlgorithmStatusEvent(
      currentAlgorithmId,
      ALGORITHM_ACTIVE,
      ALGORITHM_SUSPENDED,
    );
    this.emitAlgorithmStatusEvent(
      replacementAlgorithmId,
      replacementPrevious,
      ALGORITHM_ACTIVE,
    );
    const event = JSON.Value.Object();
    event.set("schemeId", current[0]);
    event.set("previousAlgorithmId", currentAlgorithmId);
    event.set("algorithmId", replacementAlgorithmId);
    event.set("actor", my.getSender().str);
    event.set("blockTimestamp", timestamp);
    my.log<string>(event.toString(), ["AlgorithmReplaced", current[0]]);
    return this.algorithmJson(replacementAlgorithmId, replacement);
  }

  @EXPORT
  public getAlgorithm(algorithmId: string): string {
    return this.algorithmJson(
      algorithmId,
      this.requireAlgorithmParts(algorithmId),
    );
  }

  @EXPORT
  public getActiveAlgorithmId(schemeId: string): string {
    const active = this.activeAlgorithmByScheme.getItem(schemeId);
    return active == null ? "" : active as string;
  }

  @EXPORT
  public isAlgorithmActive(algorithmId: string, algorithmHash: string): string {
    return this.isAlgorithmActiveInternal(algorithmId, algorithmHash)
      ? "1"
      : "0";
  }

  @EXPORT
  public issueLabel(
    labelId: string,
    taskId: string,
    algorithmId: string,
    algorithmHash: string,
    inputHash: string,
    resultHash: string,
    evidenceHash: string,
    authorizationHash: string,
    proofHash: string,
    expiresAt: u64,
  ): string {
    this.requireInitialized();
    this.requireRole(ROLE_LABEL_ISSUER);
    return this.issueInternal(
      labelId,
      taskId,
      algorithmId,
      algorithmHash,
      inputHash,
      resultHash,
      evidenceHash,
      authorizationHash,
      proofHash,
      expiresAt,
      "",
    );
  }

  @EXPORT
  public suspendLabel(labelId: string): string {
    this.requireInitialized();
    this.requireRole(ROLE_LABEL_LIFECYCLE_ADMIN);
    const parts = this.requireLabelParts(labelId);
    if (parts[9] == LABEL_SUSPENDED) return this.labelJson(labelId, parts);
    assert(parts[9] == LABEL_ACTIVE, "INVALID_TRANSITION");
    return this.changeLabelStatus(labelId, parts, LABEL_SUSPENDED);
  }

  @EXPORT
  public resumeLabel(labelId: string): string {
    this.requireInitialized();
    this.requireRole(ROLE_LABEL_LIFECYCLE_ADMIN);
    const parts = this.requireLabelParts(labelId);
    if (parts[9] == LABEL_ACTIVE) return this.labelJson(labelId, parts);
    assert(parts[9] == LABEL_SUSPENDED, "INVALID_TRANSITION");
    const expiry = U64.parseInt(parts[8]);
    assert(expiry == 0 || expiry > my.getBlockTimeStamp(), "LABEL_EXPIRED");
    return this.changeLabelStatus(labelId, parts, LABEL_ACTIVE);
  }

  @EXPORT
  public revokeLabel(labelId: string, reasonHash: string): string {
    this.requireInitialized();
    this.requireRole(ROLE_LABEL_LIFECYCLE_ADMIN);
    this.requireCommitment(reasonHash, "reasonHash");
    const parts = this.requireLabelParts(labelId);
    if (parts[9] == LABEL_REVOKED) {
      assert(parts[13] == reasonHash, "IDEMPOTENCY_CONFLICT");
      return this.labelJson(labelId, parts);
    }
    assert(
      parts[9] != LABEL_EXPIRED && parts[9] != LABEL_SUPERSEDED,
      "TERMINAL_STATE",
    );
    const previous = parts[9];
    parts[9] = LABEL_REVOKED;
    parts[12] = my.getBlockTimeStamp().toString();
    parts[13] = reasonHash;
    this.labels.setItem(labelId, parts.join("|"));
    const event = JSON.Value.Object();
    event.set("labelId", labelId);
    event.set("previousStatus", previous);
    event.set("status", LABEL_REVOKED);
    event.set("reasonHash", reasonHash);
    event.set("actor", my.getSender().str);
    event.set("blockTimestamp", parts[12]);
    my.log<string>(event.toString(), ["LabelRevoked", labelId]);
    return this.labelJson(labelId, parts);
  }

  @EXPORT
  public expireLabel(labelId: string): string {
    this.requireInitialized();
    const parts = this.requireLabelParts(labelId);
    if (parts[9] == LABEL_EXPIRED) return this.labelJson(labelId, parts);
    assert(
      parts[9] == LABEL_ACTIVE || parts[9] == LABEL_SUSPENDED,
      "TERMINAL_STATE",
    );
    const expiry = U64.parseInt(parts[8]);
    assert(expiry > 0 && expiry <= my.getBlockTimeStamp(), "NOT_DUE");
    return this.changeLabelStatus(labelId, parts, LABEL_EXPIRED);
  }

  @EXPORT
  public replaceLabel(
    previousLabelId: string,
    labelId: string,
    taskId: string,
    algorithmId: string,
    algorithmHash: string,
    inputHash: string,
    resultHash: string,
    evidenceHash: string,
    authorizationHash: string,
    proofHash: string,
    expiresAt: u64,
  ): string {
    this.requireInitialized();
    this.requireRole(ROLE_LABEL_ISSUER);
    this.requireRole(ROLE_LABEL_LIFECYCLE_ADMIN);
    const previous = this.requireLabelParts(previousLabelId);
    assert(
      previous[9] == LABEL_ACTIVE || previous[9] == LABEL_SUSPENDED,
      "TERMINAL_STATE",
    );
    assert(previousLabelId != labelId, "INVALID_ARGUMENT");
    const replacement = this.issueInternal(
      labelId,
      taskId,
      algorithmId,
      algorithmHash,
      inputHash,
      resultHash,
      evidenceHash,
      authorizationHash,
      proofHash,
      expiresAt,
      previousLabelId,
    );
    previous[9] = LABEL_SUPERSEDED;
    previous[12] = my.getBlockTimeStamp().toString();
    previous[15] = labelId;
    this.labels.setItem(previousLabelId, previous.join("|"));
    const event = JSON.Value.Object();
    event.set("labelId", previousLabelId);
    event.set("replacedByLabelId", labelId);
    event.set("status", LABEL_SUPERSEDED);
    event.set("actor", my.getSender().str);
    event.set("blockTimestamp", previous[12]);
    my.log<string>(event.toString(), [
      "LabelSuperseded",
      previousLabelId,
      labelId,
    ]);
    return replacement;
  }

  @EXPORT
  public getLabel(labelId: string): string {
    return this.labelJson(labelId, this.requireLabelParts(labelId));
  }

  @EXPORT
  public getLabelByTaskId(taskId: string): string {
    const labelId = this.taskToLabel.getItem(taskId);
    assert(labelId != null, "NOT_FOUND");
    return this.getLabel(labelId as string);
  }

  private issueInternal(
    labelId: string,
    taskId: string,
    algorithmId: string,
    algorithmHash: string,
    inputHash: string,
    resultHash: string,
    evidenceHash: string,
    authorizationHash: string,
    proofHash: string,
    expiresAt: u64,
    replacesLabelId: string,
  ): string {
    this.requireIdentifier(labelId, "labelId", 128);
    this.requireIdentifier(taskId, "taskId", 128);
    this.requireIdentifier(algorithmId, "algorithmId", 128);
    this.requireCommitment(algorithmHash, "algorithmHash");
    this.requireCommitment(inputHash, "inputHash");
    this.requireCommitment(resultHash, "resultHash");
    this.requireCommitment(evidenceHash, "evidenceHash");
    this.requireCommitment(authorizationHash, "authorizationHash");
    this.requireCommitment(proofHash, "proofHash");
    const now = my.getBlockTimeStamp();
    assert(expiresAt == 0 || expiresAt > now, "INVALID_EXPIRY");
    assert(
      this.isAlgorithmActiveInternal(algorithmId, algorithmHash),
      "ALGORITHM_NOT_ACTIVE",
    );
    const existing = this.labels.getItem(labelId);
    if (existing != null) {
      const parts = this.requireLabelParts(labelId);
      assert(
        parts[0] == taskId && parts[1] == algorithmId &&
          parts[2] == algorithmHash && parts[3] == inputHash &&
          parts[4] == resultHash && parts[5] == evidenceHash &&
          parts[6] == authorizationHash && parts[7] == proofHash &&
          parts[8] == expiresAt.toString() &&
          parts[14] == replacesLabelId,
        "IDEMPOTENCY_CONFLICT",
      );
      return this.labelJson(labelId, parts);
    }
    assert(this.taskToLabel.getItem(taskId) == null, "IDEMPOTENCY_CONFLICT");
    const sender = my.getSender().str;
    const record = taskId + "|" + algorithmId + "|" + algorithmHash + "|" +
      inputHash + "|" + resultHash + "|" + evidenceHash + "|" +
      authorizationHash + "|" + proofHash + "|" + expiresAt.toString() +
      "|" + LABEL_ACTIVE + "|" + sender + "|" + now.toString() + "|" +
      now.toString() + "||" + replacesLabelId + "|";
    this.labels.setItem(labelId, record);
    this.taskToLabel.setItem(taskId, labelId);
    const event = JSON.Value.Object();
    event.set("labelId", labelId);
    event.set("taskId", taskId);
    event.set("algorithmId", algorithmId);
    event.set("algorithmHash", algorithmHash);
    event.set("inputHash", inputHash);
    event.set("resultHash", resultHash);
    event.set("evidenceHash", evidenceHash);
    event.set("authorizationHash", authorizationHash);
    event.set("proofHash", proofHash);
    event.set("expiresAt", expiresAt.toString());
    event.set("status", LABEL_ACTIVE);
    event.set("issuer", sender);
    event.set("blockTimestamp", now.toString());
    my.log<string>(event.toString(), ["LabelIssued", labelId, taskId]);
    return this.getLabel(labelId);
  }

  private isAlgorithmActiveInternal(
    algorithmId: string,
    algorithmHash: string,
  ): bool {
    const stored = this.algorithms.getItem(algorithmId);
    if (stored == null) return false;
    const parts = (stored as string).split("|");
    if (parts.length != 8) return false;
    const active = this.activeAlgorithmByScheme.getItem(parts[0]);
    return parts[4] == ALGORITHM_ACTIVE && parts[2] == algorithmHash &&
      active != null && (active as string) == algorithmId;
  }

  private changeLabelStatus(
    labelId: string,
    parts: string[],
    status: string,
  ): string {
    const previous = parts[9];
    parts[9] = status;
    parts[12] = my.getBlockTimeStamp().toString();
    this.labels.setItem(labelId, parts.join("|"));
    const event = JSON.Value.Object();
    event.set("labelId", labelId);
    event.set("previousStatus", previous);
    event.set("status", status);
    event.set("actor", my.getSender().str);
    event.set("blockTimestamp", parts[12]);
    my.log<string>(event.toString(), ["LabelStatusChanged", labelId, status]);
    return this.labelJson(labelId, parts);
  }

  private requireInitialized(): void {
    assert(this.initialized.getData(), "NOT_INITIALIZED");
  }

  private requireRole(role: string): void {
    assert(this.hasRole(role, my.getSender().str), "UNAUTHORIZED");
  }

  private requireKnownRole(role: string): void {
    assert(
      role == ROLE_DEFAULT_ADMIN || role == ROLE_ALGORITHM_ADMIN ||
        role == ROLE_LABEL_ISSUER || role == ROLE_LABEL_LIFECYCLE_ADMIN,
      "UNKNOWN_ROLE",
    );
  }

  private requireAlgorithmStatus(status: string): void {
    assert(
      status == ALGORITHM_DRAFT || status == ALGORITHM_ACTIVE ||
        status == ALGORITHM_SUSPENDED || status == ALGORITHM_RETIRED,
      "INVALID_STATUS",
    );
  }

  private requireAlgorithmParts(algorithmId: string): string[] {
    const stored = this.algorithms.getItem(algorithmId);
    assert(stored != null, "NOT_FOUND");
    const parts = (stored as string).split("|");
    assert(parts.length == 8, "CORRUPT_STATE");
    return parts;
  }

  private requireLabelParts(labelId: string): string[] {
    const stored = this.labels.getItem(labelId);
    assert(stored != null, "NOT_FOUND");
    const parts = (stored as string).split("|");
    assert(parts.length == 16, "CORRUPT_STATE");
    return parts;
  }

  private requireIdentifier(value: string, field: string, max: i32): void {
    assert(value.length > 0 && value.length <= max, "INVALID_" + field);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const valid = (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
        code == 45 || code == 46 || code == 58 || code == 95;
      assert(valid, "INVALID_" + field);
    }
  }

  private requireIdentity(value: string, field: string): void {
    assert(value.length == 64, "INVALID_" + field);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      assert(
        (code >= 48 && code <= 57) || (code >= 97 && code <= 102),
        "INVALID_" + field,
      );
    }
  }

  private requireCommitment(value: string, field: string): void {
    assert(
      value.length == 71 && value.startsWith("sha256:"),
      "INVALID_" + field,
    );
    for (let i = 7; i < value.length; i++) {
      const code = value.charCodeAt(i);
      assert(
        (code >= 48 && code <= 57) || (code >= 97 && code <= 102),
        "INVALID_" + field,
      );
    }
  }

  private roleKey(role: string, account: string): string {
    return role + "|" + account;
  }

  private algorithmJson(algorithmId: string, parts: string[]): string {
    const value = JSON.Value.Object();
    value.set("algorithmId", algorithmId);
    value.set("schemeId", parts[0]);
    value.set("version", parts[1]);
    value.set("algorithmHash", parts[2]);
    value.set("evaluatorHash", parts[3]);
    value.set("status", parts[4]);
    value.set("publisher", parts[5]);
    value.set("registeredAt", parts[6]);
    value.set("updatedAt", parts[7]);
    return value.toString();
  }

  private labelJson(labelId: string, parts: string[]): string {
    const value = JSON.Value.Object();
    value.set("labelId", labelId);
    value.set("taskId", parts[0]);
    value.set("algorithmId", parts[1]);
    value.set("algorithmHash", parts[2]);
    value.set("inputHash", parts[3]);
    value.set("resultHash", parts[4]);
    value.set("evidenceHash", parts[5]);
    value.set("authorizationHash", parts[6]);
    value.set("proofHash", parts[7]);
    value.set("expiresAt", parts[8]);
    value.set("status", parts[9]);
    value.set("issuer", parts[10]);
    value.set("issuedAt", parts[11]);
    value.set("updatedAt", parts[12]);
    if (parts[13].length > 0) value.set("reasonHash", parts[13]);
    if (parts[14].length > 0) value.set("replacesLabelId", parts[14]);
    if (parts[15].length > 0) value.set("replacedByLabelId", parts[15]);
    return value.toString();
  }

  private emitRoleEvent(
    name: string,
    role: string,
    account: string,
    actor: string,
  ): void {
    const event = JSON.Value.Object();
    event.set("role", role);
    event.set("account", account);
    event.set("actor", actor);
    event.set("blockTimestamp", my.getBlockTimeStamp().toString());
    my.log<string>(event.toString(), [name, role, account]);
  }

  private emitAlgorithmStatusEvent(
    algorithmId: string,
    previousStatus: string,
    status: string,
  ): void {
    const event = JSON.Value.Object();
    event.set("algorithmId", algorithmId);
    event.set("previousStatus", previousStatus);
    event.set("status", status);
    event.set("actor", my.getSender().str);
    event.set("blockTimestamp", my.getBlockTimeStamp().toString());
    my.log<string>(event.toString(), [
      "AlgorithmStatusChanged",
      algorithmId,
      status,
    ]);
  }
}
