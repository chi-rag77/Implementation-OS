import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import {
  calculateImplementationHealth,
  can,
  capabilityFor,
  normalizeCompanyWebsite,
  schemas,
  type MutableTable,
  type Role,
  type Row,
} from "../../../packages/domain/index.ts";
import { documentTypes, templateFor } from "../../../packages/domain/document-templates.ts";
import { DataError, type Repository } from "./repository.ts";
import { createHash } from "node:crypto";
import { googleMeetPilot } from "./meeting-providers.ts";
import { excerptPlanSources, planDraftSchema, verifyPlanEvidence, type PlanDraft, type PlanSource } from "../../../packages/domain/plan.ts";
import { buildSourceOutline } from "./plan-outline.ts";

export type Identity = { id: string; email: string; repo: Repository };
export type Config = {
  demo: boolean;
  origin: string;
  supabaseUrl?: string;
  publishableKey?: string;
  authenticate: (token: string | undefined) => Promise<Identity | null>;
  signup?: (
    email: string,
    password: string,
  ) => Promise<{ confirmation_required: boolean }>;
  aiProvider?: string;
  aiModel?: string;
  aiPlanModel?: string;
  generateDocument?: (input: {
    type: string;
    implementation: Record<string, unknown>;
    context: Record<string, unknown>;
    userNotes: string;
  }) => Promise<{
    content: string;
    source_notes: string[];
    open_questions: string[];
    proposals?: Array<{
      kind: "REQUIREMENT" | "ACTION" | "RISK" | "DECISION" | "OPEN_QUESTION";
      title: string;
      description: string;
      evidence: Array<{ transcript_id: string; excerpt: string }>;
    }>;
  }>;
  generatePlan?: (input: { implementation: Record<string, unknown>; sources: PlanSource[] }) => Promise<PlanDraft>;
};
type Env = {
  Variables: {
    requestId: string;
    identity: Identity;
    workspace: string;
    role: Role;
  };
};
class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const routes: Record<string, MutableTable> = {
  companies: "companies",
  implementations: "implementations",
  stages: "implementation_stages",
  tasks: "tasks",
  milestones: "milestones",
  requirements: "requirements",
  meetings: "meetings",
  transcripts: "meeting_transcripts",
  documents: "documents",
  stakeholders: "stakeholders",
  risks: "risks",
  evidence: "evidence_links",
  dependencies: "task_dependencies",
};
const playbookSnapshotSchema = z.object({
  stages: z.array(z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/),
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2000).default(""),
    entry_criteria: z.string().trim().max(2000).default(""),
    exit_criteria: z.string().trim().max(2000).default(""),
    duration_days: z.number().int().min(1).max(365).nullable().default(null),
    approval_required: z.boolean().default(false),
    tasks: z.array(z.object({
      title: z.string().trim().min(2).max(160),
      description: z.string().trim().max(2000).default(""),
      priority: z.enum(["LOW","MEDIUM","HIGH","CRITICAL"]).default("MEDIUM"),
    }).strict()).max(100).default([]),
    milestones: z.array(z.object({
      name: z.string().trim().min(2).max(160),
      description: z.string().trim().max(2000).default(""),
    }).strict()).max(30).default([]),
  }).strict()).max(30),
}).strict().refine((v) => new Set(v.stages.map((s) => s.key)).size === v.stages.length,
  "Stage keys must be unique.");
const assetFields = z.object({
  kind: z.enum(["TEMPLATE","DOCUMENT","STANDARD","AI_INSTRUCTION","KNOWLEDGE_SOURCE"]),
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000).default(""),
  content: z.string().max(200000).default(""),
  document_type: z.string().trim().max(80).nullable().optional(),
  source_url: z.url().max(1000).nullable().optional(),
  authority: z.enum(["POLICY","APPROVED","REFERENCE"]).default("REFERENCE"),
}).strict();
export async function all(
  repo: Repository,
  table: string,
  filters: Record<string, string>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const page = await repo.list(table, filters, 500, offset);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
  throw new ApiError(
    422,
    "RESULT_TOO_LARGE",
    "Use a narrower implementation filter.",
  );
}
export function createApp(config: Config) {
  const app = new Hono<Env>();
  const rates = new Map<string, { count: number; until: number }>();
  function rate(key: string, max: number) {
    const now = Date.now();
    for (const [k, v] of rates) if (v.until < now) rates.delete(k);
    if (rates.size > 10000)
      throw new ApiError(429, "RATE_LIMITED", "Please try again shortly.");
    const entry = rates.get(key) ?? { count: 0, until: now + 60000 };
    entry.count++;
    rates.set(key, entry);
    if (entry.count > max)
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Too many requests. Please wait a minute.",
      );
  }
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: config.origin,
      allowHeaders: ["Authorization", "Content-Type", "X-Workspace-Id"],
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
    }),
  );
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("X-Request-Id", c.get("requestId"));
    c.header("Cache-Control", "no-store");
    const start = Date.now();
    await next();
    if (process.env.NODE_ENV !== "test")
      console.info(
        JSON.stringify({
          request_id: c.get("requestId"),
          method: c.req.method,
          status: c.res.status,
          duration_ms: Date.now() - start,
        }),
      );
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            data: null,
            error: {
              code: "BODY_TOO_LARGE",
              message: "Request exceeds 1 MB.",
            },
          },
          413,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    if (["POST", "PATCH", "DELETE", "PUT"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (origin && origin !== config.origin)
        throw new ApiError(
          403,
          "ORIGIN_FORBIDDEN",
          "This origin cannot change workspace data.",
        );
      if (!c.req.header("Content-Type")?.startsWith("application/json"))
        throw new ApiError(
          400,
          "JSON_REQUIRED",
          "Send an application/json request.",
        );
    }
    await next();
  });
  const ok = (
    c: any,
    data: unknown,
    meta: Record<string, unknown> = {},
    status = 200,
  ) =>
    c.json(
      { data, meta: { request_id: c.get("requestId"), ...meta }, error: null },
      status,
    );
  app.get("/api/v1/config", (c) =>
    ok(c, {
      demo: config.demo,
      auth_configured: !!config.supabaseUrl && !!config.publishableKey,
      supabase_url: config.supabaseUrl ?? null,
      publishable_key: config.publishableKey ?? null,
      ai_connected: !!config.generateDocument,
      plan_ai_connected: !!config.generatePlan,
      ai_provider: config.generateDocument ? config.aiProvider : null,
      ai_model: config.generateDocument ? config.aiModel : null,
      ai_plan_model: config.generatePlan ? config.aiPlanModel ?? config.aiModel : null,
    }),
  );
  app.get("/api/health", (c) =>
    ok(c, { status: "ok", mode: config.demo ? "LOCAL_DEMO" : "SUPABASE" }),
  );
  app.post("/api/v1/auth/signup", async (c) => {
    rate("signup", 10);
    if (!config.signup)
      throw new ApiError(
        503,
        "AUTH_NOT_CONFIGURED",
        "Connect a new Supabase project to enable signup.",
      );
    const input = z
      .object({ email: z.email(), password: z.string().min(12).max(128) })
      .strict()
      .parse(await c.req.json());
    return ok(c, await config.signup(input.email, input.password));
  });
  app.use("/api/v1/*", async (c, next) => {
    const header = c.req.header("Authorization");
    const identity = await config.authenticate(
      header?.startsWith("Bearer ") ? header.slice(7) : undefined,
    );
    if (!identity)
      throw new ApiError(401, "AUTH_REQUIRED", "Sign in to your workspace.");
    rate(identity.id, 300);
    c.set("identity", identity);
    await next();
  });
  app.get("/api/v1/auth/me", (c) =>
    ok(c, { id: c.get("identity").id, email: c.get("identity").email }),
  );
  app.get("/api/v1/workspaces", async (c) =>
    ok(c, await c.get("identity").repo.list("workspaces")),
  );
  app.post("/api/v1/workspaces", async (c) => {
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
      })
      .strict()
      .parse(await c.req.json());
    return ok(
      c,
      await c.get("identity").repo.bootstrap(input.name, input.slug),
      {},
      201,
    );
  });
  app.use("/api/v1/*", async (c, next) => {
    const workspace = z
      .string()
      .regex(/^WS_[A-Z0-9]{8,32}$/)
      .safeParse(c.req.header("X-Workspace-Id"));
    if (!workspace.success)
      throw new ApiError(400, "WORKSPACE_REQUIRED", "Select a workspace.");
    const { repo, id } = c.get("identity");
    const membership = (
      await repo.list(
        "workspace_members",
        { workspace_id: workspace.data, user_id: id, status: "ACTIVE" },
        1,
      )
    )[0];
    if (!membership)
      throw new ApiError(
        403,
        "WORKSPACE_FORBIDDEN",
        "You do not have access to this workspace.",
      );
    c.set("workspace", workspace.data);
    c.set("role", membership.role as Role);
    await next();
  });
  app.get("/api/v1/context", (c) =>
    ok(c, {
      workspace_id: c.get("workspace"),
      role: c.get("role"),
      permissions: {
        write: can(c.get("role"), "work.write"),
        manage: can(c.get("role"), "plan.manage"),
        audit: can(c.get("role"), "audit.read"),
      },
    }),
  );
  const intelligenceAdmin = (c: any) => {
    if (!can(c.get("role"), "workspace.manage"))
      throw new ApiError(403, "FORBIDDEN", "Only workspace owners and admins can configure implementation intelligence.");
  };
  app.get("/api/v1/intelligence/overview", async (c) => {
    intelligenceAdmin(c);
    const repo = c.get("identity").repo, filter = { workspace_id: c.get("workspace") };
    const [playbooks, assets] = await Promise.all([
      all(repo, "playbooks", filter), all(repo, "intelligence_assets", filter),
    ]);
    return ok(c, { playbooks, assets });
  });
  app.get("/api/v1/intelligence/playbooks/available", async (c) => {
    if (!can(c.get("role"), "plan.manage"))
      throw new ApiError(403, "FORBIDDEN", "Your role cannot create implementations.");
    const repo = c.get("identity").repo, workspace = c.get("workspace");
    const playbooks = (await all(repo, "playbooks", { workspace_id: workspace }))
      .filter((p) => p.status === "PUBLISHED");
    const versions = await Promise.all(playbooks.map((p) => repo.list("playbook_versions", {
      workspace_id: workspace, playbook_id: p.id, version: String(p.published_version),
    }, 1)));
    return ok(c, playbooks.flatMap((p, i) => versions[i][0] ? [{
      id: p.id, name: versions[i][0].snapshot.name ?? p.name,
      implementation_type: versions[i][0].snapshot.implementation_type ?? p.implementation_type,
      published_version: p.published_version, published_snapshot: versions[i][0].snapshot,
    }] : []));
  });
  app.post("/api/v1/intelligence/playbooks", async (c) => {
    intelligenceAdmin(c);
    const input = z.object({
      name: z.string().trim().min(2).max(160),
      description: z.string().trim().max(2000).default(""),
      implementation_type: z.string().trim().min(2).max(80).default("ENTERPRISE"),
    }).strict().parse(await c.req.json());
    const row = await c.get("identity").repo.insert("playbooks", {
      ...input, workspace_id: c.get("workspace"), draft_snapshot: { stages: [] },
    });
    return ok(c, row, {}, 201);
  });
  app.patch("/api/v1/intelligence/playbooks/:id", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id"));
    const input = z.object({
      name: z.string().trim().min(2).max(160).optional(),
      description: z.string().trim().max(2000).optional(),
      implementation_type: z.string().trim().min(2).max(80).optional(),
      draft_snapshot: playbookSnapshotSchema.optional(),
    }).strict().refine((v) => Object.keys(v).length > 0).parse(await c.req.json());
    const existing = (await c.get("identity").repo.list("playbooks", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!existing) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Playbook not found.");
    if (existing.status === "ARCHIVED") throw new ApiError(409, "PLAYBOOK_ARCHIVED", "Archived playbooks cannot be edited.");
    const row = await c.get("identity").repo.update("playbooks", id, c.get("workspace"), input);
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Playbook not found.");
    return ok(c, row);
  });
  app.post("/api/v1/intelligence/playbooks/:id/publish", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id")), repo = c.get("identity").repo;
    const row = (await repo.list("playbooks", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Playbook not found.");
    if (row.status === "ARCHIVED") throw new ApiError(409, "PLAYBOOK_ARCHIVED", "Archived playbooks cannot be published.");
    const snapshot = playbookSnapshotSchema.parse(row.draft_snapshot);
    if (!snapshot.stages.length) throw new ApiError(422, "STAGES_REQUIRED", "Add at least one stage before publishing.");
    const updated = await repo.update("playbooks", id, c.get("workspace"), {
      status: "PUBLISHED", published_version: row.published_version + 1,
    });
    return ok(c, updated);
  });
  app.post("/api/v1/intelligence/playbooks/:id/archive", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id"));
    const row = await c.get("identity").repo.update("playbooks", id, c.get("workspace"), { status: "ARCHIVED" });
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Playbook not found.");
    return ok(c, row);
  });
  app.get("/api/v1/intelligence/playbooks/:id/versions", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id")), repo = c.get("identity").repo;
    if (!(await repo.list("playbooks", { id, workspace_id: c.get("workspace") }, 1))[0])
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Playbook not found.");
    return ok(c, await repo.list("playbook_versions", { workspace_id: c.get("workspace"), playbook_id: id }, 100));
  });
  app.post("/api/v1/intelligence/assets", async (c) => {
    intelligenceAdmin(c);
    const input = assetFields.parse(await c.req.json());
    return ok(c, await c.get("identity").repo.insert("intelligence_assets", {
      ...input, workspace_id: c.get("workspace"), created_by: c.get("identity").id,
    }), {}, 201);
  });
  app.patch("/api/v1/intelligence/assets/:id", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id"));
    const input = assetFields.partial().refine((v) => Object.keys(v).length > 0).parse(await c.req.json());
    const existing = (await c.get("identity").repo.list("intelligence_assets", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!existing) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Library item not found.");
    if (existing.status === "ARCHIVED") throw new ApiError(409, "ASSET_ARCHIVED", "Archived items cannot be edited.");
    const row = await c.get("identity").repo.update("intelligence_assets", id, c.get("workspace"), input);
    return ok(c, row);
  });
  app.post("/api/v1/intelligence/assets/:id/publish", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id")), repo = c.get("identity").repo;
    const row = (await repo.list("intelligence_assets", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Library item not found.");
    if (row.status === "ARCHIVED") throw new ApiError(409, "ASSET_ARCHIVED", "Archived items cannot be published.");
    if (row.content.trim().length < 10) throw new ApiError(422, "CONTENT_REQUIRED", "Add substantive content before publishing.");
    return ok(c, await repo.update("intelligence_assets", id, c.get("workspace"), {
      status: "PUBLISHED", published_version: row.published_version + 1,
    }));
  });
  app.post("/api/v1/intelligence/assets/:id/archive", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id"));
    const row = await c.get("identity").repo.update("intelligence_assets", id, c.get("workspace"), { status: "ARCHIVED" });
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Library item not found.");
    return ok(c, row);
  });
  app.get("/api/v1/intelligence/assets/:id/versions", async (c) => {
    intelligenceAdmin(c);
    const id = z.uuid().parse(c.req.param("id")), repo = c.get("identity").repo;
    if (!(await repo.list("intelligence_assets", { id, workspace_id: c.get("workspace") }, 1))[0])
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Library item not found.");
    return ok(c, await repo.list("intelligence_asset_versions", { workspace_id: c.get("workspace"), asset_id: id }, 100));
  });
  app.post("/api/v1/implementations/from-playbook", async (c) => {
    if (!can(c.get("role"), "plan.manage")) throw new ApiError(403, "FORBIDDEN", "Your role cannot create implementations.");
    const input = z.object({
      name: z.string().trim().min(2).max(160), company_id: z.uuid(), playbook_id: z.uuid(),
      description: z.string().trim().max(10000).optional(),
      target_go_live_date: z.iso.date().nullable().optional(),
    }).strict().parse(await c.req.json());
    return ok(c, await c.get("identity").repo.createFromPlaybook({ ...input, workspace_id: c.get("workspace") }), {}, 201);
  });
  const planManager = (c: any) => {
    if (!can(c.get("role"), "plan.manage"))
      throw new ApiError(403, "FORBIDDEN", "Only implementation managers and workspace admins can prepare or approve plans.");
  };
  async function planImplementation(c: any) {
    const implementationId = z.uuid().parse(c.req.param("id"));
    const row = (await c.get("identity").repo.list("implementations", {
      workspace_id: c.get("workspace"), id: implementationId,
    }, 1))[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Implementation not found.");
    return row;
  }
  async function planSources(c: any, implementationId: string): Promise<PlanSource[]> {
    const repo = c.get("identity").repo, workspace = c.get("workspace");
    const [assets, documents] = await Promise.all([
      repo.list("intelligence_assets", { workspace_id: workspace }, 100),
      repo.list("documents", { workspace_id: workspace, implementation_id: implementationId }, 100),
    ]);
    return [
      ...assets.filter((item: Row) => item.status !== "ARCHIVED" && item.content?.trim()).map((item: Row) => ({
        id: item.id, kind: "LIBRARY" as const, title: item.name, content: String(item.content).slice(0, 12_000),
        status: item.status, version: item.published_version || null,
      })),
      ...documents.filter((item: Row) => item.status !== "ARCHIVED" && item.content?.trim()).map((item: Row) => ({
        id: item.id, kind: "DOCUMENT" as const, title: item.name, content: String(item.content).slice(0, 12_000),
        status: item.status, version: item.version ?? null,
      })),
    ];
  }
  app.get("/api/v1/implementations/:id/plan/sources", async (c) => {
    const implementation = await planImplementation(c);
    return ok(c, await planSources(c, implementation.id));
  });
  app.get("/api/v1/implementations/:id/plan", async (c) => {
    const implementation = await planImplementation(c), repo = c.get("identity").repo;
    const filter = { workspace_id: c.get("workspace"), implementation_id: implementation.id };
    const [proposals, stages, tasks, milestones] = await Promise.all([
      repo.list("plan_proposals", filter, 25), repo.list("implementation_stages", filter, 100),
      repo.list("tasks", filter, 500), repo.list("milestones", filter, 200),
    ]);
    return ok(c, { proposals, current: { stages, tasks, milestones } });
  });
  app.post("/api/v1/implementations/:id/plan/proposals", async (c) => {
    planManager(c);
    const implementation = await planImplementation(c);
    const input = z.object({
      source_ids: z.array(z.uuid()).min(1).max(6).refine((ids) => new Set(ids).size === ids.length, "Choose each source once."),
      mode: z.enum(["AI", "MANUAL_OUTLINE"]),
    }).strict().parse(await c.req.json());
    rate(`plan:${c.get("workspace")}:${c.get("identity").id}`, 12);
    const available = await planSources(c, implementation.id);
    const byId = new Map(available.map((source) => [source.id, source]));
    const selected = input.source_ids.map((id) => byId.get(id));
    if (selected.some((source) => !source))
      throw new ApiError(404, "SOURCE_NOT_FOUND", "A selected source is unavailable in this workspace. Refresh the source list.");
    const sources = selected as PlanSource[];
    let plan: PlanDraft;
    if (input.mode === "AI") {
      if (!config.generatePlan) throw new ApiError(503, "AI_NOT_CONFIGURED", "Connect a server-side AI provider, or prepare a source outline without AI.");
      let valid: PlanDraft | null = null;
      let validationCode = "AI_OUTPUT_INVALID";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const candidate = planDraftSchema.parse(await config.generatePlan({
            implementation: { name: implementation.name, description: implementation.description ?? "", implementation_type: implementation.implementation_type },
            sources: excerptPlanSources(sources),
          }));
          const problems = verifyPlanEvidence(candidate, sources, true);
          if (problems.length) { validationCode = "AI_EVIDENCE_UNVERIFIED"; continue; }
          valid = candidate;
          break;
        } catch (error) {
          if (error instanceof ZodError || (error instanceof Error && ["AI_RESPONSE_INVALID", "AI_RESPONSE_INCOMPLETE"].includes(error.name))) {
            validationCode = "AI_OUTPUT_INVALID";
            continue;
          }
          const code = error instanceof Error ? error.name : "AI_PROVIDER_UNAVAILABLE";
          throw new ApiError(502, code, code === "AI_PROVIDER_TIMEOUT"
            ? "The AI model did not finish in time. No project records changed. Try fewer sources or prepare a source outline."
            : "The AI provider could not prepare a plan. No project records changed; you can retry or prepare a source outline.");
        }
      }
      if (!valid) throw new ApiError(502, validationCode, "The AI plan did not pass structure or source verification after two attempts. No draft was saved; retry or use a source outline.");
      plan = valid;
    } else plan = planDraftSchema.parse(buildSourceOutline(implementation, sources));
    const row = await c.get("identity").repo.insert("plan_proposals", {
      workspace_id: c.get("workspace"), implementation_id: implementation.id,
      source_snapshots: sources, plan, generation_mode: input.mode,
      provider_name: input.mode === "AI" ? `${config.aiProvider ?? "AI"} · ${config.aiPlanModel ?? config.aiModel ?? "unknown model"}` : null,
      created_by: c.get("identity").id,
    });
    return ok(c, row, {}, 201);
  });
  app.patch("/api/v1/implementations/:id/plan/proposals/:proposalId", async (c) => {
    planManager(c);
    const implementation = await planImplementation(c), proposalId = z.uuid().parse(c.req.param("proposalId"));
    const input = z.object({
      expected_revision: z.number().int().positive(), plan: planDraftSchema,
      reviewer_note: z.string().trim().max(2000).default(""),
    }).strict().parse(await c.req.json());
    const repo = c.get("identity").repo;
    const existing = (await repo.list("plan_proposals", {
      workspace_id: c.get("workspace"), implementation_id: implementation.id, id: proposalId,
    }, 1))[0];
    if (!existing) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Plan proposal not found.");
    if (existing.status !== "DRAFT") throw new ApiError(409, "PLAN_ALREADY_REVIEWED", "This proposal is no longer editable.");
    const problems = verifyPlanEvidence(input.plan, existing.source_snapshots as PlanSource[], false);
    if (problems.length) throw new ApiError(422, "SOURCE_CITATION_INVALID", problems[0]);
    const row = await repo.revisePlanProposal(c.get("workspace"), proposalId, input.expected_revision, {
      plan: input.plan, reviewer_note: input.reviewer_note, edited_by_human: true,
    });
    if (!row) throw new ApiError(409, "PLAN_CHANGED", "This plan was edited elsewhere. Reload it before saving your changes.");
    return ok(c, row);
  });
  app.post("/api/v1/implementations/:id/plan/proposals/:proposalId/approve", async (c) => {
    planManager(c);
    const implementation = await planImplementation(c), proposalId = z.uuid().parse(c.req.param("proposalId"));
    const input = z.object({ acknowledge_open_questions: z.boolean().default(false) }).strict().parse(await c.req.json());
    const repo = c.get("identity").repo;
    const proposal = (await repo.list("plan_proposals", {
      workspace_id: c.get("workspace"), implementation_id: implementation.id, id: proposalId,
    }, 1))[0];
    if (!proposal) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Plan proposal not found.");
    if (proposal.status === "APPROVED") return ok(c, proposal);
    if (proposal.status !== "DRAFT") throw new ApiError(409, "PLAN_ALREADY_REVIEWED", "This proposal cannot be approved.");
    const plan = planDraftSchema.parse(proposal.plan);
    if (!plan.stages.length) throw new ApiError(422, "STAGES_REQUIRED", "Add at least one cited stage before approval.");
    if (proposal.edited_by_human && String(proposal.reviewer_note ?? "").trim().length < 3)
      throw new ApiError(422, "REVIEW_NOTE_REQUIRED", "Describe your edits before approving.");
    const problems = verifyPlanEvidence(plan, proposal.source_snapshots as PlanSource[], !proposal.edited_by_human);
    if (problems.length) throw new ApiError(422, "SOURCE_CITATION_INVALID", problems[0]);
    return ok(c, await repo.applyPlanProposal(c.get("workspace"), proposalId, input.acknowledge_open_questions));
  });
  app.post("/api/v1/implementations/:id/plan/proposals/:proposalId/reject", async (c) => {
    planManager(c);
    const implementation = await planImplementation(c), proposalId = z.uuid().parse(c.req.param("proposalId"));
    const input = z.object({ expected_revision: z.number().int().positive(), reason: z.string().trim().min(3).max(2000) }).strict().parse(await c.req.json());
    const row = await c.get("identity").repo.revisePlanProposal(c.get("workspace"), proposalId, input.expected_revision, {
      status: "REJECTED", reviewer_note: input.reason,
    });
    if (!row) throw new ApiError(409, "PLAN_CHANGED", "This proposal changed or was already reviewed. Reload before rejecting.");
    return ok(c, row);
  });
  app.get("/api/v1/implementations/:id/overview", async (c) => {
    const id = z.uuid().parse(c.req.param("id")),
      repo = c.get("identity").repo,
      w = c.get("workspace");
    const implementation = (
      await repo.list("implementations", { workspace_id: w, id }, 1)
    )[0];
    if (!implementation)
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Implementation not found.",
      );
    const filter = { workspace_id: w, implementation_id: id };
    const [
      stages,
      tasks,
      milestones,
      requirements,
      risks,
      dependencies,
      meetings,
      documents,
      stakeholders,
      evidence,
      entities,
      activity,
    ] = await Promise.all(
      [
        "implementation_stages",
        "tasks",
        "milestones",
        "requirements",
        "risks",
        "task_dependencies",
        "meetings",
        "documents",
        "stakeholders",
        "evidence_links",
        "graph_entities",
        "activity_events",
      ].map((t) => all(repo, t, filter)),
    );
    const health = calculateImplementationHealth({
      tasks,
      milestones,
      requirements,
      risks,
      dependencies,
    });
    return ok(c, {
      implementation,
      health,
      stages: stages
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => {
          const ts = tasks.filter(
            (t) => t.stage_id === s.id && t.status !== "CANCELLED",
          );
          return {
            ...s,
            task_count: ts.length,
            progress: ts.length
              ? Math.round(
                  (ts.filter((t) => t.status === "COMPLETED").length /
                    ts.length) *
                    100,
                )
              : s.progress,
          };
        }),
      tasks,
      milestones,
      requirements,
      risks,
      dependencies,
      meetings,
      documents,
      stakeholders,
      evidence,
      entities,
      activity: activity.slice(0, 12),
      ai: {
        connected: false,
        reason: "Connect an AI provider to generate evidence-backed proposals.",
      },
    });
  });
  app.get("/api/v1/documents/:id/versions", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    const implementationId = z.uuid().parse(c.req.query("implementation_id"));
    const repo = c.get("identity").repo;
    const document = (
      await repo.list(
        "documents",
        {
          id,
          implementation_id: implementationId,
          workspace_id: c.get("workspace"),
        },
        1,
      )
    )[0];
    if (!document)
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Document not found.");
    return ok(
      c,
      await repo.list(
        "document_versions",
        {
          document_id: id,
          implementation_id: implementationId,
          workspace_id: c.get("workspace"),
        },
        100,
      ),
    );
  });
  const proposalEvidenceSchema = z.object({ transcript_id: z.uuid(), excerpt: z.string().trim().min(8).max(500) }).strict();
  const proposalSchema = z.object({
    kind: z.enum(["REQUIREMENT", "ACTION", "RISK", "DECISION", "OPEN_QUESTION"]),
    title: z.string().trim().min(2).max(300),
    description: z.string().trim().max(3000).default(""),
    evidence: z.array(proposalEvidenceSchema).max(8).default([]),
  }).strict();
  const verifyImplementation = async (repo: Repository, id: string, workspace: string) => {
    const row = (await repo.list("implementations", { id, workspace_id: workspace }, 1))[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Implementation not found.");
    return row;
  };
  const runView = async (repo: Repository, run: Row) => {
    const [proposals, storyboard, brd] = await Promise.all([
      repo.list("autopilot_proposals", { run_id: run.id, workspace_id: run.workspace_id }, 100),
      run.storyboard_document_id ? repo.list("documents", { id: run.storyboard_document_id, workspace_id: run.workspace_id }, 1) : [],
      run.brd_document_id ? repo.list("documents", { id: run.brd_document_id, workspace_id: run.workspace_id }, 1) : [],
    ]);
    const refs = new Set<string>(proposals.flatMap((p) => (p.evidence_refs ?? []).map((e: any) => e.transcript_id)));
    const [transcripts, meetings] = await Promise.all([
      (refs.size || run.source_meeting_ids?.length) ? repo.list("meeting_transcripts", { workspace_id: run.workspace_id, implementation_id: run.implementation_id }, 2000) : [],
      run.source_meeting_ids?.length ? repo.list("meetings", { workspace_id: run.workspace_id, implementation_id: run.implementation_id }, 1000) : [],
    ]);
    const evidenceById = new Map(transcripts.filter((t) => refs.has(t.id)).map((t) => [t.id, { transcript_id: t.id, meeting_id: t.meeting_id, meeting_title: meetings.find((m) => m.id === t.meeting_id)?.title ?? "Imported meeting", speaker: t.speaker, timestamp_ms: t.timestamp_ms, text: t.text }]));
    return { ...run, source_meetings: meetings.filter((m) => (run.source_meeting_ids ?? []).includes(m.id)).map((m) => ({ ...m, segment_count: transcripts.filter((t) => t.meeting_id === m.id).length })), proposals: proposals.map((p) => ({ ...p, evidence: (p.evidence_refs ?? []).map((ref: any) => ({ ...evidenceById.get(ref.transcript_id), excerpt: ref.excerpt })).filter((e: any) => e.transcript_id) })), storyboard: storyboard[0] ?? null, brd: brd[0] ?? null };
  };
  const transcriptSegments = (content: string) => {
    const normalized = content.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").trim();
    const out: Array<{ speaker: string; timestamp_ms: number; text: string }> = [];
    const stamp = (value: string) => {
      const parts = value.replace(",", ".").split(":").map(Number);
      const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      return Math.max(0, Math.round(seconds * 1000));
    };
    const lines = normalized.split("\n");
    let currentMs = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line === "WEBVTT" || /^\d+$/.test(line)) continue;
      const vtt = line.match(/^(\d{2}:)?\d{2}:\d{2}[,.]\d{3}\s+-->\s+/);
      if (vtt) {
        currentMs = stamp(line.split(/\s+-->\s+/)[0]);
        const text = (lines[++i] ?? "").trim();
        const voice = text.match(/^<v\s+([^>]+)>(.*)<\/v>$/i);
        out.push({ speaker: voice?.[1] ?? "Unknown speaker", timestamp_ms: currentMs, text: (voice?.[2] ?? text).replace(/<[^>]*>/g, "").trim() });
        continue;
      }
      const timed = line.match(/^\[(\d{1,2}:\d{2}:\d{2}(?:[,.]\d{1,3})?)\]\s*(?:(.{1,120}?):\s*)?(.+)$/);
      if (timed) {
        currentMs = stamp(timed[1]);
        out.push({ speaker: timed[2]?.trim() || "Unknown speaker", timestamp_ms: currentMs, text: timed[3].trim() });
        continue;
      }
      const speakerLine = line.match(/^([^:]{1,100}):\s+(.+)$/);
      if (speakerLine && !/^https?$/i.test(speakerLine[1])) out.push({ speaker: speakerLine[1].trim(), timestamp_ms: currentMs, text: speakerLine[2].trim() });
      else if (!out.length) out.push({ speaker: "Unknown speaker", timestamp_ms: 0, text: line });
      else out[out.length - 1].text += ` ${line}`;
    }
    const split: typeof out = [];
    for (const segment of out.filter((s) => s.text)) {
      for (let i = 0; i < segment.text.length; i += 28000)
        split.push({ ...segment, text: segment.text.slice(i, i + 28000) });
    }
    if (!split.length || split.length > 300) throw new ApiError(422, "INVALID_TRANSCRIPT", "Transcript must contain between 1 and 300 readable segments.");
    return split;
  };
  app.get("/api/v1/autopilot", async (c) => {
    const implementationId = z.uuid().parse(c.req.query("implementation_id"));
    const repo = c.get("identity").repo;
    await verifyImplementation(repo, implementationId, c.get("workspace"));
    const runs = await repo.list("autopilot_runs", { implementation_id: implementationId, workspace_id: c.get("workspace") }, 50);
    return ok(c, await Promise.all(runs.map((run) => runView(repo, run))));
  });
  app.get("/api/v1/autopilot/providers", (c) => ok(c, {
    transcript_import: { available: true, formats: [".txt", ".md", ".vtt", ".pdf", ".docx", ".xlsx", ".csv"], maximum_file_bytes: 10 * 1024 * 1024, maximum_extracted_characters: 100000 },
    google_meet: googleMeetPilot.status(),
  }));
  app.post("/api/v1/autopilot/runs", async (c) => {
    if (!can(c.get("role"), "work.write")) throw new ApiError(403, "FORBIDDEN", "Your role cannot start an implementation workflow.");
    const input = z.object({ implementation_id: z.uuid() }).strict().parse(await c.req.json());
    const repo = c.get("identity").repo;
    await verifyImplementation(repo, input.implementation_id, c.get("workspace"));
    const existing = await repo.list("autopilot_runs", { implementation_id: input.implementation_id, workspace_id: c.get("workspace") }, 50);
    const latest = existing[0];
    if (latest && ["READY", "IN_PROGRESS", "WAITING_APPROVAL", "FAILED"].includes(latest.status)) return ok(c, await runView(repo, latest));
    const run = await repo.insert("autopilot_runs", {
      workspace_id: c.get("workspace"), implementation_id: input.implementation_id,
      kind: "KICKOFF_TO_BRD", status: "READY", current_step: "PROJECT_CONTEXT",
      provider_status: "GOOGLE_MEET_NOT_CONNECTED", created_by: c.get("identity").id,
    });
    return ok(c, await runView(repo, run), {}, 201);
  });
  app.get("/api/v1/autopilot/runs/:id", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    return ok(c, await runView(repo, run));
  });
  app.post("/api/v1/autopilot/runs/:id/resume", async (c) => {
    if (!can(c.get("role"), "work.write")) throw new ApiError(403, "FORBIDDEN", "Your role cannot resume this workflow.");
    const id = z.uuid().parse(c.req.param("id"));
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    if (["COMPLETED", "CANCELLED"].includes(run.status)) throw new ApiError(409, "WORKFLOW_CLOSED", "Completed or cancelled workflows cannot be resumed.");
    const updated = ["FAILED", "IN_PROGRESS"].includes(run.status)
      ? await repo.update("autopilot_runs", run.id, run.workspace_id, { status: "READY", last_error_code: null })
      : run;
    return ok(c, await runView(repo, updated ?? run));
  });
  app.post("/api/v1/autopilot/runs/:id/cancel", async (c) => {
    if (!can(c.get("role"), "plan.manage")) throw new ApiError(403, "FORBIDDEN", "An implementation manager must cancel this workflow.");
    const id = z.uuid().parse(c.req.param("id"));
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    if (["COMPLETED", "CANCELLED"].includes(run.status)) throw new ApiError(409, "WORKFLOW_CLOSED", "This workflow is already closed.");
    const updated = await repo.update("autopilot_runs", run.id, run.workspace_id, { status: "CANCELLED", last_error_code: null });
    return ok(c, updated);
  });
  app.post("/api/v1/autopilot/runs/:id/transcripts", async (c) => {
    if (!can(c.get("role"), "work.write")) throw new ApiError(403, "FORBIDDEN", "Your role cannot import a transcript.");
    const id = z.uuid().parse(c.req.param("id"));
    const input = z.object({ title: z.string().trim().min(2).max(160), occurred_at: z.iso.datetime().optional(), content: z.string().trim().min(20).max(100000) }).strict().parse(await c.req.json());
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    if (["COMPLETED", "CANCELLED"].includes(run.status)) throw new ApiError(409, "WORKFLOW_CLOSED", "This workflow is already closed.");
    const segments = transcriptSegments(input.content);
    const fingerprint = createHash("sha256").update(input.content.trim()).digest("hex");
    let meeting = (await repo.list("meetings", { workspace_id: run.workspace_id, implementation_id: run.implementation_id, external_id: `import:${fingerprint}` }, 1))[0];
    if (!meeting) {
      meeting = await repo.insert("meetings", {
        workspace_id: run.workspace_id, implementation_id: run.implementation_id,
        title: input.title, start_time: input.occurred_at ?? null, provider: "TRANSCRIPT_IMPORT",
        external_id: `import:${fingerprint}`, transcript_status: "IMPORTED",
      });
      for (const segment of segments) await repo.insert("meeting_transcripts", {
        workspace_id: run.workspace_id, implementation_id: run.implementation_id,
        meeting_id: meeting.id, ...segment, metadata: { import_fingerprint: fingerprint },
      });
    }
    const sourceIds = [...new Set([...(run.source_meeting_ids ?? []), meeting.id])];
    const updated = await repo.update("autopilot_runs", run.id, run.workspace_id, {
      source_meeting_ids: sourceIds, status: "READY", current_step: "MEETING_CAPTURE", last_error_code: null,
    });
    return ok(c, { meeting, segment_count: segments.length, duplicate: Boolean(run.source_meeting_ids?.includes(meeting.id)), run: await runView(repo, updated ?? run) }, {}, 201);
  });
  app.post("/api/v1/autopilot/runs/:id/meetings/join", async (c) => {
    if (!can(c.get("role"), "work.write")) throw new ApiError(403, "FORBIDDEN", "Your role cannot connect meeting capture.");
    const id = z.uuid().parse(c.req.param("id"));
    const { meeting_url } = z.object({ meeting_url: z.url().refine((value) => new URL(value).hostname === "meet.google.com", "Enter a Google Meet link.") }).strict().parse(await c.req.json());
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    await repo.update("autopilot_runs", run.id, run.workspace_id, { provider_status: "GOOGLE_MEET_NOT_CONNECTED", last_error_code: "MEETING_PROVIDER_NOT_CONFIGURED" });
    try { await googleMeetPilot.startCapture({ meetingUrl: meeting_url, implementationId: run.implementation_id }); }
    catch { throw new ApiError(503, "MEETING_PROVIDER_NOT_CONFIGURED", "Google Meet capture is not connected. Import a transcript here; the workflow is saved and can be resumed after connector setup."); }
  });
  app.post("/api/v1/autopilot/runs/:id/generate", async (c) => {
    if (!can(c.get("role"), "work.write")) throw new ApiError(403, "FORBIDDEN", "Your role cannot prepare workflow drafts.");
    const id = z.uuid().parse(c.req.param("id"));
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    if (["COMPLETED", "CANCELLED"].includes(run.status)) throw new ApiError(409, "WORKFLOW_CLOSED", "This workflow is already closed.");
    if (run.status === "WAITING_APPROVAL" && run.storyboard_document_id && run.brd_document_id)
      return ok(c, await runView(repo, run));
    const markFailed = async (code: string) => repo.update("autopilot_runs", run.id, run.workspace_id, { status: "FAILED", current_step: "DRAFTING", last_error_code: code });
    if (!config.generateDocument) {
      await markFailed("AI_NOT_CONFIGURED");
      throw new ApiError(503, "AI_NOT_CONFIGURED", "Connect a server-side AI provider to prepare drafts. Your workflow and imported transcript are saved; no project data was sent.");
    }
    rate(`autopilot-generate:${c.get("identity").id}`, 5);
    await repo.update("autopilot_runs", run.id, run.workspace_id, { status: "IN_PROGRESS", current_step: "DRAFTING", last_error_code: null });
    try {
      const implementation = (await verifyImplementation(repo, run.implementation_id, run.workspace_id));
      const [company, requirements, tasks, risks, stakeholders, meetings] = await Promise.all([
        repo.list("companies", { id: implementation.company_id, workspace_id: run.workspace_id }, 1),
        repo.list("requirements", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
        repo.list("tasks", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
        repo.list("risks", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
        repo.list("stakeholders", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
        Promise.all((run.source_meeting_ids ?? []).map((meetingId: string) => repo.list("meetings", { id: meetingId, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 1))).then((rows) => rows.flat()),
      ]);
      const transcriptRows = (await Promise.all(meetings.map((meeting: Row) => repo.list("meeting_transcripts", { meeting_id: meeting.id, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 300)))).flat().sort((a, b) => a.timestamp_ms - b.timestamp_ms);
      const transcriptContext = transcriptRows.map((t) => ({ transcript_id: t.id, meeting_id: t.meeting_id, speaker: t.speaker, timestamp_ms: t.timestamp_ms, text: t.text }));
      const common = {
        implementation: { name: implementation.name, status: implementation.status, description: implementation.description, implementation_type: implementation.implementation_type, target_go_live_date: implementation.target_go_live_date, company: company[0] ? { name: company[0].name, industry: company[0].industry } : null },
        context: {
          confirmed_requirements: requirements.map(({ title, description, priority, status }) => ({ title, description, priority, status })),
          current_tasks: tasks.slice(0, 50).map(({ title, description, status, priority }) => ({ title, description, status, priority })),
          known_risks: risks.map(({ title, description, severity, status }) => ({ title, description, severity, status })),
          stakeholders: stakeholders.map(({ name, role, company: org }) => ({ name, role, company: org })),
          meeting_transcript_segments: transcriptContext,
        },
      };
      const outputSchema = z.object({ content: z.string().trim().min(50).max(100000), source_notes: z.array(z.string().max(1000)).max(30).default([]), open_questions: z.array(z.string().max(500)).max(50).default([]), proposals: z.array(proposalSchema).max(100).default([]) }).passthrough();
      const putDocument = async (existingId: string | null, name: string, type: string, content: string, notes: string[], questions: string[]) => {
        const fields = { name, type, content, status: "DRAFT", template_id: `autopilot/${type.toLowerCase()}`, change_summary: "Prepared by Implementation Autopilot · human review required", generation_notes: notes, open_questions: questions, source: "AI_GENERATED", processing_status: "COMPLETED", uploaded_by: c.get("identity").id };
        if (existingId) {
          const current = (await repo.list("documents", { id: existingId, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 1))[0];
          if (current && ["APPROVED", "ARCHIVED"].includes(current.status)) throw new ApiError(409, "DOCUMENT_LOCKED", "An approved or archived draft cannot be regenerated. Start a new workflow to preserve the signed-off document.");
          return (await repo.update("documents", existingId, run.workspace_id, fields))!;
        }
        return repo.insert("documents", { ...fields, workspace_id: run.workspace_id, implementation_id: run.implementation_id });
      };
      const previous = run.status === "FAILED" ? await Promise.all([
        run.storyboard_document_id ? repo.list("documents", { id: run.storyboard_document_id, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 1) : [],
        run.brd_document_id ? repo.list("documents", { id: run.brd_document_id, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 1) : [],
      ]) : [[], []];
      const savedStoryboard = previous[0][0]?.source === "AI_GENERATED" ? previous[0][0] : null;
      const savedBrd = previous[1][0]?.source === "AI_GENERATED" ? previous[1][0] : null;
      const [storyboardResult, brdResult] = await Promise.allSettled([
        savedStoryboard ? Promise.resolve(null) : config.generateDocument({ type: "Kickoff storyboard", ...common, userNotes: "Create a concise, editable 8–10 slide in-app kickoff storyboard. Clearly distinguish known project context from items to confirm. Do not present generated assumptions as decisions." }),
        savedBrd ? Promise.resolve(null) : config.generateDocument({ type: "Business requirements document", ...common, userNotes: "Create the BRD in the existing Nexus BRD structure. Treat transcript material as evidence to validate, not automatically approved scope. Include open questions for ambiguous, conflicting, or missing material. Return traceable proposals only when supported by exact transcript quotations." }),
      ]);
      const storyboardOutput = storyboardResult.status === "fulfilled" && storyboardResult.value ? outputSchema.parse(storyboardResult.value) : null;
      const brdOutput = brdResult.status === "fulfilled" && brdResult.value ? outputSchema.parse(brdResult.value) : null;
      const verifiedProposals = (brdOutput?.proposals ?? []).map((item) => {
        const refs = item.evidence.map((ref) => {
          const source = transcriptRows.find((t) => t.id === ref.transcript_id);
          if (!source || !source.text.toLocaleLowerCase().includes(ref.excerpt.toLocaleLowerCase()))
            throw new ApiError(422, "UNVERIFIED_EVIDENCE", "An AI citation did not match the imported transcript. Previous drafts remain safe; retry or use the structured templates.");
          return { transcript_id: ref.transcript_id, excerpt: ref.excerpt, source };
        });
        if (["REQUIREMENT", "ACTION", "RISK"].includes(item.kind) && !refs.length)
          throw new ApiError(422, "UNVERIFIED_EVIDENCE", "An AI proposal lacks meeting evidence. Previous drafts remain safe; retry or use the structured templates.");
        return { item, refs };
      });
      const citationLines = [...new Map(verifiedProposals.flatMap(({ refs }) => refs).map(({ excerpt, source }) => {
        const seconds = Math.floor(source.timestamp_ms / 1000);
        const time = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
        const meeting = meetings.find((m) => m.id === source.meeting_id);
        return [`${source.id}:${excerpt}`, `- **${meeting?.title ?? "Imported meeting"} · ${source.speaker} · ${time}** — “${excerpt.replaceAll("\n", " ")}” · transcript segment \`${source.id}\``];
      })).values()];
      const brdContent = brdOutput ? citationLines.length ? `${brdOutput.content}\n\n## Meeting evidence · pending human validation\n\n${citationLines.join("\n")}` : brdOutput.content : "";
      const storyboardDoc = storyboardOutput ? await putDocument(run.storyboard_document_id, `${implementation.name} · Kickoff storyboard`, "KICKOFF_STORYBOARD", storyboardOutput.content, storyboardOutput.source_notes, storyboardOutput.open_questions) : savedStoryboard;
      if (storyboardOutput && storyboardDoc) await repo.update("autopilot_runs", run.id, run.workspace_id, { storyboard_document_id: storyboardDoc.id });
      const brdDoc = brdOutput ? await putDocument(run.brd_document_id, `${implementation.name} · Business requirements`, "BRD", brdContent, brdOutput.source_notes, brdOutput.open_questions) : savedBrd;
      if (brdOutput && brdDoc) await repo.update("autopilot_runs", run.id, run.workspace_id, { brd_document_id: brdDoc.id });
      for (const { item, refs: verifiedRefs } of verifiedProposals) {
        const refs = verifiedRefs.map(({ transcript_id, excerpt }) => ({ transcript_id, excerpt }));
        const duplicate = (await repo.list("autopilot_proposals", { run_id: run.id, workspace_id: run.workspace_id }, 100)).find((p) => p.proposal_type === item.kind && p.title.toLocaleLowerCase() === item.title.toLocaleLowerCase());
        const fields = { proposal_type: item.kind, title: item.title, description: item.description, evidence_refs: refs, status: "PROPOSED" };
        if (!duplicate) await repo.insert("autopilot_proposals", { ...fields, workspace_id: run.workspace_id, implementation_id: run.implementation_id, run_id: run.id, created_by: c.get("identity").id });
      }
      const failure = storyboardResult.status === "rejected" ? storyboardResult.reason : brdResult.status === "rejected" ? brdResult.reason : null;
      if (failure) throw failure;
      if (!storyboardDoc || !brdDoc) throw new Error("Draft generation did not return both documents.");
      const updated = await repo.update("autopilot_runs", run.id, run.workspace_id, { storyboard_document_id: storyboardDoc.id, brd_document_id: brdDoc.id, status: "WAITING_APPROVAL", current_step: "HUMAN_REVIEW", last_error_code: null });
      return ok(c, await runView(repo, updated ?? run));
    } catch (error) {
      const providerCodes = ["AI_PROVIDER_TIMEOUT", "AI_PROVIDER_RATE_LIMITED", "AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_REJECTED", "AI_RESPONSE_INCOMPLETE", "AI_RESPONSE_INVALID"];
      const code = error instanceof z.ZodError ? "AI_OUTPUT_INVALID" : error instanceof ApiError ? error.code : error instanceof Error && providerCodes.includes(error.name) ? error.name : "AUTOPILOT_GENERATION_FAILED";
      await markFailed(code);
      if (error instanceof ApiError) throw error;
      const messages: Record<string, string> = {
        AI_PROVIDER_TIMEOUT: "The AI provider took too long. Any completed draft was saved; retry to generate only what is missing.",
        AI_PROVIDER_RATE_LIMITED: "The AI provider is busy. Any completed draft was saved; wait a moment and retry.",
        AI_PROVIDER_UNAVAILABLE: "The AI provider is temporarily unavailable. Any completed draft was saved; retry when it recovers.",
        AI_PROVIDER_REJECTED: "The AI provider rejected this request. Check the model and account configuration before retrying.",
        AI_RESPONSE_INCOMPLETE: "The AI provider stopped before finishing a draft. Any completed draft was saved; retry the missing one.",
        AI_RESPONSE_INVALID: "The AI provider returned an unreadable draft. Any completed draft was saved; retry the missing one.",
        AI_OUTPUT_INVALID: "The AI draft did not meet the required document format. Any completed draft was saved; retry the missing one.",
      };
      throw new ApiError(502, code, messages[code] ?? "Draft preparation did not complete. Your transcript and previous drafts are preserved; retry when the provider is available.");
    }
  });
  app.post("/api/v1/autopilot/runs/:id/prepare-templates", async (c) => {
    if (!can(c.get("role"), "work.write")) throw new ApiError(403, "FORBIDDEN", "Your role cannot prepare workflow drafts.");
    const id = z.uuid().parse(c.req.param("id"));
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    if (["COMPLETED", "CANCELLED"].includes(run.status)) throw new ApiError(409, "WORKFLOW_CLOSED", "This workflow is already closed.");
    const implementation = await verifyImplementation(repo, run.implementation_id, run.workspace_id);
    const [company, requirements, tasks, stakeholders, risks] = await Promise.all([
      repo.list("companies", { id: implementation.company_id, workspace_id: run.workspace_id }, 1),
      repo.list("requirements", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
      repo.list("tasks", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
      repo.list("stakeholders", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
      repo.list("risks", { implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 100),
    ]);
    const implementationContext = { ...implementation, company: company[0] ?? null };
    const related = { requirements, tasks, stakeholders, risks };
    const transcriptRows = (await Promise.all((run.source_meeting_ids ?? []).map((meetingId: string) => repo.list("meeting_transcripts", { meeting_id: meetingId, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 300)))).flat();
    const meetings = (await Promise.all((run.source_meeting_ids ?? []).map((meetingId: string) => repo.list("meetings", { id: meetingId, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 1)))).flat();
    const excerpts = transcriptRows.slice(0, 80).map((t) => {
      const seconds = Math.floor(t.timestamp_ms / 1000);
      const time = `${String(Math.floor(seconds / 3600)).padStart(2,"0")}:${String(Math.floor((seconds%3600)/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;
      return `> **${t.speaker} · ${meetings.find((m) => m.id === t.meeting_id)?.title ?? "Imported meeting"} · ${time}**\n> ${String(t.text).slice(0, 280)}`;
    }).join("\n\n");
    const evidenceAppendix = excerpts ? `\n\n## Imported transcript excerpts (verbatim; not AI-analyzed)\n\n${excerpts}` : "";
    const sourceNotes = ["Project records used to populate this editable template.", ...(transcriptRows.length ? [`${Math.min(transcriptRows.length, 80)} verbatim transcript segments attached for human review; no AI analysis was performed.`] : [])];
    const saveDocument = async (docId: string | null, name: string, type: string) => {
      const content = `${templateFor(type, implementationContext, related)}${evidenceAppendix}`;
      const fields = { name, type, content, status: "DRAFT", template_id: `autopilot/template/${type.toLowerCase()}`, change_summary: "Structured working draft · AI not used", generation_notes: sourceNotes, open_questions: ["Review every placeholder and validate imported transcript evidence before approval."], source: "HUMAN", processing_status: "COMPLETED", uploaded_by: c.get("identity").id };
      if (docId) {
        const current = (await repo.list("documents", { id: docId, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 1))[0];
        if (current && ["APPROVED", "ARCHIVED"].includes(current.status)) throw new ApiError(409, "DOCUMENT_LOCKED", "An approved or archived draft cannot be regenerated. Start a new workflow to preserve the signed-off document.");
        return (await repo.update("documents", docId, run.workspace_id, fields))!;
      }
      return repo.insert("documents", { ...fields, workspace_id: run.workspace_id, implementation_id: run.implementation_id });
    };
    const storyboard = await saveDocument(run.storyboard_document_id, `${implementation.name} · Kickoff storyboard`, "KICKOFF_STORYBOARD");
    await repo.update("autopilot_runs", run.id, run.workspace_id, { storyboard_document_id: storyboard.id, status: "IN_PROGRESS", current_step: "DRAFTING", last_error_code: null });
    const brd = await saveDocument(run.brd_document_id, `${implementation.name} · Business requirements`, "BRD");
    const updated = await repo.update("autopilot_runs", run.id, run.workspace_id, { brd_document_id: brd.id, status: "WAITING_APPROVAL", current_step: "HUMAN_REVIEW", last_error_code: null });
    return ok(c, await runView(repo, updated ?? run));
  });
  app.post("/api/v1/autopilot/proposals/:id/decision", async (c) => {
    if (!can(c.get("role"), "plan.manage")) throw new ApiError(403, "FORBIDDEN", "An implementation manager must approve or reject proposals.");
    const id = z.uuid().parse(c.req.param("id"));
    const { decision } = z.object({ decision: z.enum(["APPROVED", "REJECTED"]) }).strict().parse(await c.req.json());
    const repo = c.get("identity").repo;
    const proposal = (await repo.list("autopilot_proposals", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!proposal) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Proposal not found.");
    if (proposal.status !== "PROPOSED") throw new ApiError(409, "PROPOSAL_ALREADY_REVIEWED", "This proposal has already been reviewed.");
    let targetEntityId: string | null = proposal.target_entity_id ?? null;
    if (decision === "APPROVED" && ["REQUIREMENT", "ACTION", "RISK"].includes(proposal.proposal_type)) {
      const sources: any[] = proposal.evidence_refs ?? [];
      const segments = (await Promise.all(sources.map((ref) => repo.list("meeting_transcripts", { id: ref.transcript_id, implementation_id: proposal.implementation_id, workspace_id: proposal.workspace_id }, 1)))).flat();
      const valid = sources.filter((ref) => segments.some((s) => s.id === ref.transcript_id && s.text.toLocaleLowerCase().includes(String(ref.excerpt).toLocaleLowerCase())));
      if (!valid.length || valid.length !== sources.length) throw new ApiError(409, "EVIDENCE_UNAVAILABLE", "The source evidence is incomplete or unavailable; keep this item unapproved and review it manually.");
      const sourceMeeting = segments[0]?.meeting_id;
      const targetType = proposal.proposal_type === "REQUIREMENT" ? "requirements" : proposal.proposal_type === "ACTION" ? "tasks" : "risks";
      if (!targetEntityId) {
        const record = proposal.proposal_type === "REQUIREMENT"
          ? await repo.insert("requirements", { workspace_id: proposal.workspace_id, implementation_id: proposal.implementation_id, title: proposal.title, description: proposal.description, status: "CONFIRMED", source_type: "MEETING", source_id: sourceMeeting, priority: "MEDIUM" })
          : proposal.proposal_type === "ACTION"
            ? await repo.insert("tasks", { workspace_id: proposal.workspace_id, implementation_id: proposal.implementation_id, title: proposal.title, description: proposal.description, status: "NOT_STARTED", source_type: "MEETING", source_id: sourceMeeting, priority: "MEDIUM" })
            : await repo.insert("risks", { workspace_id: proposal.workspace_id, implementation_id: proposal.implementation_id, title: proposal.title, description: proposal.description, status: "OPEN", source_type: "MEETING", source_id: sourceMeeting, severity: "MEDIUM" });
        targetEntityId = record.id;
        await repo.update("autopilot_proposals", proposal.id, proposal.workspace_id, { target_entity_id: targetEntityId });
      }
      const targetGraph = (await repo.list("graph_entities", { entity_type: targetType, entity_id: targetEntityId, workspace_id: proposal.workspace_id }, 1))[0];
      for (const ref of valid) {
        const source = segments.find((s) => s.id === ref.transcript_id)!;
        const sourceGraph = (await repo.list("graph_entities", { entity_type: "meetings", entity_id: source.meeting_id, workspace_id: proposal.workspace_id }, 1))[0];
        if (sourceGraph && targetGraph) {
          const existingLink = (await repo.list("evidence_links", { source_entity_id: sourceGraph.id, target_entity_id: targetGraph.id, relationship: "SUPPORTS", workspace_id: proposal.workspace_id }, 1))[0];
          if (!existingLink) await repo.insert("evidence_links", { workspace_id: proposal.workspace_id, implementation_id: proposal.implementation_id, source_entity_id: sourceGraph.id, target_entity_id: targetGraph.id, relationship: "SUPPORTS", excerpt: ref.excerpt, timestamp_ms: source.timestamp_ms, speaker: source.speaker });
        }
      }
    }
    const updated = await repo.update("autopilot_proposals", proposal.id, proposal.workspace_id, { status: decision, target_entity_id: targetEntityId, reviewed_by: c.get("identity").id, reviewed_at: new Date().toISOString() });
    return ok(c, updated);
  });
  app.post("/api/v1/autopilot/runs/:id/complete", async (c) => {
    if (!can(c.get("role"), "plan.manage")) throw new ApiError(403, "FORBIDDEN", "An implementation manager must complete this workflow.");
    const id = z.uuid().parse(c.req.param("id"));
    const repo = c.get("identity").repo;
    const run = (await repo.list("autopilot_runs", { id, workspace_id: c.get("workspace") }, 1))[0];
    if (!run) throw new ApiError(404, "RESOURCE_NOT_FOUND", "Autopilot workflow not found.");
    if (!run.storyboard_document_id || !run.brd_document_id) throw new ApiError(409, "DRAFTS_REQUIRED", "Prepare both kickoff and BRD drafts before completing this workflow.");
    const docs = (await Promise.all([run.storyboard_document_id, run.brd_document_id].map((docId: string) => repo.list("documents", { id: docId, implementation_id: run.implementation_id, workspace_id: run.workspace_id }, 1)))).flat();
    if (docs.length !== 2 || docs.some((doc) => doc.status !== "APPROVED")) throw new ApiError(409, "DOCUMENT_APPROVAL_REQUIRED", "Approve both documents in Document Studio before completing this workflow.");
    const proposals = await repo.list("autopilot_proposals", { run_id: run.id, workspace_id: run.workspace_id }, 100);
    if (proposals.some((p) => p.status === "PROPOSED")) throw new ApiError(409, "PROPOSALS_REMAIN", "Review all proposed requirements, actions, risks and decisions first.");
    const updated = await repo.update("autopilot_runs", run.id, run.workspace_id, { status: "COMPLETED", current_step: "COMPLETE", reviewed_by: c.get("identity").id, reviewed_at: new Date().toISOString(), last_error_code: null });
    return ok(c, updated);
  });
  app.post("/api/v1/documents/generate", async (c) => {
    if (!can(c.get("role"), "work.write"))
      throw new ApiError(403, "FORBIDDEN", "Your role cannot create documents.");
    if (!config.generateDocument)
      throw new ApiError(
        503,
        "AI_NOT_CONFIGURED",
        "Connect a server-side AI provider to generate a document. No project data was sent.",
      );
    rate(`document-generate:${c.get("identity").id}`, 8);
    const input = z
      .object({
        implementation_id: z.uuid(),
        type: z.enum(documentTypes.map((t) => t.id) as [string, ...string[]]),
        name: z.string().trim().min(2).max(160).optional(),
        notes: z.string().trim().max(4000).default(""),
      })
      .strict()
      .parse(await c.req.json());
    const repo = c.get("identity").repo;
    const implementation = (
      await repo.list(
        "implementations",
        {
          id: input.implementation_id,
          workspace_id: c.get("workspace"),
        },
        1,
      )
    )[0];
    if (!implementation)
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Implementation not found.",
      );
    const [company, requirements, milestones, tasks, risks, stakeholders] =
      await Promise.all([
        repo.list(
          "companies",
          { id: implementation.company_id, workspace_id: c.get("workspace") },
          1,
        ),
        repo.list(
          "requirements",
          {
            implementation_id: input.implementation_id,
            workspace_id: c.get("workspace"),
          },
          100,
        ),
        repo.list(
          "milestones",
          {
            implementation_id: input.implementation_id,
            workspace_id: c.get("workspace"),
          },
          100,
        ),
        repo.list(
          "tasks",
          {
            implementation_id: input.implementation_id,
            workspace_id: c.get("workspace"),
          },
          100,
        ),
        repo.list(
          "risks",
          {
            implementation_id: input.implementation_id,
            workspace_id: c.get("workspace"),
          },
          100,
        ),
        repo.list(
          "stakeholders",
          {
            implementation_id: input.implementation_id,
            workspace_id: c.get("workspace"),
          },
          100,
        ),
      ]);
    const typeName = documentTypes.find((t) => t.id === input.type)?.name ?? input.type;
    let generated: Awaited<ReturnType<NonNullable<Config["generateDocument"]>>>;
    try {
      generated = await config.generateDocument({
        type: typeName,
        implementation: {
          name: implementation.name,
          status: implementation.status,
          description: implementation.description,
          implementation_type: implementation.implementation_type,
          start_date: implementation.start_date,
          target_go_live_date: implementation.target_go_live_date,
          company: company[0]
            ? {
                name: company[0].name,
                industry: company[0].industry,
                description: company[0].description,
              }
            : null,
        },
        context: {
          requirements: requirements.map(({ id: _id, title, description, priority, status }) => ({ title, description, priority, status })),
          milestones: milestones.map(({ name, description, target_date, status }) => ({ name, description, target_date, status })),
          tasks: tasks.map(({ title, description, status, priority, due_date }) => ({ title, description, status, priority, due_date })),
          risks: risks.map(({ title, description, severity, impact, status }) => ({ title, description, severity, impact, status })),
          stakeholders: stakeholders.map(({ name, role, company: stakeholderCompany }) => ({ name, role, company: stakeholderCompany })),
        },
        userNotes: input.notes,
      });
    } catch {
      throw new ApiError(
        502,
        "AI_PROVIDER_UNAVAILABLE",
        "The AI provider could not generate this draft. Your existing documents were not changed.",
      );
    }
    const normalized = z
      .object({
        content: z.string().min(50).max(100000),
        source_notes: z.array(z.string().max(1000)).max(30).default([]),
        open_questions: z.array(z.string().max(500)).max(50).default([]),
      })
      .parse(generated);
    const document = await repo.insert("documents", {
      workspace_id: c.get("workspace"),
      implementation_id: input.implementation_id,
      name: input.name ?? `${implementation.name} · ${typeName}`,
      type: input.type,
      content: normalized.content,
      status: "DRAFT",
      template_id: `ai-${input.type.toLowerCase()}-v1`,
      change_summary: `AI draft · ${config.aiProvider ?? "configured provider"}`,
      generation_notes: normalized.source_notes,
      open_questions: normalized.open_questions,
      source: "AI_GENERATED",
      processing_status: "COMPLETED",
      uploaded_by: c.get("identity").id,
    });
    return ok(c, document, {}, 201);
  });
  app.get("/api/v1/portfolio", async (c) => {
    const repo = c.get("identity").repo,
      w = c.get("workspace"),
      implementations = await all(repo, "implementations", { workspace_id: w });
    const [
      tasks,
      milestones,
      requirements,
      risks,
      dependencies,
      stages,
      companies,
    ] = await Promise.all(
      [
        "tasks",
        "milestones",
        "requirements",
        "risks",
        "task_dependencies",
        "implementation_stages",
        "companies",
      ].map((t) => all(repo, t, { workspace_id: w })),
    );
    const items = implementations.map((i) => ({
      ...i,
      status: i.status as string,
      company: companies.find((c) => c.id === i.company_id),
      current_stage:
        stages.find((s) => s.id === i.current_stage_id)?.name ?? "Planning",
      health: calculateImplementationHealth({
        tasks: tasks.filter((t) => t.implementation_id === i.id),
        milestones: milestones.filter((t) => t.implementation_id === i.id),
        requirements: requirements.filter((t) => t.implementation_id === i.id),
        risks: risks.filter((t) => t.implementation_id === i.id),
        dependencies: dependencies.filter((t) => t.implementation_id === i.id),
      }),
    }));
    return ok(c, {
      items,
      summary: {
        active: items.filter((i) => i.status === "ACTIVE").length,
        attention: items.filter((i) =>
          ["AT_RISK", "BLOCKED", "WATCH"].includes(i.health.health_status),
        ).length,
        completed_tasks: tasks.filter((t) => t.status === "COMPLETED").length,
        open_tasks: tasks.filter(
          (t) => !["COMPLETED", "CANCELLED"].includes(t.status),
        ).length,
      },
    });
  });
  for (const [route, table] of Object.entries(routes)) {
    app.get(`/api/v1/${route}`, async (c) => {
      const filters: Record<string, string> = {
        workspace_id: c.get("workspace"),
      };
      const implementation = c.req.query("implementation_id");
      if (implementation)
        filters.implementation_id = z.uuid().parse(implementation);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50)
        .parse(c.req.query("limit"));
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .default(0)
        .parse(c.req.query("offset"));
      return ok(
        c,
        await c.get("identity").repo.list(table, filters, limit, offset),
        { limit, offset },
      );
    });
    app.post(`/api/v1/${route}`, async (c) => {
      if (!can(c.get("role"), capabilityFor(table)))
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Your role cannot make this change.",
        );
      let input: Record<string, unknown> = schemas[table].parse(
        await c.req.json(),
      );
      if (table === "companies" && input.website) {
        try {
          input = {
            ...input,
            ...normalizeCompanyWebsite(String(input.website)),
          };
        } catch {
          throw new ApiError(
            422,
            "INVALID_WEBSITE",
            "Enter a public company website.",
          );
        }
      }
      return ok(
        c,
        await c.get("identity").repo.insert(table, {
          ...input,
          workspace_id: c.get("workspace"),
          ...(table === "documents"
            ? {
                source: "HUMAN",
                processing_status: "COMPLETED",
                uploaded_by: c.get("identity").id,
              }
            : {}),
        }),
        {},
        201,
      );
    });
  }
  for (const [route, table] of [["meetings", "meetings"], ["milestones", "milestones"]] as const) {
    app.patch(`/api/v1/${route}/:id`, async (c) => {
      if (!can(c.get("role"), capabilityFor(table)))
        throw new ApiError(403, "FORBIDDEN", `Your role cannot edit ${route}.`);
      const id = z.uuid().parse(c.req.param("id"));
      const body = await c.req.json();
      const input = route === "meetings"
        ? schemas.meetings.omit({ implementation_id: true }).partial().parse(body)
        : schemas.milestones.omit({ implementation_id: true }).partial().parse(body);
      if (Object.keys(input).length === 0) throw new ApiError(422, "EMPTY_UPDATE", "Provide at least one field.");
      const repo = c.get("identity").repo;
      const existing = (await repo.list(table, { id, workspace_id: c.get("workspace") }, 1))[0];
      if (!existing) throw new ApiError(404, "RESOURCE_NOT_FOUND", `${route === "meetings" ? "Meeting" : "Milestone"} not found.`);
      if (route === "meetings") {
        const meetingInput = input as { start_time?: string; end_time?: string };
        const start = meetingInput.start_time ?? existing.start_time;
        const end = meetingInput.end_time ?? existing.end_time;
        if (start && end && new Date(end).getTime() <= new Date(start).getTime())
          throw new ApiError(422, "INVALID_MEETING_TIME", "The end time must be after the start time.");
      }
      const updated = await repo.update(table, id, c.get("workspace"), input);
      if (!updated) throw new ApiError(404, "RESOURCE_NOT_FOUND", `${route === "meetings" ? "Meeting" : "Milestone"} not found.`);
      return ok(c, updated);
    });
  }
  app.patch("/api/v1/tasks/:id", async (c) => {
    if (!can(c.get("role"), "work.write"))
      throw new ApiError(403, "FORBIDDEN", "Your role cannot edit tasks.");
    const id = z.uuid().parse(c.req.param("id")),
      input = schemas.tasks
        .omit({ implementation_id: true })
        .partial()
        .refine((v) => Object.keys(v).length > 0, "Provide at least one field.")
        .parse(await c.req.json());
    const result = await c
      .get("identity")
      .repo.update("tasks", id, c.get("workspace"), input);
    if (!result)
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Task not found.");
    return ok(c, result);
  });
  app.patch("/api/v1/documents/:id", async (c) => {
    if (!can(c.get("role"), "work.write"))
      throw new ApiError(403, "FORBIDDEN", "Your role cannot edit documents.");
    const id = z.uuid().parse(c.req.param("id"));
    const input = schemas.documents
      .omit({ implementation_id: true })
      .partial()
      .refine((v) => Object.keys(v).length > 0, "Provide at least one field.")
      .parse(await c.req.json());
    const existing = (
      await c.get("identity").repo.list(
        "documents",
        { id, workspace_id: c.get("workspace") },
        1,
      )
    )[0];
    if (!existing)
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Document not found.");
    const manager = can(c.get("role"), "plan.manage");
    if (input.status === "APPROVED" && String(existing.template_id ?? "").startsWith("autopilot/") && (input.open_questions ?? existing.open_questions ?? []).length)
      throw new ApiError(409, "OPEN_QUESTIONS_REMAIN", "Resolve the draft’s open questions before approving this Autopilot document.");
    const isContentChange = ["name", "type", "content", "template_id"].some(
      (field) => field in input,
    );
    if (
      !manager &&
      ((input.status && ["APPROVED", "ARCHIVED"].includes(input.status)) ||
        (["APPROVED", "ARCHIVED"].includes(existing.status) &&
          (input.status !== undefined || isContentChange)))
    )
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Only an implementation manager can approve, archive, or change a controlled document.",
      );
    const result = await c.get("identity").repo.update(
      "documents",
      id,
      c.get("workspace"),
      {
        ...input,
        change_summary: input.change_summary ?? "Document updated",
      },
    );
    if (!result)
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "Document not found.");
    return ok(c, result);
  });
  for (const [route, table] of Object.entries({
    members: "workspace_members",
    activity: "activity_events",
    audit: "audit_logs",
    jobs: "jobs",
  }))
    app.get(`/api/v1/${route}`, async (c) => {
      if (route === "audit" && !can(c.get("role"), "audit.read"))
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Audit access requires a manager role.",
        );
      return ok(
        c,
        await c
          .get("identity")
          .repo.list(table, { workspace_id: c.get("workspace") }, 100),
      );
    });
  app.get("/api/v1/search", async (c) => {
    const q = z
        .string()
        .trim()
        .min(2)
        .max(100)
        .parse(c.req.query("q"))
        .toLowerCase(),
      repo = c.get("identity").repo;
    const tables = [
      "implementations",
      "tasks",
      "requirements",
      "meetings",
      "documents",
      "stakeholders",
      "risks",
      "milestones",
    ];
    const sets = await Promise.all(
      tables.map((t) => all(repo, t, { workspace_id: c.get("workspace") })),
    );
    return ok(
      c,
      sets
        .flatMap((rows, i) =>
          rows
            .filter((r) =>
              `${r.title ?? r.name} ${r.description ?? r.summary ?? ""}`
                .toLowerCase()
                .includes(q),
            )
            .map((r) => ({
              id: r.id,
              entity: tables[i],
              title: r.title ?? r.name,
              snippet: (r.description ?? r.summary ?? "").slice(0, 180),
              implementation:
                r.implementation_id ??
                (tables[i] === "implementations" ? r.id : null),
              source: r.source_type ?? "HUMAN",
              relevance: (r.title ?? r.name ?? "").toLowerCase().includes(q)
                ? 1
                : 0.5,
            })),
        )
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, 50),
    );
  });
  app.post("/api/v1/ai/chat", () => {
    throw new ApiError(
      503,
      "AI_NOT_CONFIGURED",
      "AI is not connected. No answer or action has been generated.",
    );
  });
  app.notFound((c) =>
    c.json(
      {
        data: null,
        error: { code: "RESOURCE_NOT_FOUND", message: "Endpoint not found." },
        meta: { request_id: c.get("requestId") },
      },
      404,
    ),
  );
  app.onError((error, c) => {
    if (error instanceof ZodError)
      return c.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: "Check the highlighted fields.",
            fields: error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          },
          meta: { request_id: c.get("requestId") },
        },
        422,
      );
    if (error instanceof SyntaxError)
      return c.json(
        {
          data: null,
          error: { code: "INVALID_JSON", message: "Send a valid JSON body." },
        },
        400,
      );
    if (error instanceof ApiError)
      return c.json(
        {
          data: null,
          error: { code: error.code, message: error.message },
          meta: { request_id: c.get("requestId") },
        },
        error.status,
      );
    if (error instanceof DataError) {
      const forbidden = error.code === "42501";
      return c.json(
        {
          data: null,
          error: {
            code: forbidden ? "FORBIDDEN" : "DATA_CONFLICT",
            message: forbidden
              ? "You cannot change this record."
              : "This change conflicts with an existing record or dependency. Check the selected workspace and related records.",
          },
          meta: { request_id: c.get("requestId") },
        },
        forbidden ? 403 : 409,
      );
    }
    console.error(
      JSON.stringify({
        request_id: c.get("requestId"),
        code: "INTERNAL_ERROR",
      }),
    );
    return c.json(
      {
        data: null,
        error: {
          code: "INTERNAL_ERROR",
          message:
            "We could not complete this request. Use the request ID when contacting support.",
        },
        meta: { request_id: c.get("requestId") },
      },
      500,
    );
  });
  return app;
}
