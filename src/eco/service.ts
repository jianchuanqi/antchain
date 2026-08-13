import { sha256 } from "./hash.ts";
import { LedgerPort, SandboxPort } from "./ports.ts";
import {
  AlgorithmStatus,
  AlgorithmVersion,
  EcoLabel,
  EvaluationTask,
  LabelStatus,
  MetricDefinition,
  ProductData,
  PublicLabelView,
  ViewerContext,
  ViewerRole,
} from "./types.ts";

const privilegedRoles: ViewerRole[] = ["evaluator", "regulator", "admin"];
const now = () => new Date().toISOString();

export interface RegisterAlgorithmInput {
  id: string;
  version: string;
  name: string;
  /** Required by the production AntChain adapter. */
  schemeId?: string;
  /** Required by the production AntChain adapter. */
  evaluatorHash?: string;
  metrics: MetricDefinition[];
}

export class EcoLabelService {
  private readonly algorithms = new Map<string, AlgorithmVersion>();
  private readonly tasks = new Map<string, EvaluationTask>();
  private readonly labels = new Map<string, EcoLabel>();

  constructor(
    private readonly sandbox: SandboxPort,
    private readonly ledger: LedgerPort,
    private readonly publicBaseUrl = "http://localhost:8000",
  ) {}

  async registerAlgorithm(
    input: RegisterAlgorithmInput,
  ): Promise<AlgorithmVersion> {
    this.validateAlgorithm(input.metrics);
    if (this.algorithms.has(input.id)) {
      throw new Error(`Algorithm ${input.id} already exists`);
    }
    const createdAt = now();
    const algorithmHash = await sha256({
      id: input.id,
      version: input.version,
      name: input.name,
      ...(input.schemeId ? { schemeId: input.schemeId } : {}),
      metrics: input.metrics,
    });
    const algorithm: AlgorithmVersion = {
      ...input,
      metrics: [...input.metrics],
      status: "DRAFT",
      algorithmHash,
      createdAt,
    };
    await this.ledger.registerAlgorithm(algorithm);
    this.algorithms.set(algorithm.id, algorithm);
    return algorithm;
  }

  async setAlgorithmStatus(
    id: string,
    status: AlgorithmStatus,
  ): Promise<AlgorithmVersion> {
    if (!["DRAFT", "ACTIVE", "SUSPENDED", "RETIRED"].includes(status)) {
      throw new Error("Invalid algorithm status");
    }
    const algorithm = this.requireAlgorithm(id);
    if (algorithm.status === "RETIRED") {
      throw new Error("A retired algorithm cannot change status");
    }
    if (status === "ACTIVE") {
      for (const candidate of this.algorithms.values()) {
        if (
          candidate.id !== id && candidate.status === "ACTIVE" &&
          candidate.name === algorithm.name
        ) {
          throw new Error(
            `Algorithm ${candidate.id} is already active for ${algorithm.name}`,
          );
        }
      }
    }
    const updated: AlgorithmVersion = {
      ...algorithm,
      status,
      activatedAt: status === "ACTIVE" ? now() : algorithm.activatedAt,
    };
    await this.ledger.setAlgorithmStatus(updated);
    this.algorithms.set(id, updated);
    return updated;
  }

  async submitEvaluation(
    product: Omit<ProductData, "submittedAt">,
    algorithmId: string,
  ): Promise<EvaluationTask> {
    const algorithm = this.requireAlgorithm(algorithmId);
    if (algorithm.status !== "ACTIVE") {
      throw new Error(`Algorithm ${algorithmId} is not active`);
    }
    if (!product.productId || !product.productName || !product.enterpriseId) {
      throw new Error("productId, productName, and enterpriseId are required");
    }
    const task: EvaluationTask = {
      id: crypto.randomUUID(),
      product: {
        ...product,
        attributes: { ...product.attributes },
        sensitiveFields: [...product.sensitiveFields],
        submittedAt: now(),
      },
      algorithmId,
      status: "SUBMITTED",
      createdAt: now(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async executeTask(taskId: string): Promise<EvaluationTask> {
    const task = this.requireTask(taskId);
    if (task.status === "COMPLETED") return task;
    if (task.status === "RUNNING") throw new Error("Task is already running");
    const algorithm = this.requireAlgorithm(task.algorithmId);
    if (algorithm.status !== "ACTIVE") {
      throw new Error(`Algorithm ${algorithm.id} is not active`);
    }
    task.status = "RUNNING";
    try {
      const execution = await this.sandbox.execute({
        taskId,
        product: task.product,
        algorithm,
      });
      task.result = execution.result;
      task.evidence = execution.evidence;
      task.status = "COMPLETED";
    } catch (error) {
      task.status = "FAILED";
      task.failureReason = error instanceof Error
        ? error.message
        : "Unknown sandbox failure";
      throw error;
    }
    return task;
  }

  async issueLabel(taskId: string, expiresAt?: string): Promise<EcoLabel> {
    const task = this.requireTask(taskId);
    if (task.status !== "COMPLETED" || !task.result || !task.evidence) {
      throw new Error("Only a completed evaluation can be issued");
    }
    const existing = [...this.labels.values()].find((label) =>
      label.taskId === taskId
    );
    if (existing) return existing;
    const algorithm = this.requireAlgorithm(task.algorithmId);
    if (algorithm.status !== "ACTIVE") {
      throw new Error(`Algorithm ${algorithm.id} is not active`);
    }
    const requestedAt = now();
    if (expiresAt) {
      const expiry = Date.parse(expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.parse(requestedAt)) {
        throw new Error(
          "expiresAt must be a valid time later than the issuance time",
        );
      }
    }
    const id = `ECO-${
      crypto.randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()
    }`;
    const ledgerAnchor = await this.ledger.issueLabel({
      labelId: id,
      taskId,
      algorithmId: algorithm.id,
      algorithmHash: task.evidence.algorithmHash,
      inputHash: task.evidence.inputHash,
      resultHash: task.evidence.resultHash,
      evidenceHash: task.evidence.evidenceHash,
      authorizationHash: await sha256({
        purpose: "eco-design-labelling",
        taskId,
        enterpriseId: task.product.enterpriseId,
      }),
      proofHash: await sha256({
        evidenceHash: task.evidence.evidenceHash,
        sandboxSignature: task.evidence.sandboxSignature,
        attestationRef: task.evidence.attestationRef,
      }),
      // The legacy MVP has no DataUseGrant object. A real AntChain adapter
      // rejects this assurance level; only the in-memory development ledger
      // accepts it. The production coordinator must provide a verified grant.
      authorizationAssurance: "DEVELOPMENT_SELF_ASSERTED",
      computeAssurance: task.evidence.sandboxType === "TCS"
        ? "VERIFIED_TCS"
        : "LOCAL_DETERMINISTIC",
      expiresAtEpochMs: expiresAt ? Date.parse(expiresAt) : 0,
    });
    const label: EcoLabel = {
      id,
      taskId,
      productId: task.product.productId,
      enterpriseId: task.product.enterpriseId,
      algorithmId: algorithm.id,
      algorithmVersion: algorithm.version,
      score: task.result.score,
      level: task.result.level,
      status: ledgerAnchor.status === "CONFIRMED"
        ? "ACTIVE"
        : ledgerAnchor.status === "FAILED"
        ? "CHAIN_FAILED"
        : "PENDING_CHAIN",
      requestedAt,
      issuedAt: ledgerAnchor.status === "CONFIRMED" ? requestedAt : undefined,
      expiresAt,
      evidence: task.evidence,
      ledgerAnchor,
      pendingLedgerAction: ledgerAnchor.status === "PENDING"
        ? "ISSUE"
        : undefined,
    };
    this.labels.set(id, label);
    return label;
  }

  async revokeLabel(labelId: string, reason: string): Promise<EcoLabel> {
    if (!reason.trim()) throw new Error("A revocation reason is required");
    const label = this.requireLabel(labelId);
    if (label.status === "REVOKED") return label;
    if (label.status === "PENDING_REVOCATION") {
      if (label.revocationReason === reason) return label;
      throw new Error("A different revocation is already pending");
    }
    if (
      label.status === "PENDING_CHAIN" || label.status === "CHAIN_FAILED"
    ) {
      throw new Error("Only an issued label can be revoked");
    }
    const previousStatus = label.status;
    const ledgerAnchor = await this.ledger.revokeLabel(
      label.id,
      await sha256({ reason }),
    );
    const updated: EcoLabel = {
      ...label,
      status: ledgerAnchor.status === "CONFIRMED"
        ? "REVOKED"
        : ledgerAnchor.status === "FAILED"
        ? previousStatus
        : "PENDING_REVOCATION",
      revokedAt: ledgerAnchor.status === "CONFIRMED" ? now() : undefined,
      revocationReason: reason,
      ledgerAnchor,
      pendingLedgerAction: ledgerAnchor.status === "PENDING"
        ? "REVOKE"
        : undefined,
      statusBeforePendingLedgerAction: ledgerAnchor.status === "PENDING"
        ? previousStatus
        : undefined,
    };
    this.labels.set(labelId, updated);
    return updated;
  }

  /**
   * Reconciles one previously submitted ledger operation. A gateway response
   * cannot change business status; only LedgerPort's independently verified
   * final receipt can promote issue/revoke state.
   */
  async reconcileLabelLedger(labelId: string): Promise<EcoLabel> {
    const label = this.requireLabel(labelId);
    if (
      label.ledgerAnchor.status !== "PENDING" ||
      !label.pendingLedgerAction
    ) return label;
    const ledgerAnchor = await this.ledger.reconcile(label.ledgerAnchor);
    if (ledgerAnchor.status === "PENDING") return label;
    let status: LabelStatus;
    if (ledgerAnchor.status === "CONFIRMED") {
      status = label.pendingLedgerAction === "ISSUE" ? "ACTIVE" : "REVOKED";
    } else if (label.pendingLedgerAction === "ISSUE") {
      status = "CHAIN_FAILED";
    } else {
      status = label.statusBeforePendingLedgerAction || "ACTIVE";
    }
    const updated: EcoLabel = {
      ...label,
      status,
      ledgerAnchor,
      issuedAt: ledgerAnchor.status === "CONFIRMED" &&
          label.pendingLedgerAction === "ISSUE"
        ? ledgerAnchor.finalizedAt || now()
        : label.issuedAt,
      revokedAt: ledgerAnchor.status === "CONFIRMED" &&
          label.pendingLedgerAction === "REVOKE"
        ? ledgerAnchor.finalizedAt || now()
        : label.revokedAt,
      pendingLedgerAction: undefined,
      statusBeforePendingLedgerAction: undefined,
    };
    this.labels.set(labelId, updated);
    return updated;
  }

  /**
   * List algorithm metadata available to an authenticated viewer. Algorithm
   * definitions are deliberately projected: callers never receive internal
   * lifecycle records or any tenant-owned product data from a list endpoint.
   */
  listAlgorithms(viewer: ViewerContext): Array<
    Pick<
      AlgorithmVersion,
      | "id"
      | "version"
      | "name"
      | "status"
      | "algorithmHash"
      | "createdAt"
      | "activatedAt"
      | "metrics"
    >
  > {
    this.assertAuthenticated(viewer);
    const canManage = privilegedRoles.includes(viewer.role);
    return [...this.algorithms.values()]
      .filter((algorithm) => canManage || algorithm.status === "ACTIVE")
      .map((algorithm) => ({
        id: algorithm.id,
        version: algorithm.version,
        name: algorithm.name,
        status: algorithm.status,
        algorithmHash: algorithm.algorithmHash,
        createdAt: algorithm.createdAt,
        activatedAt: algorithm.activatedAt,
        metrics: algorithm.metrics.map((metric) => ({ ...metric })),
      }));
  }

  /** List-safe task projection. Raw product.attributes never leave this API. */
  listTasks(viewer: ViewerContext): Array<Record<string, unknown>> {
    this.assertAuthenticated(viewer);
    return [...this.tasks.values()]
      .filter((task) =>
        this.canViewEnterprise(viewer, task.product.enterpriseId)
      )
      .map((task) => {
        const canViewResult = privilegedRoles.includes(viewer.role) ||
          (viewer.role === "enterprise" &&
            viewer.enterpriseId === task.product.enterpriseId);
        return {
          id: task.id,
          productId: task.product.productId,
          productName: task.product.productName,
          enterpriseId: privilegedRoles.includes(viewer.role)
            ? task.product.enterpriseId
            : undefined,
          algorithmId: task.algorithmId,
          status: task.status,
          createdAt: task.createdAt,
          score: canViewResult ? task.result?.score : undefined,
          level: canViewResult ? task.result?.level : undefined,
          sandboxType: task.evidence?.sandboxType,
          evidenceHash: task.evidence?.evidenceHash,
        };
      });
  }

  /**
   * Labels are returned through their public projection even to trusted list
   * callers. Detail endpoints retain the existing role-aware policy.
   */
  async listLabels(viewer: ViewerContext): Promise<PublicLabelView[]> {
    this.assertAuthenticated(viewer);
    const visible = [...this.labels.values()].filter((label) =>
      this.canViewEnterprise(viewer, label.enterpriseId)
    );
    return await Promise.all(
      visible.map((label) =>
        this.publicView(label, this.requireTask(label.taskId))
      ),
    );
  }

  getTask(taskId: string, viewer: ViewerContext): unknown {
    const task = this.requireTask(taskId);
    this.assertCanViewEnterprise(viewer, task.product.enterpriseId);
    return privilegedRoles.includes(viewer.role) ||
        viewer.enterpriseId === task.product.enterpriseId
      ? task
      : this.publicTask(task);
  }

  async getLabel(labelId: string, viewer: ViewerContext): Promise<unknown> {
    const label = this.requireLabel(labelId);
    const task = this.requireTask(label.taskId);
    if (viewer.role === "public") return await this.publicView(label, task);
    this.assertCanViewEnterprise(viewer, label.enterpriseId);
    if (viewer.role === "partner") return await this.publicView(label, task);
    return { ...label, product: task.product, result: task.result };
  }

  async verify(labelId: string): Promise<PublicLabelView> {
    const label = this.requireLabel(labelId);
    return await this.publicView(label, this.requireTask(label.taskId));
  }

  private async publicView(
    label: EcoLabel,
    task: EvaluationTask,
  ): Promise<PublicLabelView> {
    const algorithm = this.requireAlgorithm(label.algorithmId);
    const verifyUrl = `${this.publicBaseUrl.replace(/\/$/, "")}/verify/${
      encodeURIComponent(label.id)
    }`;
    const expectedAlgorithmHash = await sha256({
      id: algorithm.id,
      version: algorithm.version,
      name: algorithm.name,
      ...(algorithm.schemeId ? { schemeId: algorithm.schemeId } : {}),
      metrics: algorithm.metrics,
    });
    const expectedEvidenceHash = await sha256({
      taskId: label.evidence.taskId,
      sandboxType: label.evidence.sandboxType,
      sandboxInstanceId: label.evidence.sandboxInstanceId,
      inputHash: label.evidence.inputHash,
      algorithmHash: label.evidence.algorithmHash,
      resultHash: label.evidence.resultHash,
      startedAt: label.evidence.startedAt,
      completedAt: label.evidence.completedAt,
    });
    return {
      labelId: label.id,
      productName: task.product.productName,
      status: this.currentLabelStatus(label),
      issuedAt: label.issuedAt,
      expiresAt: label.expiresAt,
      algorithm: {
        id: algorithm.id,
        version: algorithm.version,
        name: algorithm.name,
      },
      sandbox: {
        sandboxType: label.evidence.sandboxType,
        sandboxInstanceId: label.evidence.sandboxInstanceId,
        evidenceHash: label.evidence.evidenceHash,
        attestationRef: label.evidence.attestationRef,
      },
      ledger: {
        transactionId: label.ledgerAnchor.transactionId,
        network: label.ledgerAnchor.network,
        contract: label.ledgerAnchor.contract,
        anchoredAt: label.ledgerAnchor.anchoredAt,
        status: label.ledgerAnchor.status,
        blockHeight: label.ledgerAnchor.blockHeight,
        finalizedAt: label.ledgerAnchor.finalizedAt,
        failureCode: label.ledgerAnchor.failureCode,
      },
      verification: {
        inputCommitment:
          (await sha256(task.product)) === label.evidence.inputHash,
        algorithmCommitment:
          expectedAlgorithmHash === label.evidence.algorithmHash &&
          expectedAlgorithmHash === algorithm.algorithmHash,
        resultCommitment: task.result !== undefined &&
          (await sha256(task.result)) === label.evidence.resultHash,
        evidenceHashConsistent:
          expectedEvidenceHash === label.evidence.evidenceHash &&
          Boolean(label.evidence.sandboxSignature),
        ledgerConfirmed: label.ledgerAnchor.status === "CONFIRMED" &&
          label.ledgerAnchor.network !== "local-memory-ledger",
      },
      verifyUrl,
      qrPayload: JSON.stringify({
        labelId: label.id,
        verifyUrl,
        network: label.ledgerAnchor.network,
        contract: label.ledgerAnchor.contract,
        transactionId: label.ledgerAnchor.transactionId,
      }),
    };
  }

  private currentLabelStatus(label: EcoLabel): LabelStatus {
    if (
      label.status === "ACTIVE" && label.expiresAt &&
      Date.parse(label.expiresAt) < Date.now()
    ) return "EXPIRED";
    return label.status;
  }
  private publicTask(task: EvaluationTask): unknown {
    return {
      id: task.id,
      algorithmId: task.algorithmId,
      status: task.status,
      createdAt: task.createdAt,
    };
  }
  private assertCanViewEnterprise(
    viewer: ViewerContext,
    enterpriseId: string,
  ): void {
    if (privilegedRoles.includes(viewer.role)) return;
    if (viewer.role === "enterprise" && viewer.enterpriseId === enterpriseId) {
      return;
    }
    if (
      viewer.role === "partner" &&
      viewer.authorizedEnterpriseIds?.includes(enterpriseId)
    ) return;
    throw new Error("Viewer is not permitted to view this resource");
  }
  private assertAuthenticated(viewer: ViewerContext): void {
    if (viewer.role === "public") {
      throw new Error("Authenticated viewer is required for list access");
    }
  }
  private canViewEnterprise(
    viewer: ViewerContext,
    enterpriseId: string,
  ): boolean {
    if (privilegedRoles.includes(viewer.role)) return true;
    if (viewer.role === "enterprise") {
      return viewer.enterpriseId === enterpriseId;
    }
    return viewer.role === "partner" &&
      Boolean(viewer.authorizedEnterpriseIds?.includes(enterpriseId));
  }
  private requireAlgorithm(id: string): AlgorithmVersion {
    const algorithm = this.algorithms.get(id);
    if (!algorithm) throw new Error(`Algorithm ${id} not found`);
    return algorithm;
  }
  private requireTask(id: string): EvaluationTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Evaluation task ${id} not found`);
    return task;
  }
  private requireLabel(id: string): EcoLabel {
    const label = this.labels.get(id);
    if (!label) throw new Error(`Label ${id} not found`);
    return label;
  }
  private validateAlgorithm(metrics: MetricDefinition[]): void {
    if (!metrics.length) {
      throw new Error("An algorithm needs at least one metric");
    }
    const ids = new Set<string>();
    for (const metric of metrics) {
      if (!metric.id || ids.has(metric.id)) {
        throw new Error("Metric ids must be present and unique");
      }
      ids.add(metric.id);
      if (
        !Number.isFinite(metric.weight) || metric.weight < 0 ||
        metric.max <= metric.min
      ) throw new Error(`Metric ${metric.id} has invalid weight or range`);
      if (
        metric.direction !== "HIGHER_IS_BETTER" &&
        metric.direction !== "LOWER_IS_BETTER"
      ) {
        throw new Error(`Metric ${metric.id} has invalid direction`);
      }
    }
    if (metrics.every((metric) => metric.weight === 0)) {
      throw new Error("At least one metric must have a positive weight");
    }
  }
}
