import { assert, assertEquals, assertRejects } from "@std/assert";
import { createApp } from "../server.ts";
import {
  DevHeaderViewerResolver,
  EcoLabelService,
  LedgerAnchor,
  LocalDeterministicSandbox,
  MemoryLedgerAdapter,
} from "./index.ts";

class ConfirmingLedger extends MemoryLedgerAdapter {
  override reconcile(anchor: LedgerAnchor): Promise<LedgerAnchor> {
    return Promise.resolve({
      ...anchor,
      transactionId: "f".repeat(64),
      network: "AntChain-test",
      status: "CONFIRMED",
      blockHeight: 99,
      finalizedAt: "2026-08-11T08:00:00.000Z",
    });
  }
}

const algorithm = {
  id: "eco-v1",
  version: "1.0.0",
  name: "产品生态设计",
  metrics: [
    {
      id: "recycled",
      name: "再生材料占比",
      inputKey: "recycledRate",
      weight: 0.6,
      min: 0,
      max: 100,
      direction: "HIGHER_IS_BETTER" as const,
    },
    {
      id: "energy",
      name: "单位能耗",
      inputKey: "energy",
      weight: 0.4,
      min: 0,
      max: 100,
      direction: "LOWER_IS_BETTER" as const,
    },
  ],
};
const product = {
  productId: "P-01",
  productName: "可循环水杯",
  enterpriseId: "enterprise-a",
  attributes: { recycledRate: 90, energy: 20 },
  sensitiveFields: ["energy"],
};

async function issuedService(): Promise<
  { service: EcoLabelService; labelId: string }
> {
  const service = new EcoLabelService(
    new LocalDeterministicSandbox(),
    new MemoryLedgerAdapter(),
    "https://verify.example",
  );
  await service.registerAlgorithm(algorithm);
  await service.setAlgorithmStatus(algorithm.id, "ACTIVE");
  const task = await service.submitEvaluation(product, algorithm.id);
  await service.executeTask(task.id);
  const label = await service.issueLabel(task.id);
  return { service, labelId: label.id };
}

Deno.test("weighted calculation creates reproducible commitments and no raw data in public view", async () => {
  const { service, labelId } = await issuedService();
  const publicView = await service.verify(labelId);
  assert(!("level" in publicView));
  assert(!("score" in publicView));
  assertEquals(publicView.status, "PENDING_CHAIN");
  assert(publicView.verification.inputCommitment);
  assert(publicView.verification.evidenceHashConsistent);
  assertEquals(publicView.verification.ledgerConfirmed, false);
  assertEquals(publicView.ledger.status, "PENDING");
  assert(!JSON.stringify(publicView).includes("recycledRate"));
  assert(!JSON.stringify(publicView).includes('energy":20'));
  assert(publicView.qrPayload.includes(publicView.verifyUrl));
});

Deno.test("a label is not active until the ledger receipt is final", async () => {
  const service = new EcoLabelService(
    new LocalDeterministicSandbox(),
    new ConfirmingLedger(),
  );
  await service.registerAlgorithm(algorithm);
  await service.setAlgorithmStatus(algorithm.id, "ACTIVE");
  const task = await service.submitEvaluation(product, algorithm.id);
  await service.executeTask(task.id);
  const submitted = await service.issueLabel(task.id);
  assertEquals(submitted.status, "PENDING_CHAIN");
  assertEquals(submitted.issuedAt, undefined);
  const reconciled = await service.reconcileLabelLedger(submitted.id);
  assertEquals(reconciled.status, "ACTIVE");
  assertEquals(reconciled.issuedAt, "2026-08-11T08:00:00.000Z");
  assertEquals(reconciled.ledgerAnchor.status, "CONFIRMED");
});

Deno.test("enterprise data is isolated from other enterprises", async () => {
  const { service, labelId } = await issuedService();
  await assertRejects(
    () =>
      service.getLabel(labelId, {
        role: "enterprise",
        enterpriseId: "enterprise-b",
      }),
    Error,
    "not permitted",
  );
  const own = await service.getLabel(labelId, {
    role: "enterprise",
    enterpriseId: "enterprise-a",
  }) as { product: typeof product };
  assertEquals(own.product.attributes.energy, 20);
});

Deno.test("partner access requires an explicit enterprise scope", async () => {
  const { service, labelId } = await issuedService();
  await assertRejects(
    () => service.getLabel(labelId, { role: "partner" }),
    Error,
    "not permitted",
  );
  const partner = await service.getLabel(labelId, {
    role: "partner",
    authorizedEnterpriseIds: ["enterprise-a"],
  }) as { metricResults?: unknown[]; product?: unknown; score?: number };
  assertEquals(partner.metricResults, undefined);
  assertEquals(partner.product, undefined);
  assertEquals(partner.score, undefined);
});

Deno.test("label expiry must be a valid future time", async () => {
  const { service } = await issuedService();
  const secondTask = await service.submitEvaluation(
    { ...product, productId: "P-02" },
    algorithm.id,
  );
  await service.executeTask(secondTask.id);
  await assertRejects(
    () => service.issueLabel(secondTask.id, "not-a-date"),
    Error,
    "expiresAt",
  );
  await assertRejects(
    () => service.issueLabel(secondTask.id, "2000-01-01T00:00:00.000Z"),
    Error,
    "expiresAt",
  );
});

Deno.test("algorithm status and metric direction are validated at runtime", async () => {
  const service = new EcoLabelService(
    new LocalDeterministicSandbox(),
    new MemoryLedgerAdapter(),
  );
  await assertRejects(
    () =>
      service.registerAlgorithm({
        ...algorithm,
        id: "invalid-direction",
        metrics: [{ ...algorithm.metrics[0], direction: "SIDEWAYS" as never }],
      }),
    Error,
    "direction",
  );
  await service.registerAlgorithm({ ...algorithm, id: "runtime-status" });
  await assertRejects(
    () => service.setAlgorithmStatus("runtime-status", "ENABLED" as never),
    Error,
    "Invalid algorithm status",
  );
});

Deno.test("an algorithm suspended after execution cannot issue a label", async () => {
  const service = new EcoLabelService(
    new LocalDeterministicSandbox(),
    new MemoryLedgerAdapter(),
  );
  await service.registerAlgorithm({ ...algorithm, id: "pause-before-issue" });
  await service.setAlgorithmStatus("pause-before-issue", "ACTIVE");
  const task = await service.submitEvaluation(product, "pause-before-issue");
  await service.executeTask(task.id);
  await service.setAlgorithmStatus("pause-before-issue", "SUSPENDED");
  await assertRejects(
    () => service.issueLabel(task.id),
    Error,
    "not active",
  );
});

Deno.test("API rejects self-reported roles when no trusted resolver is installed", async () => {
  const app = createApp();
  const response = await app.fetch(
    new Request("http://test.local/api/eco/algorithms", {
      method: "POST",
      headers: { "content-type": "application/json", "x-viewer-role": "admin" },
      body: JSON.stringify(algorithm),
    }),
  );
  assertEquals(response.status, 400);
  assert((await response.text()).includes("Trusted identity"));
});

Deno.test("API workflow and public verification page work without AntChain or TCS", async () => {
  const service = new EcoLabelService(
    new LocalDeterministicSandbox(),
    new MemoryLedgerAdapter(),
    "http://test.local",
  );
  const app = createApp(service, {
    viewerResolver: new DevHeaderViewerResolver(),
  });
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.fetch(
      new Request(`http://test.local${path}`, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json", ...headers },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  const admin = { "x-viewer-role": "admin" };
  assertEquals(
    (await request("/api/eco/algorithms", algorithm, admin)).status,
    201,
  );
  const statusResponse = await app.fetch(
    new Request("http://test.local/api/eco/algorithms/eco-v1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...admin },
      body: JSON.stringify({ status: "ACTIVE" }),
    }),
  );
  assertEquals(statusResponse.status, 200);
  const submitted = await request("/api/eco/evaluations", {
    algorithmId: algorithm.id,
    product,
  }, { "x-viewer-role": "enterprise", "x-enterprise-id": "enterprise-a" });
  const taskId = (await submitted.json() as { data: { id: string } }).data.id;
  assertEquals(
    (await request(`/api/eco/evaluations/${taskId}/execute`, {}, admin)).status,
    200,
  );
  const issued = await request(
    `/api/eco/evaluations/${taskId}/issue`,
    {},
    admin,
  );
  const labelId = (await issued.json() as { data: { id: string } }).data.id;
  const verify = await request(`/api/eco/verify/${labelId}`);
  assertEquals(verify.status, 200);
  const html = await app.fetch(
    new Request(`http://test.local/verify/${labelId}`),
  );
  assertEquals(html.status, 200);
  const htmlText = await html.text();
  assert(htmlText.includes("本地演示记录"));
  assert(!htmlText.includes("等级 / 分数"));
});

Deno.test("list APIs are role filtered and never expose product attributes", async () => {
  const { service, labelId } = await issuedService();
  const app = createApp(service, {
    viewerResolver: new DevHeaderViewerResolver(),
  });
  const fetchList = (path: string, headers: Record<string, string>) =>
    app.fetch(new Request(`http://test.local${path}`, { headers }));
  const enterpriseHeaders = {
    "x-viewer-role": "enterprise",
    "x-enterprise-id": "enterprise-a",
  };
  const taskList = await fetchList("/api/eco/evaluations", enterpriseHeaders);
  assertEquals(taskList.status, 200);
  const taskText = await taskList.text();
  assert(!taskText.includes("recycledRate"));
  assert(!taskText.includes('"energy":20'));
  const partnerTaskList = await fetchList("/api/eco/evaluations", {
    "x-viewer-role": "partner",
    "x-authorized-enterprise-ids": "enterprise-a",
  });
  assertEquals(partnerTaskList.status, 200);
  const partnerTask = (await partnerTaskList.json() as {
    data: Array<{ score?: number; level?: string }>;
  }).data[0];
  assertEquals(partnerTask.score, undefined);
  assertEquals(partnerTask.level, undefined);
  const labelList = await fetchList("/api/eco/labels", enterpriseHeaders);
  assertEquals(labelList.status, 200);
  assert((await labelList.text()).includes(labelId));
  const foreign = await fetchList("/api/eco/labels", {
    "x-viewer-role": "enterprise",
    "x-enterprise-id": "enterprise-b",
  });
  assertEquals(foreign.status, 200);
  assertEquals((await foreign.json() as { data: unknown[] }).data.length, 0);
  const publicList = await app.fetch(
    new Request("http://test.local/api/eco/labels"),
  );
  assertEquals(publicList.status, 403);
});
