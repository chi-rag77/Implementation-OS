import { z } from "zod";

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/);
const evidence = z.object({
  source_id: z.uuid(),
  quote: z.string().trim().min(3).max(1000),
}).strict();
const evidenceList = z.array(evidence).max(3);
const task = z.object({
  key,
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  depends_on: z.array(key).max(8),
  evidence: evidenceList,
}).strict();
const milestone = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000),
  evidence: evidenceList,
}).strict();
const stage = z.object({
  key,
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(2000),
  entry_criteria: z.string().trim().max(2000),
  exit_criteria: z.string().trim().max(2000),
  duration_days: z.number().int().min(1).max(365).nullable(),
  approval_required: z.boolean(),
  evidence: evidenceList,
  tasks: z.array(task).max(12),
  milestones: z.array(milestone).max(8),
}).strict();
export const planDraftSchema = z.object({
  summary: z.string().trim().max(5000),
  stages: z.array(stage).max(12),
  open_questions: z.array(z.string().trim().min(3).max(500)).max(30),
}).strict().superRefine((plan, ctx) => {
  const stageKeys = new Set<string>();
  const taskKeys = new Set<string>();
  for (const [i, item] of plan.stages.entries()) {
    if (stageKeys.has(item.key)) ctx.addIssue({ code: "custom", path: ["stages", i, "key"], message: "Stage keys must be unique." });
    stageKeys.add(item.key);
    for (const [j, work] of item.tasks.entries()) {
      if (taskKeys.has(work.key)) ctx.addIssue({ code: "custom", path: ["stages", i, "tasks", j, "key"], message: "Task keys must be unique." });
      taskKeys.add(work.key);
    }
  }
  for (const [i, item] of plan.stages.entries()) for (const [j, work] of item.tasks.entries()) {
    for (const dependency of work.depends_on) if (!taskKeys.has(dependency) || dependency === work.key)
      ctx.addIssue({ code: "custom", path: ["stages", i, "tasks", j, "depends_on"], message: "A dependency must refer to another task in this plan." });
  }
  const graph = new Map(plan.stages.flatMap((item) => item.tasks).map((item) => [item.key, item.depends_on]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const cyclic = (item: string): boolean => {
    if (visiting.has(item)) return true;
    if (visited.has(item)) return false;
    visiting.add(item);
    for (const dependency of graph.get(item) ?? []) if (cyclic(dependency)) return true;
    visiting.delete(item); visited.add(item);
    return false;
  };
  if ([...graph.keys()].some(cyclic)) ctx.addIssue({ code: "custom", path: ["stages"], message: "Task dependencies cannot form a cycle." });
  if (taskKeys.size > 60) ctx.addIssue({ code: "custom", path: ["stages"], message: "A proposal can contain up to 60 tasks." });
});
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type PlanSource = { id: string; kind: "LIBRARY" | "DOCUMENT"; title: string; content: string; status: string; version: number | null };

// Keep provider requests bounded while retaining the complete selected source in
// the proposal snapshot. Citations are always checked against that full source.
export function excerptPlanSources(sources: PlanSource[]): PlanSource[] {
  const budget = Math.min(6000, Math.floor(18_000 / Math.max(1, sources.length)));
  const relevant = /\b(scope|requirement|deliverable|milestone|sign.?off|approval|dependency|integration|uat|test|training|cutover|go.?live|action|decision|risk|owner|deadline|date)\b/i;
  return sources.map((source) => {
    if (source.content.length <= budget) return source;
    const chunks = source.content.match(/[\s\S]{1,900}/g) ?? [];
    const chosen = new Set<number>([0, chunks.length - 1]);
    const ranked = chunks.map((content, index) => ({
      index,
      score: (content.match(new RegExp(relevant.source, "gi")) ?? []).length,
    })).sort((a, b) => b.score - a.score || a.index - b.index);
    for (const item of ranked) {
      const next = [...chosen, item.index].sort((a, b) => a - b)
        .map((index) => chunks[index]).join("\n[omitted source text]\n");
      if (next.length <= budget) chosen.add(item.index);
    }
    return { ...source, content: [...chosen].sort((a, b) => a - b)
      .map((index) => chunks[index]).join("\n[omitted source text]\n") };
  });
}

export function verifyPlanEvidence(plan: PlanDraft, sources: PlanSource[], requireEvidence: boolean): string[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const problems: string[] = [];
  const check = (label: string, refs: PlanDraft["stages"][number]["evidence"]) => {
    if (requireEvidence && !refs.length) problems.push(`${label} has no source citation.`);
    for (const ref of refs) {
      const source = byId.get(ref.source_id);
      if (!source || !source.content.includes(ref.quote)) problems.push(`${label} cites text not found in its selected source.`);
    }
  };
  for (const stage of plan.stages) {
    check(`Stage “${stage.name}”`, stage.evidence);
    for (const work of stage.tasks) check(`Task “${work.title}”`, work.evidence);
    for (const item of stage.milestones) check(`Milestone “${item.name}”`, item.evidence);
  }
  return problems;
}

export const planOutputJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["summary", "stages", "open_questions"],
  properties: {
    summary: { type: "string" },
    open_questions: { type: "array", items: { type: "string" } },
    stages: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["key", "name", "description", "entry_criteria", "exit_criteria", "duration_days", "approval_required", "evidence", "tasks", "milestones"],
      properties: {
        key: { type: "string" }, name: { type: "string" }, description: { type: "string" },
        entry_criteria: { type: "string" }, exit_criteria: { type: "string" },
        duration_days: { type: ["integer", "null"] }, approval_required: { type: "boolean" },
        evidence: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["source_id", "quote"], properties: { source_id: { type: "string" }, quote: { type: "string" } } } },
        tasks: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["key", "title", "description", "priority", "depends_on", "evidence"],
          properties: { key: { type: "string" }, title: { type: "string" }, description: { type: "string" },
            priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
            depends_on: { type: "array", items: { type: "string" } },
            evidence: { type: "array", items: { type: "object", additionalProperties: false,
              required: ["source_id", "quote"], properties: { source_id: { type: "string" }, quote: { type: "string" } } } },
          } } },
        milestones: { type: "array", items: { type: "object", additionalProperties: false,
          required: ["name", "description", "evidence"], properties: { name: { type: "string" }, description: { type: "string" },
            evidence: { type: "array", items: { type: "object", additionalProperties: false,
              required: ["source_id", "quote"], properties: { source_id: { type: "string" }, quote: { type: "string" } } } },
          } } },
      } } },
  },
} as const;
