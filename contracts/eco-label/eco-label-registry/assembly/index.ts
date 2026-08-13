import {
  assert,
  BaseContract,
  JSON,
  my,
  Storage,
  StorageMap,
} from "@antchain/myassembly";

const ROLE_DEFAULT_ADMIN = "DEFAULT_ADMIN";
const ROLE_ALGORITHM_MIRROR_ADMIN = "ALGORITHM_MIRROR_ADMIN";
const ROLE_LABEL_ISSUER = "LABEL_ISSUER";
const ROLE_LABEL_LIFECYCLE_ADMIN = "LABEL_LIFECYCLE_ADMIN";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_SUSPENDED = "SUSPENDED";
const STATUS_REVOKED = "REVOKED";
const STATUS_EXPIRED = "EXPIRED";
const STATUS_SUPERSEDED = "SUPERSEDED";

/**
 * AntChain Myfish/AssemblyScript implementation of the EDDL issuance and
 * lifecycle registry. No score, grade, BOM, evidence file, or indicator value
 * is accepted by any exported method.
 */
export default class EcoLabelRegistry extends BaseContract {
  private initialized: Storage<bool> = new Storage<bool>("initialized", false);
  private algorithmRegistryId: Storage<string> = new Storage<string>(
    "algorithmRegistryId",
    "",
  );
  private roles: StorageMap<string, string> = new StorageMap<string, string>(
    "roles",
    new Map<string, string>(),
  );
  private labels: StorageMap<string, string> = new StorageMap<string, string>(
    "labels",
    new Map<string, string>(),
  );
  private taskToLabel: StorageMap<string, string> = new StorageMap<
    string,
    string
  >(
    "taskToLabel",
    new Map<string, string>(),
  );
  private algorithmMirrors: StorageMap<string, string> = new StorageMap<
    string,
    string
  >(
    "algorithmMirrors",
    new Map<string, string>(),
  );
  private activeMirrorByScheme: StorageMap<string, string> = new StorageMap<
    string,
    string
  >(
    "activeMirrorByScheme",
    new Map<string, string>(),
  );

  @EXPORT
  public initialize(algorithmRegistryContractId: string): void {
    assert(!this.initialized.getData(), "ALREADY_INITIALIZED");
    this.requireIdentity(
      algorithmRegistryContractId,
      "algorithmRegistryContractId",
    );
    const sender = my.getSender().str;
    this.algorithmRegistryId.setData(algorithmRegistryContractId);
    this.roles.setItem(this.roleKey(ROLE_DEFAULT_ADMIN, sender), "1");
    this.roles.setItem(this.roleKey(ROLE_ALGORITHM_MIRROR_ADMIN, sender), "1");
    this.roles.setItem(this.roleKey(ROLE_LABEL_ISSUER, sender), "1");
    this.roles.setItem(this.roleKey(ROLE_LABEL_LIFECYCLE_ADMIN, sender), "1");
    this.initialized.setData(true);
    this.emitRoleEvent("RoleGranted", ROLE_DEFAULT_ADMIN, sender, sender);
    this.emitRoleEvent(
      "RoleGranted",
      ROLE_ALGORITHM_MIRROR_ADMIN,
      sender,
      sender,
    );
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

  /**
   * Returns the immutable AlgorithmRegistry identity fixed by initialize().
   * External verifiers use this readback instead of trusting deployment-side
   * configuration alone.
   */
  @EXPORT
  public getAlgorithmRegistryContractId(): string {
    this.requireInitialized();
    return this.algorithmRegistryId.getData();
  }

  /**
   * Mirrors a state that the coordinator has independently read from the
   * pinned AlgorithmRegistry. The target research chain cannot execute a
   * reliable Myfish cross-contract call, so this is an explicitly governed
   * attestation rather than an on-chain proof of the source state.
   *
   * sourceStateHash commits to the pinned registry identity, the complete
   * getAlgorithm readback, active algorithm id and source block height.
   */
  @EXPORT
  public syncAlgorithmState(
    algorithmId: string,
    schemeId: string,
    version: string,
    algorithmHash: string,
    evaluatorHash: string,
    status: string,
    sourceStateHash: string,
    sourceBlockHeight: u64,
    validUntil: u64,
  ): string {
    this.requireInitialized();
    this.requireRole(ROLE_ALGORITHM_MIRROR_ADMIN);
    this.requireIdentifier(algorithmId, "algorithmId", 128);
    this.requireIdentifier(schemeId, "schemeId", 128);
    this.requireIdentifier(version, "version", 64);
    this.requireCommitment(algorithmHash, "algorithmHash");
    this.requireCommitment(evaluatorHash, "evaluatorHash");
    this.requireAlgorithmStatus(status);
    this.requireCommitment(sourceStateHash, "sourceStateHash");
    assert(sourceBlockHeight > 0, "INVALID_SOURCE_BLOCK_HEIGHT");
    const now = my.getBlockTimeStamp();
    if (status == STATUS_ACTIVE) {
      assert(validUntil > now, "MIRROR_EXPIRED");
    }

    const existing = this.algorithmMirrors.getItem(algorithmId);
    let previousStatus = "";
    if (existing != null) {
      const previous = (existing as string).split("|");
      assert(previous.length == 10, "CORRUPT_STATE");
      assert(
        previous[0] == schemeId && previous[1] == version &&
          previous[2] == algorithmHash && previous[3] == evaluatorHash,
        "MIRROR_METADATA_CONFLICT",
      );
      const previousHeight = U64.parseInt(previous[6]);
      assert(sourceBlockHeight >= previousHeight, "STALE_SOURCE_STATE");
      if (sourceBlockHeight == previousHeight) {
        assert(
          previous[4] == status && previous[5] == sourceStateHash &&
            previous[7] == validUntil.toString(),
          "IDEMPOTENCY_CONFLICT",
        );
        return this.algorithmMirrorJson(algorithmId, previous);
      }
      assert(previous[4] != "RETIRED" || status == "RETIRED", "TERMINAL_STATE");
      previousStatus = previous[4];
      if (previousStatus == STATUS_ACTIVE && status != STATUS_ACTIVE) {
        const active = this.activeMirrorByScheme.getItem(schemeId);
        if (active != null && (active as string) == algorithmId) {
          this.activeMirrorByScheme.deleteItem(schemeId);
        }
      }
    }

    if (status == STATUS_ACTIVE) {
      const active = this.activeMirrorByScheme.getItem(schemeId);
      assert(
        active == null || (active as string) == algorithmId,
        "ACTIVE_VERSION_CONFLICT",
      );
      this.activeMirrorByScheme.setItem(schemeId, algorithmId);
    }
    const sender = my.getSender().str;
    const record = schemeId + "|" + version + "|" + algorithmHash + "|" +
      evaluatorHash + "|" + status + "|" + sourceStateHash + "|" +
      sourceBlockHeight.toString() + "|" + validUntil.toString() + "|" +
      sender + "|" + now.toString();
    this.algorithmMirrors.setItem(algorithmId, record);
    const event = JSON.Value.Object();
    event.set("algorithmId", algorithmId);
    event.set("schemeId", schemeId);
    event.set("version", version);
    event.set("algorithmHash", algorithmHash);
    event.set("evaluatorHash", evaluatorHash);
    event.set("status", status);
    if (previousStatus.length > 0) event.set("previousStatus", previousStatus);
    event.set("sourceStateHash", sourceStateHash);
    event.set("sourceBlockHeight", sourceBlockHeight.toString());
    event.set("validUntil", validUntil.toString());
    event.set("syncer", sender);
    event.set("blockTimestamp", now.toString());
    my.log<string>(event.toString(), [
      "AlgorithmStateMirrored",
      algorithmId,
      status,
    ]);
    return this.getAlgorithmStateMirror(algorithmId);
  }

  @EXPORT
  public getAlgorithmStateMirror(algorithmId: string): string {
    return this.algorithmMirrorJson(
      algorithmId,
      this.requireAlgorithmMirrorParts(algorithmId),
    );
  }

  @EXPORT
  public getActiveMirroredAlgorithmId(schemeId: string): string {
    const active = this.activeMirrorByScheme.getItem(schemeId);
    return active == null ? "" : active as string;
  }

  @EXPORT
  public isMirroredAlgorithmActive(
    algorithmId: string,
    algorithmHash: string,
  ): string {
    return this.isAlgorithmMirrorActive(algorithmId, algorithmHash) ? "1" : "0";
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
    if (parts[9] == STATUS_SUSPENDED) return this.labelJson(labelId, parts);
    assert(parts[9] == STATUS_ACTIVE, "INVALID_TRANSITION");
    return this.changeStatus(labelId, parts, STATUS_SUSPENDED);
  }

  @EXPORT
  public resumeLabel(labelId: string): string {
    this.requireInitialized();
    this.requireRole(ROLE_LABEL_LIFECYCLE_ADMIN);
    const parts = this.requireLabelParts(labelId);
    if (parts[9] == STATUS_ACTIVE) return this.labelJson(labelId, parts);
    assert(parts[9] == STATUS_SUSPENDED, "INVALID_TRANSITION");
    const expiry = U64.parseInt(parts[8]);
    assert(
      expiry == 0 || expiry > my.getBlockTimeStamp(),
      "LABEL_EXPIRED",
    );
    return this.changeStatus(labelId, parts, STATUS_ACTIVE);
  }

  @EXPORT
  public revokeLabel(labelId: string, reasonHash: string): string {
    this.requireInitialized();
    this.requireRole(ROLE_LABEL_LIFECYCLE_ADMIN);
    this.requireCommitment(reasonHash, "reasonHash");
    const parts = this.requireLabelParts(labelId);
    if (parts[9] == STATUS_REVOKED) {
      assert(parts[13] == reasonHash, "IDEMPOTENCY_CONFLICT");
      return this.labelJson(labelId, parts);
    }
    assert(
      parts[9] != STATUS_EXPIRED && parts[9] != STATUS_SUPERSEDED,
      "TERMINAL_STATE",
    );
    const previous = parts[9];
    parts[9] = STATUS_REVOKED;
    parts[12] = my.getBlockTimeStamp().toString();
    parts[13] = reasonHash;
    this.labels.setItem(labelId, parts.join("|"));
    const event = JSON.Value.Object();
    event.set("labelId", labelId);
    event.set("previousStatus", previous);
    event.set("status", STATUS_REVOKED);
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
    if (parts[9] == STATUS_EXPIRED) return this.labelJson(labelId, parts);
    assert(
      parts[9] == STATUS_ACTIVE || parts[9] == STATUS_SUSPENDED,
      "TERMINAL_STATE",
    );
    const expiry = U64.parseInt(parts[8]);
    assert(
      expiry > 0 && expiry <= my.getBlockTimeStamp(),
      "NOT_DUE",
    );
    return this.changeStatus(labelId, parts, STATUS_EXPIRED);
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
      previous[9] == STATUS_ACTIVE || previous[9] == STATUS_SUSPENDED,
      "TERMINAL_STATE",
    );
    assert(previousLabelId != labelId, "INVALID_ARGUMENT");
    const replacementJson = this.issueInternal(
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
    previous[9] = STATUS_SUPERSEDED;
    previous[12] = my.getBlockTimeStamp().toString();
    previous[15] = labelId;
    this.labels.setItem(previousLabelId, previous.join("|"));
    const event = JSON.Value.Object();
    event.set("labelId", previousLabelId);
    event.set("replacedByLabelId", labelId);
    event.set("status", STATUS_SUPERSEDED);
    event.set("actor", my.getSender().str);
    event.set("blockTimestamp", previous[12]);
    my.log<string>(event.toString(), [
      "LabelSuperseded",
      previousLabelId,
      labelId,
    ]);
    return replacementJson;
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
    const existing = this.labels.getItem(labelId);
    if (existing != null) {
      const existingParts = this.requireLabelParts(labelId);
      assert(
        existingParts[0] == taskId && existingParts[1] == algorithmId &&
          existingParts[2] == algorithmHash && existingParts[3] == inputHash &&
          existingParts[4] == resultHash &&
          existingParts[5] == evidenceHash &&
          existingParts[6] == authorizationHash &&
          existingParts[7] == proofHash &&
          existingParts[8] == expiresAt.toString() &&
          existingParts[14] == replacesLabelId,
        "IDEMPOTENCY_CONFLICT",
      );
      return this.labelJson(labelId, existingParts);
    }
    const boundLabel = this.taskToLabel.getItem(taskId);
    assert(boundLabel == null, "IDEMPOTENCY_CONFLICT");
    const mirror = this.requireAlgorithmMirrorParts(algorithmId);
    assert(
      this.isAlgorithmMirrorActiveParts(algorithmId, algorithmHash, mirror),
      "ALGORITHM_NOT_ACTIVE",
    );
    const sender = my.getSender().str;
    const record = taskId + "|" + algorithmId + "|" + algorithmHash + "|" +
      inputHash + "|" + resultHash + "|" + evidenceHash + "|" +
      authorizationHash + "|" + proofHash + "|" + expiresAt.toString() +
      "|" + STATUS_ACTIVE + "|" + sender + "|" + now.toString() + "|" +
      now.toString() + "||" + replacesLabelId + "||" + mirror[5] + "|" +
      mirror[6];
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
    event.set("algorithmSourceStateHash", mirror[5]);
    event.set("algorithmSourceBlockHeight", mirror[6]);
    event.set("expiresAt", expiresAt.toString());
    event.set("status", STATUS_ACTIVE);
    event.set("issuer", sender);
    event.set("blockTimestamp", now.toString());
    my.log<string>(event.toString(), ["LabelIssued", labelId, taskId]);
    return this.getLabel(labelId);
  }

  private isAlgorithmMirrorActive(
    algorithmId: string,
    algorithmHash: string,
  ): bool {
    const stored = this.algorithmMirrors.getItem(algorithmId);
    if (stored == null) return false;
    const parts = (stored as string).split("|");
    if (parts.length != 10) return false;
    return this.isAlgorithmMirrorActiveParts(algorithmId, algorithmHash, parts);
  }

  private isAlgorithmMirrorActiveParts(
    algorithmId: string,
    algorithmHash: string,
    parts: string[],
  ): bool {
    const active = this.activeMirrorByScheme.getItem(parts[0]);
    return parts[4] == STATUS_ACTIVE && parts[2] == algorithmHash &&
      active != null && (active as string) == algorithmId &&
      U64.parseInt(parts[7]) > my.getBlockTimeStamp();
  }

  private changeStatus(
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
      role == ROLE_DEFAULT_ADMIN || role == ROLE_ALGORITHM_MIRROR_ADMIN ||
        role == ROLE_LABEL_ISSUER ||
        role == ROLE_LABEL_LIFECYCLE_ADMIN,
      "UNKNOWN_ROLE",
    );
  }

  private requireAlgorithmStatus(status: string): void {
    assert(
      status == "DRAFT" || status == STATUS_ACTIVE ||
        status == STATUS_SUSPENDED ||
        status == "RETIRED",
      "INVALID_STATUS",
    );
  }

  private requireAlgorithmMirrorParts(algorithmId: string): string[] {
    const stored = this.algorithmMirrors.getItem(algorithmId);
    assert(stored != null, "NOT_FOUND");
    const parts = (stored as string).split("|");
    assert(parts.length == 10, "CORRUPT_STATE");
    return parts;
  }

  private requireLabelParts(labelId: string): string[] {
    const stored = this.labels.getItem(labelId);
    assert(stored != null, "NOT_FOUND");
    const parts = (stored as string).split("|");
    assert(parts.length == 18, "CORRUPT_STATE");
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
    value.set("algorithmSourceStateHash", parts[16]);
    value.set("algorithmSourceBlockHeight", parts[17]);
    return value.toString();
  }

  private algorithmMirrorJson(algorithmId: string, parts: string[]): string {
    const value = JSON.Value.Object();
    value.set("algorithmId", algorithmId);
    value.set("schemeId", parts[0]);
    value.set("version", parts[1]);
    value.set("algorithmHash", parts[2]);
    value.set("evaluatorHash", parts[3]);
    value.set("status", parts[4]);
    value.set("sourceStateHash", parts[5]);
    value.set("sourceBlockHeight", parts[6]);
    value.set("validUntil", parts[7]);
    value.set("syncer", parts[8]);
    value.set("updatedAt", parts[9]);
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
}
