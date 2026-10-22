import { z } from "zod";

export const roles = [
  "OWNER",
  "ADMIN",
  "IMPLEMENTATION_MANAGER",
  "IMPLEMENTATION_MEMBER",
  "VIEWER",
] as const;
export type Role = (typeof roles)[number];
export type Capability =
  "read" | "work.write" | "plan.manage" | "audit.read" | "workspace.manage";
const capabilities: Record<Capability, readonly Role[]> = {
  read: roles,
  "work.write": roles.filter((r) => r !== "VIEWER"),
  "plan.manage": ["OWNER", "ADMIN", "IMPLEMENTATION_MANAGER"],
  "audit.read": ["OWNER", "ADMIN", "IMPLEMENTATION_MANAGER"],
  "workspace.manage": ["OWNER", "ADMIN"],
};
export const can = (role: Role, capability: Capability) =>
  capabilities[capability].includes(role);
export type Row = { id: string; workspace_id: string; [key: string]: any };
export const taskStatuses = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
] as const;
const id = z.uuid();
const name = z.string().trim().min(2).max(160);
const description = z.string().trim().max(10000).optional();
const date = z.iso.date().nullable().optional();
const priority = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const scoped = { implementation_id: id };
export const schemas = {
  companies: z
    .object({
      name,
      website: z.url().optional(),
      description,
      industry: z.string().max(100).optional(),
    })
    .strict(),
  implementations: z
    .object({
      name,
      company_id: id,
      description,
      implementation_type: z.string().max(100).optional(),
      status: z
        .enum([
          "DRAFT",
          "PLANNING",
          "ACTIVE",
          "ON_HOLD",
          "COMPLETED",
          "CANCELLED",
        ])
        .optional(),
      start_date: date,
      target_go_live_date: date,
    })
    .strict(),
  implementation_stages: z
    .object({
      ...scoped,
      name,
      key: z
        .string()
        .regex(/^[a-z0-9_-]+$/)
        .max(60),
      sequence: z.number().int().min(0).max(100),
      status: z.enum(taskStatuses).optional(),
      description,
    })
    .strict(),
  tasks: z
    .object({
      ...scoped,
      title: name,
      description,
      stage_id: id.nullable().optional(),
      priority: priority.optional(),
      status: z.enum(taskStatuses).optional(),
      due_date: date,
      owner_id: id.nullable().optional(),
    })
    .strict(),
  milestones: z
    .object({
      ...scoped,
      name,
      description,
      target_date: date,
      status: z.enum(taskStatuses).optional(),
      sequence: z.number().int().min(0).optional(),
      owner_id: id.nullable().optional(),
    })
    .strict(),
  requirements: z
    .object({
      ...scoped,
      title: name,
      description,
      stage_id: id.nullable().optional(),
      priority: priority.optional(),
      status: z
        .enum([
          "DISCOVERED",
          "CONFIRMED",
          "IN_PROGRESS",
          "VALIDATED",
          "CHANGED",
          "REJECTED",
        ])
        .optional(),
    })
    .strict(),
  meetings: z
    .object({
      ...scoped,
      title: name,
      start_time: z.iso.datetime().optional(),
      end_time: z.iso.datetime().optional(),
      summary: description,
      meeting_type: z.enum(["KICKOFF", "DISCOVERY", "WORKSHOP", "STATUS_REVIEW", "DESIGN_REVIEW", "UAT", "TRAINING", "GO_LIVE", "CUSTOMER_CHECK_IN", "OTHER"]).optional(),
      status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED"]).optional(),
      timezone: z.string().trim().min(1).max(80).optional(),
      location: z.string().trim().max(250).optional(),
      meeting_url: z.url().max(1000).optional().or(z.literal("")),
      attendees: z.array(z.string().trim().min(2).max(200)).max(50).optional(),
      organizer_id: id.nullable().optional(),
    })
    .strict(),
  meeting_transcripts: z
    .object({
      ...scoped,
      meeting_id: id,
      speaker: name,
      timestamp_ms: z.number().int().nonnegative(),
      text: z.string().min(1).max(30000),
    })
    .strict(),
  documents: z
    .object({
      ...scoped,
      name,
      type: z.string().max(50).optional(),
      content: z.string().max(100000).optional(),
      status: z.enum(["DRAFT", "IN_REVIEW", "APPROVED", "ARCHIVED"]).optional(),
      template_id: z.string().max(80).nullable().optional(),
      change_summary: z.string().trim().max(500).optional(),
      generation_notes: z.array(z.string().max(1000)).max(100).optional(),
      open_questions: z.array(z.string().max(500)).max(100).optional(),
    })
    .strict(),
  stakeholders: z
    .object({
      ...scoped,
      name,
      email: z.email().optional(),
      role: z.string().max(100).optional(),
      company: z.string().max(160).optional(),
    })
    .strict(),
  risks: z
    .object({
      ...scoped,
      title: name,
      description,
      severity: priority.optional(),
      status: z
        .enum(["OPEN", "MONITORING", "MITIGATED", "RESOLVED", "ACCEPTED"])
        .optional(),
      impact: z.string().max(1000).optional(),
    })
    .strict(),
  evidence_links: z
    .object({
      ...scoped,
      source_entity_id: id,
      target_entity_id: id,
      relationship: z.string().min(2).max(100),
      excerpt: z.string().max(10000).optional(),
      speaker: z.string().max(160).optional(),
      timestamp_ms: z.number().int().nonnegative().optional(),
      page_number: z.number().int().positive().optional(),
    })
    .strict(),
  task_dependencies: z
    .object({
      ...scoped,
      task_id: id,
      depends_on_task_id: id,
      dependency_type: z
        .enum(["BLOCKED_BY", "BLOCKS", "RELATED_TO"])
        .optional(),
    })
    .strict(),
};
export type MutableTable = keyof typeof schemas;
export const readableTables = [
  ...Object.keys(schemas),
  "workspaces",
  "workspace_members",
  "graph_entities",
  "activity_events",
  "audit_logs",
  "jobs",
  "autopilot_runs",
  "autopilot_proposals",
  "playbooks",
  "playbook_versions",
  "intelligence_assets",
  "intelligence_asset_versions",
  "plan_proposals",
  "document_versions",
] as const;
export function capabilityFor(table: string): Capability {
  return [
    "companies",
    "implementations",
    "implementation_stages",
    "milestones",
    "playbooks",
  ].includes(table)
    ? "plan.manage"
    : "work.write";
}
export function normalizeCompanyWebsite(raw: string) {
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname.includes(".") ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)
  )
    throw new Error("Enter a public company website.");
  return {
    website: `https://${url.hostname.toLowerCase()}`,
    domain: url.hostname.toLowerCase().replace(/^www\./, ""),
  };
}

export type Signal = {
  type: string;
  title: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  count: number;
  entity_ids: string[];
};
export type Health = {
  health_status: "HEALTHY" | "WATCH" | "AT_RISK" | "BLOCKED" | "UNKNOWN";
  health_score: number | null;
  confidence: number;
  signals: Signal[];
  completed: number;
  total: number;
  progress: number;
};
export function calculateImplementationHealth(
  input: {
    tasks: Row[];
    milestones: Row[];
    requirements: Row[];
    risks: Row[];
    dependencies: Row[];
  },
  now = new Date(),
  weights = {
    overdue: 3,
    blocked: 5,
    milestone: 8,
    requirement: 2,
    risk: 4,
    dependency: 3,
    deadline: 1,
  },
): Health {
  const tasks = input.tasks.filter((t) => t.status !== "CANCELLED"),
    open = tasks.filter((t) => t.status !== "COMPLETED");
  const day = (value: unknown) =>
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value ?? "").slice(0, 10);
  const today = now.toISOString().slice(0, 10),
    soon = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const signals: Signal[] = [];
  const add = (
    type: string,
    title: string,
    severity: Signal["severity"],
    rows: Row[],
  ) => {
    if (rows.length)
      signals.push({
        type,
        title,
        severity,
        count: rows.length,
        entity_ids: rows.map((r) => r.id),
      });
  };
  add(
    "OVERDUE_TASK",
    "Overdue tasks need an owner update",
    "HIGH",
    open.filter((t) => t.due_date && day(t.due_date) < today),
  );
  add(
    "BLOCKED_TASK",
    "Blocked tasks are holding up delivery",
    "HIGH",
    open.filter((t) => t.status === "BLOCKED"),
  );
  add(
    "MILESTONE_DELAY",
    "Milestone dates have passed",
    "HIGH",
    input.milestones.filter(
      (m) =>
        !["COMPLETED", "CANCELLED"].includes(m.status) &&
        m.target_date &&
        day(m.target_date) < today,
    ),
  );
  add(
    "REQUIREMENT_CHANGE",
    "Changed requirements need review",
    "MEDIUM",
    input.requirements.filter((r) => r.status === "CHANGED"),
  );
  add(
    "OPEN_RISK",
    "High-impact risks remain open",
    "HIGH",
    input.risks.filter(
      (r) =>
        ["OPEN", "MONITORING"].includes(r.status) &&
        ["HIGH", "CRITICAL"].includes(r.severity),
    ),
  );
  const byId = new Map(tasks.map((t) => [t.id, t]));
  add(
    "BLOCKED_DEPENDENCY",
    "Unresolved dependencies need attention",
    "MEDIUM",
    input.dependencies.filter((d) => {
      if (d.dependency_type === "RELATED_TO") return false;
      const dependent = byId.get(
        d.dependency_type === "BLOCKS" ? d.depends_on_task_id : d.task_id,
      );
      const prerequisite = byId.get(
        d.dependency_type === "BLOCKS" ? d.task_id : d.depends_on_task_id,
      );
      return (
        dependent &&
        prerequisite &&
        dependent.status !== "COMPLETED" &&
        prerequisite.status === "BLOCKED"
      );
    }),
  );
  add(
    "UPCOMING_DEADLINE",
    "Upcoming deadlines in the next three days",
    "LOW",
    open.filter(
      (t) => t.due_date && day(t.due_date) >= today && day(t.due_date) <= soon,
    ),
  );
  const w = [
    weights.overdue,
    weights.blocked,
    weights.milestone,
    weights.requirement,
    weights.risk,
    weights.dependency,
    weights.deadline,
  ];
  const kinds = [
    "OVERDUE_TASK",
    "BLOCKED_TASK",
    "MILESTONE_DELAY",
    "REQUIREMENT_CHANGE",
    "OPEN_RISK",
    "BLOCKED_DEPENDENCY",
    "UPCOMING_DEADLINE",
  ];
  const score = Math.max(
    0,
    100 -
      signals.reduce(
        (n, s) => n + Math.min(s.count, 5) * w[kinds.indexOf(s.type)],
        0,
      ),
  );
  const known =
    tasks.length +
      input.risks.length +
      input.requirements.length +
      input.milestones.length >
    0;
  const completed = tasks.length - open.length;
  const coverage =
    [
      tasks.length,
      input.milestones.length,
      input.requirements.length,
      input.risks.length,
    ].filter(Boolean).length * 25;
  return {
    health_status: !known
      ? "UNKNOWN"
      : score < 40
        ? "BLOCKED"
        : score < 70
          ? "AT_RISK"
          : score < 90
            ? "WATCH"
            : "HEALTHY",
    health_score: known ? score : null,
    confidence: known ? coverage : 0,
    signals,
    completed,
    total: tasks.length,
    progress: tasks.length ? Math.round((completed / tasks.length) * 100) : 0,
  };
}
