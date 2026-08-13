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
const STATUS_DRAFT = "DRAFT";
const STATUS_ACTIVE = "ACTIVE";
const STATUS_SUSPENDED = "SUSPENDED";
const STATUS_RETIRED = "RETIRED";

/**
 * AntChain Myfish/AssemblyScript implementation of the rule and evaluator
 * registry. Storage contains public identifiers and SHA-256 commitments only.
 */
export default class AlgorithmRegistry extends BaseContract {
  private initialized: Storage<bool> = new Storage<bool>("initialized", false);
  private roles: StorageMap<string, string> = new StorageMap<string, string>(
    "roles",
    new Map<string, string>(),
  );
  private algorithms: StorageMap<string, string> = new StorageMap<
    string,
    string
  >(
    "algorithms",
    new Map<string, string>(),
  );
  private activeByScheme: StorageMap<string, string> = new StorageMap<
    string,
    string
  >(
    "activeByScheme",
    new Map<string, string>(),
  );

  @EXPORT
  public initialize(): void {
    assert(!this.initialized.getData(), "ALREADY_INITIALIZED");
    const sender = my.getSender().str;
    this.roles.setItem(this.roleKey(ROLE_DEFAULT_ADMIN, sender), "1");
    this.roles.setItem(this.roleKey(ROLE_ALGORITHM_ADMIN, sender), "1");
    this.initialized.setData(true);
    this.emitRoleEvent("RoleGranted", ROLE_DEFAULT_ADMIN, sender, sender);
    this.emitRoleEvent("RoleGranted", ROLE_ALGORITHM_ADMIN, sender, sender);
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
      assert(
        parts[0] == schemeId && parts[1] == version &&
          parts[2] == algorithmHash && parts[3] == evaluatorHash,
        "IDEMPOTENCY_CONFLICT",
      );
      return this.algorithmJson(algorithmId, parts);
    }
    const record = schemeId + "|" + version + "|" + algorithmHash + "|" +
      evaluatorHash + "|" + STATUS_DRAFT + "|" + sender + "|" +
      now.toString() + "|" + now.toString();
    this.algorithms.setItem(algorithmId, record);
    const event = JSON.Value.Object();
    event.set("algorithmId", algorithmId);
    event.set("schemeId", schemeId);
    event.set("version", version);
    event.set("algorithmHash", algorithmHash);
    event.set("evaluatorHash", evaluatorHash);
    event.set("status", STATUS_DRAFT);
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
    this.requireStatus(status);
    const parts = this.requireAlgorithmParts(algorithmId);
    const previous = parts[4];
    if (previous == status) return this.algorithmJson(algorithmId, parts);
    assert(previous != STATUS_RETIRED, "TERMINAL_STATE");
    const allowed = (previous == STATUS_DRAFT &&
      (status == STATUS_ACTIVE || status == STATUS_RETIRED)) ||
      (previous == STATUS_ACTIVE &&
        (status == STATUS_SUSPENDED || status == STATUS_RETIRED)) ||
      (previous == STATUS_SUSPENDED &&
        (status == STATUS_ACTIVE || status == STATUS_RETIRED));
    assert(allowed, "INVALID_TRANSITION");
    if (status == STATUS_ACTIVE) {
      const active = this.activeByScheme.getItem(parts[0]);
      assert(
        active == null || (active as string) == algorithmId,
        "ACTIVE_VERSION_CONFLICT",
      );
      this.activeByScheme.setItem(parts[0], algorithmId);
    } else if (previous == STATUS_ACTIVE) {
      this.activeByScheme.deleteItem(parts[0]);
    }
    parts[4] = status;
    parts[7] = my.getBlockTimeStamp().toString();
    this.algorithms.setItem(algorithmId, parts.join("|"));
    this.emitStatusEvent(algorithmId, previous, status);
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
    assert(current[4] == STATUS_ACTIVE, "INVALID_TRANSITION");
    assert(
      replacement[4] == STATUS_DRAFT || replacement[4] == STATUS_SUSPENDED,
      "INVALID_TRANSITION",
    );
    assert(current[0] == replacement[0], "SCHEME_MISMATCH");
    const replacementPrevious = replacement[4];
    const timestamp = my.getBlockTimeStamp().toString();
    current[4] = STATUS_SUSPENDED;
    current[7] = timestamp;
    replacement[4] = STATUS_ACTIVE;
    replacement[7] = timestamp;
    this.algorithms.setItem(currentAlgorithmId, current.join("|"));
    this.algorithms.setItem(replacementAlgorithmId, replacement.join("|"));
    this.activeByScheme.setItem(current[0], replacementAlgorithmId);
    this.emitStatusEvent(currentAlgorithmId, STATUS_ACTIVE, STATUS_SUSPENDED);
    this.emitStatusEvent(
      replacementAlgorithmId,
      replacementPrevious,
      STATUS_ACTIVE,
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
    const active = this.activeByScheme.getItem(schemeId);
    return active == null ? "" : active as string;
  }

  @EXPORT
  public isAlgorithmActive(algorithmId: string, algorithmHash: string): string {
    const stored = this.algorithms.getItem(algorithmId);
    if (stored == null) return "0";
    const parts = (stored as string).split("|");
    const active = this.activeByScheme.getItem(parts[0]);
    return parts[4] == STATUS_ACTIVE && parts[2] == algorithmHash &&
        active != null && (active as string) == algorithmId
      ? "1"
      : "0";
  }

  private requireInitialized(): void {
    assert(this.initialized.getData(), "NOT_INITIALIZED");
  }

  private requireRole(role: string): void {
    assert(this.hasRole(role, my.getSender().str), "UNAUTHORIZED");
  }

  private requireKnownRole(role: string): void {
    assert(
      role == ROLE_DEFAULT_ADMIN || role == ROLE_ALGORITHM_ADMIN,
      "UNKNOWN_ROLE",
    );
  }

  private requireStatus(status: string): void {
    assert(
      status == STATUS_DRAFT || status == STATUS_ACTIVE ||
        status == STATUS_SUSPENDED || status == STATUS_RETIRED,
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

  private emitStatusEvent(
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
