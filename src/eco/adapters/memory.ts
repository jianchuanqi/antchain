import { canonicalJson, rounded, sha256 } from "../hash.ts";
import {
  LedgerPort,
  SandboxExecution,
  SandboxExecutionRequest,
  SandboxPort,
} from "../ports.ts";
import {
  AlgorithmVersion,
  CalculationEvidence,
  CalculationResult,
  LedgerAnchor,
  MetricDefinition,
} from "../types.ts";

function levelFor(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
}

function evaluateMetric(metric: MetricDefinition, input: number): number {
  const range = metric.max - metric.min;
  if (!Number.isFinite(input) || range <= 0) {
    throw new Error(`Metric ${metric.id} has invalid input or range`);
  }
  const clamped = Math.min(metric.max, Math.max(metric.min, input));
  const normalized = (clamped - metric.min) / range;
  return rounded(
    (metric.direction === "HIGHER_IS_BETTER" ? normalized : 1 - normalized) *
      100,
  );
}

export function calculateWeightedResult(
  algorithm: AlgorithmVersion,
  attributes: Record<string, number>,
): CalculationResult {
  const weightTotal = algorithm.metrics.reduce(
    (total, metric) => total + metric.weight,
    0,
  );
  if (weightTotal <= 0) {
    throw new Error("Algorithm weights must have a positive total");
  }
  const metricResults = algorithm.metrics.map((metric) => {
    const value = attributes[metric.inputKey];
    if (value === undefined) {
      throw new Error(`Missing required product attribute: ${metric.inputKey}`);
    }
    const normalizedScore = evaluateMetric(metric, value);
    return {
      metricId: metric.id,
      normalizedScore,
      weightedScore: rounded(normalizedScore * metric.weight / weightTotal),
    };
  });
  const score = rounded(
    metricResults.reduce((total, metric) => total + metric.weightedScore, 0),
  );
  return { score, level: levelFor(score), metricResults };
}

/** Local implementation for tests and offline development. It is not a TEE claim. */
export class LocalDeterministicSandbox implements SandboxPort {
  async execute(request: SandboxExecutionRequest): Promise<SandboxExecution> {
    const startedAt = new Date().toISOString();
    const inputHash = await sha256(request.product);
    const result = calculateWeightedResult(
      request.algorithm,
      request.product.attributes,
    );
    const resultHash = await sha256(result);
    const completedAt = new Date().toISOString();
    const unsignedEvidence: Omit<
      CalculationEvidence,
      "evidenceId" | "evidenceHash" | "sandboxSignature"
    > = {
      taskId: request.taskId,
      sandboxType: "LOCAL_DETERMINISTIC",
      sandboxInstanceId: `local-${request.taskId}`,
      inputHash,
      algorithmHash: request.algorithm.algorithmHash,
      resultHash,
      startedAt,
      completedAt,
    };
    const evidenceHash = await sha256(unsignedEvidence);
    const evidence: CalculationEvidence = {
      evidenceId: `evidence-${request.taskId}`,
      ...unsignedEvidence,
      evidenceHash,
      sandboxSignature: await sha256({
        domain: "eco-local-sandbox-v1",
        evidenceHash,
      }),
    };
    return { result, evidence };
  }
}

/** In-memory ledger emits pending local demonstration anchors for tests only. */
export class MemoryLedgerAdapter implements LedgerPort {
  readonly anchors: LedgerAnchor[] = [];
  private async anchor(
    contract: LedgerAnchor["contract"],
    payload: unknown,
  ): Promise<LedgerAnchor> {
    const transactionId = `memory-${
      (await sha256({ contract, payload, sequence: this.anchors.length }))
        .slice(0, 24)
    }`;
    const anchor: LedgerAnchor = {
      transactionId,
      contract,
      network: "local-memory-ledger",
      anchoredAt: new Date().toISOString(),
      // This is a local demonstration record, never an actual chain receipt.
      status: "PENDING",
    };
    this.anchors.push(anchor);
    return anchor;
  }
  registerAlgorithm(algorithm: AlgorithmVersion): Promise<LedgerAnchor> {
    return this.anchor("AlgorithmRegistry", {
      id: algorithm.id,
      algorithmHash: algorithm.algorithmHash,
      status: algorithm.status,
    });
  }
  setAlgorithmStatus(algorithm: AlgorithmVersion): Promise<LedgerAnchor> {
    return this.anchor("AlgorithmRegistry", {
      id: algorithm.id,
      status: algorithm.status,
    });
  }
  issueLabel(
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
    return this.anchor("EcoLabelRegistry", label);
  }
  suspendLabel(labelId: string): Promise<LedgerAnchor> {
    return this.anchor("EcoLabelRegistry", { labelId, action: "SUSPEND" });
  }
  resumeLabel(labelId: string): Promise<LedgerAnchor> {
    return this.anchor("EcoLabelRegistry", { labelId, action: "RESUME" });
  }
  revokeLabel(labelId: string, reasonHash: string): Promise<LedgerAnchor> {
    return this.anchor("EcoLabelRegistry", {
      labelId,
      reasonHash,
      action: "REVOKE",
    });
  }
  expireLabel(labelId: string): Promise<LedgerAnchor> {
    return this.anchor("EcoLabelRegistry", { labelId, action: "EXPIRE" });
  }
  reconcile(anchor: LedgerAnchor): Promise<LedgerAnchor> {
    // A local demonstration record has no external receipt and can never be
    // promoted to CONFIRMED.
    return Promise.resolve({ ...anchor, status: "PENDING" });
  }
}

export const LOCAL_SANDBOX_DESCRIPTION = canonicalJson({
  name: "LocalDeterministicSandbox",
  purpose: "offline development and testing",
  tee: false,
});
