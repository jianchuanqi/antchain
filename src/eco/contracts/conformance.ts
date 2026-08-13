import frozenOracle from "../../../contracts/eco-label/conformance/scenarios.json" with {
  type: "json",
};
import eddlChainRelease from "../../../contracts/eco-label/releases/eddl-chain-algorithm-release.v1.json" with {
  type: "json",
};
import { sha256 } from "../hash.ts";
import {
  AlgorithmMirrorSyncCommand,
  ContractRuleError,
  LabelIssueCommand,
  sha256Commitment,
} from "./model.ts";
import {
  AlgorithmRegistrySimulator,
  EcoLabelRegistrySimulator,
} from "./simulator.ts";

export type ScenarioOutcome = "SUCCESS" | "ERROR";

export interface FrozenContractScenario {
  id: string;
  operation: string;
  expectedOutcome: ScenarioOutcome;
  expectedErrorCode?: string;
  securityInvariant: boolean;
}

export interface ScenarioResult extends FrozenContractScenario {
  passed: boolean;
  actualOutcome: ScenarioOutcome;
  actualErrorCode?: string;
  detail: string;
}

export interface AccuracyReport {
  suiteId: string;
  oracleVersion: string;
  oracleHash: string;
  total: number;
  passed: number;
  failed: number;
  accuracyPercent: number;
  thresholdPercent: number;
  thresholdMet: boolean;
  securityTotal: number;
  securityPassed: number;
  securityAccuracyPercent: number;
  securityTargetPercent: number;
  securityTargetMet: boolean;
  results: ScenarioResult[];
}

interface FrozenOracle {
  suiteId: string;
  oracleVersion: string;
  accuracyThresholdPercent: number;
  securityInvariantTargetPercent: number;
  scenarios: FrozenContractScenario[];
}

const oracle = frozenOracle as FrozenOracle;
const ADMIN = "admin";
const NOW = 1_700_000_000_000;
const ALGORITHM_REGISTRY_CONTRACT_ID = "a".repeat(64);
const EDDL_BUNDLE_DIGEST =
  "sha256:825eed2a806a4fd3b40509594c73df2d0f53909483c017edbea5a1aa323c86e3";
const EDDL_EVALUATOR_ARTIFACT_DIGEST =
  "sha256:5583d1e886d390e799af6d45a7fc0c2a49615002a4d5c5c1032c38d6c8c21938";
const H1 = sha256Commitment("1".repeat(64));
const H2 = sha256Commitment("2".repeat(64));
const H3 = sha256Commitment("3".repeat(64));
const H4 = sha256Commitment("4".repeat(64));
const H5 = sha256Commitment("5".repeat(64));
const H6 = sha256Commitment("6".repeat(64));
const H7 = sha256Commitment("7".repeat(64));

function assertOracle(condition: boolean, message: string): void {
  if (!condition) {
    throw new ContractRuleError("ORACLE_ASSERTION_FAILED", message);
  }
}

function algorithmInput(id = "eddl-1.0.0", evaluatorHash = H2) {
  return {
    id,
    schemeId: "eco-design-digital-identifier",
    version: id === "eddl-1.0.0" ? "1.0.0" : "1.1.0",
    algorithmHash: id === "eddl-1.0.0" ? H1 : H3,
    evaluatorHash,
  };
}

function issueCommand(
  overrides: Partial<LabelIssueCommand> = {},
): LabelIssueCommand {
  return {
    labelId: "EDDL-0001",
    taskId: "task-0001",
    algorithmId: "eddl-1.0.0",
    algorithmHash: H1,
    inputHash: H3,
    resultHash: H4,
    evidenceHash: H5,
    authorizationHash: H6,
    proofHash: H7,
    expiresAtEpochMs: NOW + 86_400_000,
    ...overrides,
  };
}

function mirrorCommand(
  overrides: Partial<AlgorithmMirrorSyncCommand> = {},
): AlgorithmMirrorSyncCommand {
  return {
    ...algorithmInput(),
    status: "ACTIVE",
    sourceStateHash: H7,
    sourceBlockHeight: 100,
    validUntilEpochMs: NOW + 3_600_000,
    ...overrides,
  };
}

function fixture(active = true) {
  const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
  algorithms.registerAlgorithm(ADMIN, algorithmInput());
  if (active) algorithms.setAlgorithmStatus(ADMIN, "eddl-1.0.0", "ACTIVE");
  const labels = new EcoLabelRegistrySimulator(
    ADMIN,
    NOW,
    ALGORITHM_REGISTRY_CONTRACT_ID,
  );
  labels.syncAlgorithmState(
    ADMIN,
    mirrorCommand(active ? {} : { status: "DRAFT", validUntilEpochMs: 0 }),
  );
  return { algorithms, labels };
}

function executeOperation(operation: string): void {
  switch (operation) {
    case "unauthorized-register": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      algorithms.registerAlgorithm("intruder", algorithmInput());
      return;
    }
    case "register": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      const record = algorithms.registerAlgorithm(ADMIN, algorithmInput());
      assertOracle(
        record.status === "DRAFT" && algorithms.size === 1,
        "draft registration was not stored once",
      );
      return;
    }
    case "idempotent-register": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      const first = algorithms.registerAlgorithm(ADMIN, algorithmInput());
      const second = algorithms.registerAlgorithm(ADMIN, algorithmInput());
      assertOracle(
        first.id === second.id && algorithms.size === 1,
        "registration retry created a duplicate",
      );
      assertOracle(
        algorithms.events.filter((event) =>
          event.name === "AlgorithmRegistered"
        ).length === 1,
        "idempotent retry emitted another registration event",
      );
      return;
    }
    case "register-conflict": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      algorithms.registerAlgorithm(ADMIN, algorithmInput());
      algorithms.registerAlgorithm(ADMIN, algorithmInput("eddl-1.0.0", H3));
      return;
    }
    case "unauthorized-status": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      algorithms.registerAlgorithm(ADMIN, algorithmInput());
      algorithms.setAlgorithmStatus("intruder", "eddl-1.0.0", "ACTIVE");
      return;
    }
    case "activate": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      algorithms.registerAlgorithm(ADMIN, algorithmInput());
      const record = algorithms.setAlgorithmStatus(
        ADMIN,
        "eddl-1.0.0",
        "ACTIVE",
      );
      assertOracle(
        record.status === "ACTIVE" &&
          algorithms.isAlgorithmActive(record.id, H1),
        "active registry lookup failed",
      );
      return;
    }
    case "single-active-version": {
      const { algorithms } = fixture();
      algorithms.registerAlgorithm(ADMIN, algorithmInput("eddl-1.1.0"));
      algorithms.setAlgorithmStatus(ADMIN, "eddl-1.1.0", "ACTIVE");
      return;
    }
    case "replace-active-version": {
      const { algorithms } = fixture();
      algorithms.registerAlgorithm(ADMIN, algorithmInput("eddl-1.1.0"));
      const replacement = algorithms.replaceActiveAlgorithm(
        ADMIN,
        "eddl-1.0.0",
        "eddl-1.1.0",
      );
      assertOracle(
        replacement.status === "ACTIVE",
        "replacement was not activated",
      );
      assertOracle(
        algorithms.getAlgorithm("eddl-1.0.0")?.status === "SUSPENDED",
        "old version was not suspended",
      );
      return;
    }
    case "retired-is-terminal": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      algorithms.registerAlgorithm(ADMIN, algorithmInput());
      algorithms.setAlgorithmStatus(ADMIN, "eddl-1.0.0", "RETIRED");
      algorithms.setAlgorithmStatus(ADMIN, "eddl-1.0.0", "ACTIVE");
      return;
    }
    case "revoked-role-cannot-register": {
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      algorithms.grantRole(ADMIN, "ALGORITHM_ADMIN", "publisher");
      algorithms.revokeRole(ADMIN, "ALGORITHM_ADMIN", "publisher");
      algorithms.registerAlgorithm("publisher", algorithmInput());
      return;
    }
    case "signed-bundle-release-binding": {
      assertOracle(
        eddlChainRelease.schemeId === "eco-design-digital-identifier" &&
          eddlChainRelease.algorithmHash === EDDL_BUNDLE_DIGEST &&
          eddlChainRelease.evaluatorHash ===
            EDDL_EVALUATOR_ARTIFACT_DIGEST &&
          eddlChainRelease.evaluatorHashSource ===
            "signedTemplateBundle.payload.evaluator.artifactDigest",
        "chain release is not bound to the frozen signed EDDL bundle",
      );
      const algorithms = new AlgorithmRegistrySimulator(ADMIN, NOW);
      const registered = algorithms.registerAlgorithm(ADMIN, {
        id: eddlChainRelease.algorithmId,
        schemeId: eddlChainRelease.schemeId,
        version: eddlChainRelease.version,
        algorithmHash: eddlChainRelease.algorithmHash,
        evaluatorHash: eddlChainRelease.evaluatorHash,
      });
      algorithms.setAlgorithmStatus(ADMIN, registered.id, "ACTIVE");
      assertOracle(
        algorithms.getActiveAlgorithmId(eddlChainRelease.schemeId) ===
            eddlChainRelease.algorithmId &&
          algorithms.isAlgorithmActive(
            eddlChainRelease.algorithmId,
            eddlChainRelease.algorithmHash,
          ),
        "frozen EDDL bundle release was not active with its exact commitment",
      );
      return;
    }
    case "unauthorized-mirror-sync": {
      const labels = new EcoLabelRegistrySimulator(
        ADMIN,
        NOW,
        ALGORITHM_REGISTRY_CONTRACT_ID,
      );
      labels.syncAlgorithmState("intruder", mirrorCommand());
      return;
    }
    case "mirror-active-state": {
      const { labels } = fixture();
      const mirror = labels.getAlgorithmStateMirror("eddl-1.0.0");
      assertOracle(
        mirror?.status === "ACTIVE" &&
          labels.getActiveMirroredAlgorithmId(
              "eco-design-digital-identifier",
            ) === "eddl-1.0.0" &&
          labels.isMirroredAlgorithmActive("eddl-1.0.0", H1),
        "fresh active algorithm mirror was not readable",
      );
      return;
    }
    case "mirror-stale-source-block": {
      const { labels } = fixture();
      labels.syncAlgorithmState(
        ADMIN,
        mirrorCommand({ sourceBlockHeight: 99, sourceStateHash: H6 }),
      );
      return;
    }
    case "mirror-same-block-conflict": {
      const { labels } = fixture();
      labels.syncAlgorithmState(
        ADMIN,
        mirrorCommand({ sourceStateHash: H6 }),
      );
      return;
    }
    case "mirror-metadata-conflict": {
      const { labels } = fixture();
      labels.syncAlgorithmState(
        ADMIN,
        mirrorCommand({
          algorithmHash: H2,
          sourceStateHash: H6,
          sourceBlockHeight: 101,
        }),
      );
      return;
    }
    case "single-active-mirror": {
      const { labels } = fixture();
      labels.syncAlgorithmState(
        ADMIN,
        mirrorCommand({
          ...algorithmInput("eddl-1.1.0"),
          sourceStateHash: H6,
          sourceBlockHeight: 101,
        }),
      );
      return;
    }
    case "expired-mirror-blocks-issue": {
      const { labels } = fixture();
      labels.setClock(NOW + 3_600_000);
      labels.issueLabel(ADMIN, issueCommand());
      return;
    }
    case "unauthorized-issue": {
      const { labels } = fixture();
      labels.issueLabel("intruder", issueCommand());
      return;
    }
    case "inactive-algorithm": {
      const { labels } = fixture(false);
      labels.issueLabel(ADMIN, issueCommand());
      return;
    }
    case "invalid-commitment": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand({ inputHash: "not-a-hash" }));
      return;
    }
    case "issue": {
      const { labels } = fixture();
      const label = labels.issueLabel(ADMIN, issueCommand());
      assertOracle(
        label.status === "ACTIVE" &&
          labels.getLabelByTaskId(label.taskId)?.labelId === label.labelId &&
          label.algorithmSourceStateHash === H7 &&
          label.algorithmSourceBlockHeight === 100,
        "issued label did not capture its exact source snapshot",
      );
      return;
    }
    case "algorithm-registry-binding-readback": {
      const { labels } = fixture();
      assertOracle(
        labels.getAlgorithmRegistryContractId() ===
          ALGORITHM_REGISTRY_CONTRACT_ID,
        "label registry did not expose its immutable algorithm registry binding",
      );
      return;
    }
    case "invalid-expiry": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand({ expiresAtEpochMs: NOW }));
      return;
    }
    case "idempotent-issue": {
      const { labels } = fixture();
      const command = issueCommand();
      const first = labels.issueLabel(ADMIN, command);
      const second = labels.issueLabel(ADMIN, command);
      assertOracle(
        first.labelId === second.labelId && labels.size === 1,
        "issue retry created a duplicate label",
      );
      assertOracle(
        labels.events.filter((event) => event.name === "LabelIssued").length ===
          1,
        "issue retry emitted another event",
      );
      return;
    }
    case "label-payload-conflict": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.issueLabel(ADMIN, issueCommand({ resultHash: H3 }));
      return;
    }
    case "task-double-use": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.issueLabel(ADMIN, issueCommand({ labelId: "EDDL-0002" }));
      return;
    }
    case "suspend-resume": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      assertOracle(
        labels.suspendLabel(ADMIN, "EDDL-0001").status === "SUSPENDED",
        "label did not suspend",
      );
      assertOracle(
        labels.resumeLabel(ADMIN, "EDDL-0001").status === "ACTIVE",
        "label did not resume",
      );
      return;
    }
    case "unauthorized-lifecycle": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.suspendLabel("intruder", "EDDL-0001");
      return;
    }
    case "revoke-is-terminal": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.revokeLabel(ADMIN, "EDDL-0001", H2);
      labels.resumeLabel(ADMIN, "EDDL-0001");
      return;
    }
    case "revocation-payload-conflict": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.revokeLabel(ADMIN, "EDDL-0001", H2);
      labels.revokeLabel(ADMIN, "EDDL-0001", H3);
      return;
    }
    case "expire-too-early": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.expireLabel("observer", "EDDL-0001");
      return;
    }
    case "expire-when-due": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.setClock(NOW + 86_400_000);
      assertOracle(
        labels.expireLabel("observer", "EDDL-0001").status === "EXPIRED",
        "due label did not expire",
      );
      return;
    }
    case "replace-label": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      const replacement = labels.replaceLabel(
        ADMIN,
        "EDDL-0001",
        issueCommand({
          labelId: "EDDL-0002",
          taskId: "task-0002",
          resultHash: H3,
        }),
      );
      assertOracle(
        replacement.replacesLabelId === "EDDL-0001",
        "replacement link is missing",
      );
      assertOracle(
        labels.getLabel("EDDL-0001")?.status === "SUPERSEDED",
        "old label was not superseded",
      );
      return;
    }
    case "replace-revoked-label": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      labels.revokeLabel(ADMIN, "EDDL-0001", H2);
      labels.replaceLabel(
        ADMIN,
        "EDDL-0001",
        issueCommand({ labelId: "EDDL-0002", taskId: "task-0002" }),
      );
      return;
    }
    case "minimal-state-fields": {
      const { labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      const state = JSON.stringify(labels.getLabel("EDDL-0001"));
      assertNoSensitiveFields(state, "label state");
      return;
    }
    case "minimal-event-fields": {
      const { algorithms, labels } = fixture();
      labels.issueLabel(ADMIN, issueCommand());
      const events = JSON.stringify([...algorithms.events, ...labels.events]);
      assertNoSensitiveFields(events, "contract events");
      return;
    }
    default:
      throw new ContractRuleError(
        "UNKNOWN_SCENARIO",
        `no executor for ${operation}`,
      );
  }
}

function assertNoSensitiveFields(serialized: string, subject: string): void {
  const forbidden = [
    "bom",
    "supplier",
    "productdata",
    "rawdata",
    "score",
    "grade",
    "indicatorvalue",
  ];
  const lower = serialized.toLowerCase();
  for (const field of forbidden) {
    assertOracle(
      !lower.includes(field),
      `${subject} contains forbidden field ${field}`,
    );
  }
}

export function getFrozenContractScenarios(): FrozenContractScenario[] {
  return oracle.scenarios.map((scenario) => ({ ...scenario }));
}

export function runContractScenario(
  scenario: FrozenContractScenario,
): ScenarioResult {
  let actualOutcome: ScenarioOutcome = "SUCCESS";
  let actualErrorCode: string | undefined;
  let detail = "operation completed";
  try {
    executeOperation(scenario.operation);
  } catch (error) {
    actualOutcome = "ERROR";
    actualErrorCode = error instanceof ContractRuleError
      ? error.code
      : "UNEXPECTED_ERROR";
    detail = error instanceof Error ? error.message : String(error);
  }
  const passed = actualOutcome === scenario.expectedOutcome &&
    (actualOutcome === "SUCCESS" ||
      actualErrorCode === scenario.expectedErrorCode);
  return {
    ...scenario,
    passed,
    actualOutcome,
    actualErrorCode,
    detail,
  };
}

export async function generateAccuracyReport(): Promise<AccuracyReport> {
  const results = oracle.scenarios.map(runContractScenario);
  const passed = results.filter((result) => result.passed).length;
  const security = results.filter((result) => result.securityInvariant);
  const securityPassed = security.filter((result) => result.passed).length;
  const accuracyPercent = Number((passed / results.length * 100).toFixed(2));
  const securityAccuracyPercent = Number(
    (securityPassed / security.length * 100).toFixed(2),
  );
  return {
    suiteId: oracle.suiteId,
    oracleVersion: oracle.oracleVersion,
    oracleHash: `sha256:${await sha256(oracle)}`,
    total: results.length,
    passed,
    failed: results.length - passed,
    accuracyPercent,
    thresholdPercent: oracle.accuracyThresholdPercent,
    thresholdMet: accuracyPercent >= oracle.accuracyThresholdPercent,
    securityTotal: security.length,
    securityPassed,
    securityAccuracyPercent,
    securityTargetPercent: oracle.securityInvariantTargetPercent,
    securityTargetMet:
      securityAccuracyPercent >= oracle.securityInvariantTargetPercent,
    results,
  };
}

export function formatAccuracyReportMarkdown(report: AccuracyReport): string {
  const rows = report.results.map((result) =>
    `| ${result.id} | ${result.operation} | ${result.expectedOutcome}${
      result.expectedErrorCode ? `/${result.expectedErrorCode}` : ""
    } | ${result.actualOutcome}${
      result.actualErrorCode ? `/${result.actualErrorCode}` : ""
    } | ${result.passed ? "PASS" : "FAIL"} | ${
      result.securityInvariant ? "是" : "否"
    } |`
  ).join("\n");
  return `# 生态设计数字标识智能合约算法准确率报告\n\n` +
    `- 套件：\`${report.suiteId}\`\n` +
    `- 冻结 Oracle：\`${report.oracleVersion}\` / \`${report.oracleHash}\`\n` +
    `- 场景执行一致率：**${report.accuracyPercent}%**（${report.passed}/${report.total}，门槛 ${report.thresholdPercent}%）\n` +
    `- 关键安全不变量：**${report.securityAccuracyPercent}%**（${report.securityPassed}/${report.securityTotal}，目标 ${report.securityTargetPercent}%）\n` +
    `- 结论：${
      report.thresholdMet && report.securityTargetMet ? "通过" : "不通过"
    }\n\n` +
    `> 本报告衡量冻结业务场景与确定性合约规则模拟器执行结果的一致性，不代表生态设计评级的科学准确性，也不构成已部署 WASM 或真实链执行证明。目标链部署后必须用同一 Oracle 重跑并归档终局回执、事件和独立读回。\n\n` +
    `| 场景 | 操作 | 预期 | 实际 | 结果 | 安全不变量 |\n` +
    `| --- | --- | --- | --- | --- | --- |\n${rows}\n\n` +
    `复现命令：\n\n` +
    "```bash\n" +
    "npx --yes deno run --allow-read \\\n" +
    "  src/examples/generate-eco-contract-accuracy-report.ts\n" +
    "```\n";
}
