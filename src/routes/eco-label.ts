import { Hono, Status } from "../deps.ts";
import {
  EcoLabelService,
  LocalDeterministicSandbox,
  MemoryLedgerAdapter,
  ProductData,
  ViewerContext,
  ViewerResolver,
  ViewerRole,
} from "../eco/index.ts";

export interface EcoLabelRouterOptions {
  /** Required for every non-public operation in production. */
  viewerResolver?: ViewerResolver;
}

export function createEcoLabelRouter(
  service = new EcoLabelService(
    new LocalDeterministicSandbox(),
    new MemoryLedgerAdapter(),
  ),
  options: EcoLabelRouterOptions = {},
) {
  const router = new Hono();
  const viewer = async (
    request: Request,
    requireTrustedIdentity = false,
  ): Promise<ViewerContext> => {
    const context = options.viewerResolver
      ? await options.viewerResolver.resolve(request)
      : null;
    if (context) return context;
    if (requireTrustedIdentity) {
      throw new Error("Trusted identity is required for this operation");
    }
    return { role: "public" };
  };
  const requireRole = (context: ViewerContext, allowed: ViewerRole[]) => {
    if (!allowed.includes(context.role)) {
      throw new Error("Viewer does not have permission for this operation");
    }
  };
  const fail = (
    c: { json: (body: unknown, status?: number) => Response },
    error: unknown,
    status: number = Status.BadRequest,
  ) =>
    c.json({
      success: false,
      code: "ECO_LABEL_ERROR",
      message: error instanceof Error ? error.message : "Unknown error",
    }, status);

  router.post("/algorithms", async (c) => {
    try {
      requireRole(await viewer(c.req.raw, true), ["admin", "evaluator"]);
      return c.json({
        success: true,
        data: await service.registerAlgorithm(await c.req.json()),
      }, Status.Created);
    } catch (error) {
      return fail(c, error);
    }
  });
  router.patch("/algorithms/:id/status", async (c) => {
    try {
      requireRole(await viewer(c.req.raw, true), ["admin", "evaluator"]);
      const body = await c.req.json<
        { status: "DRAFT" | "ACTIVE" | "SUSPENDED" | "RETIRED" }
      >();
      return c.json({
        success: true,
        data: await service.setAlgorithmStatus(c.req.param("id"), body.status),
      });
    } catch (error) {
      return fail(c, error);
    }
  });
  router.get("/algorithms", async (c) => {
    try {
      return c.json({
        success: true,
        data: service.listAlgorithms(await viewer(c.req.raw, true)),
      });
    } catch (error) {
      return fail(c, error, Status.Forbidden);
    }
  });
  router.post("/evaluations", async (c) => {
    try {
      const context = await viewer(c.req.raw, true);
      requireRole(context, ["enterprise", "evaluator", "admin"]);
      const body = await c.req.json<{
        algorithmId: string;
        product: Omit<ProductData, "submittedAt">;
      }>();
      if (
        context.role === "enterprise" &&
        context.enterpriseId !== body.product.enterpriseId
      ) throw new Error("An enterprise may only submit its own product data");
      return c.json({
        success: true,
        data: await service.submitEvaluation(body.product, body.algorithmId),
      }, Status.Created);
    } catch (error) {
      return fail(c, error);
    }
  });
  router.post("/evaluations/:taskId/execute", async (c) => {
    try {
      requireRole(await viewer(c.req.raw, true), ["evaluator", "admin"]);
      return c.json({
        success: true,
        data: await service.executeTask(c.req.param("taskId")),
      });
    } catch (error) {
      return fail(c, error);
    }
  });
  router.get("/evaluations/:taskId", async (c) => {
    try {
      return c.json({
        success: true,
        data: service.getTask(
          c.req.param("taskId"),
          await viewer(c.req.raw, true),
        ),
      });
    } catch (error) {
      return fail(c, error, Status.Forbidden);
    }
  });
  router.get("/evaluations", async (c) => {
    try {
      return c.json({
        success: true,
        data: service.listTasks(await viewer(c.req.raw, true)),
      });
    } catch (error) {
      return fail(c, error, Status.Forbidden);
    }
  });
  router.post("/evaluations/:taskId/issue", async (c) => {
    try {
      requireRole(await viewer(c.req.raw, true), ["evaluator", "admin"]);
      const body = await c.req.json<{ expiresAt?: string }>().catch(() =>
        ({}) as { expiresAt?: string }
      );
      return c.json({
        success: true,
        data: await service.issueLabel(c.req.param("taskId"), body.expiresAt),
      }, Status.Created);
    } catch (error) {
      return fail(c, error);
    }
  });
  router.post("/labels/:labelId/revoke", async (c) => {
    try {
      requireRole(await viewer(c.req.raw, true), ["evaluator", "admin"]);
      const body = await c.req.json<{ reason: string }>();
      return c.json({
        success: true,
        data: await service.revokeLabel(c.req.param("labelId"), body.reason),
      });
    } catch (error) {
      return fail(c, error);
    }
  });
  router.post("/labels/:labelId/reconcile", async (c) => {
    try {
      requireRole(await viewer(c.req.raw, true), ["evaluator", "admin"]);
      return c.json({
        success: true,
        data: await service.reconcileLabelLedger(c.req.param("labelId")),
      });
    } catch (error) {
      return fail(c, error);
    }
  });
  router.get("/labels/:labelId", async (c) => {
    try {
      return c.json({
        success: true,
        data: await service.getLabel(
          c.req.param("labelId"),
          await viewer(c.req.raw),
        ),
      });
    } catch (error) {
      return fail(c, error, Status.Forbidden);
    }
  });
  router.get("/labels", async (c) => {
    try {
      return c.json({
        success: true,
        data: await service.listLabels(await viewer(c.req.raw, true)),
      });
    } catch (error) {
      return fail(c, error, Status.Forbidden);
    }
  });
  router.get("/verify/:labelId", async (c) => {
    try {
      return c.json({
        success: true,
        data: await service.verify(c.req.param("labelId")),
      });
    } catch (error) {
      return fail(c, error, Status.NotFound);
    }
  });
  return router;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Public QR landing page. It only consumes the public projection from the service. */
export function createEcoVerificationPage(service: EcoLabelService) {
  const router = new Hono();
  router.get("/:labelId", async (c) => {
    try {
      const data = await service.verify(c.req.param("labelId"));
      const checks = Object.entries(data.verification).map(([name, valid]) =>
        `<li>${valid ? "✓" : "✗"} ${escapeHtml(name)}</li>`
      ).join("");
      const ledgerExplanation = data.ledger.network === "local-memory-ledger"
        ? "本地演示记录（非真实上链）"
        : data.ledger.status === "PENDING"
        ? "链上提交待确认"
        : data.ledger.status === "FAILED"
        ? "链上执行失败"
        : "链上存证已确认";
      const html =
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>生态设计数字标识验证</title><style>body{font:16px system-ui;max-width:760px;margin:32px auto;padding:0 16px;color:#15332b}main{border:1px solid #cddbd5;border-radius:12px;padding:24px}dt{font-weight:700}dd{margin:4px 0 16px;word-break:break-all}.ok{color:#176b45}</style></head><body><main><h1>生态设计数字标识</h1><p class="ok">当前状态：${
          escapeHtml(data.status)
        }</p><dl><dt>产品</dt><dd>${
          escapeHtml(data.productName)
        }</dd><dt>算法版本</dt><dd>${escapeHtml(data.algorithm.name)} · ${
          escapeHtml(data.algorithm.version)
        }</dd><dt>沙箱证明</dt><dd>${escapeHtml(data.sandbox.sandboxType)} · ${
          escapeHtml(data.sandbox.evidenceHash)
        }</dd><dt>链上存证</dt><dd>${escapeHtml(data.ledger.network)} · ${
          escapeHtml(data.ledger.contract)
        } · ${escapeHtml(data.ledger.transactionId)} (${
          escapeHtml(data.ledger.status)
        }) · ${
          escapeHtml(ledgerExplanation)
        }</dd><dt>完整性校验及链上确认</dt><dd><ul>${checks}</ul></dd></dl><p>本页不展示企业原始数据；链上仅锚定数据、算法、结果和证据的摘要。</p></main></body></html>`;
      return c.html(html);
    } catch (error) {
      return c.html(
        `<!doctype html><title>未找到标识</title><p>${
          escapeHtml(error instanceof Error ? error.message : "Not found")
        }</p>`,
        Status.NotFound,
      );
    }
  });
  return router;
}
