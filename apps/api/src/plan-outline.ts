import type { PlanDraft, PlanSource } from "../../../packages/domain/plan.ts";

const stageWords = /\b(kickoff|discovery|requirements|solution design|configuration|integration|testing|uat|training|cutover|go-live|go live|handoff)\b/i;
const actionWords = /^(?:task|action)\s*:\s*|^(?:prepare|review|validate|configure|build|test|approve|schedule|deliver|integrate|train|migrate|confirm)\b/i;
const heading = /^(?:#{1,4}\s+|\d{1,2}[.)]\s+|[A-Z][A-Z /&-]{4,80}:?$)/;
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** Conservative, non-AI outline: only explicitly labelled lifecycle headings and actions become records. */
export function buildSourceOutline(implementation: { name: string; description?: string | null }, sources: PlanSource[]): PlanDraft {
  const stages: PlanDraft["stages"] = [];
  const stageKeys = new Set<string>();
  const taskKeys = new Set<string>();
  for (const source of sources) {
    let current: PlanDraft["stages"][number] | null = null;
    for (const raw of source.content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.length > 300) continue;
      const label = line.replace(/^(?:#{1,4}\s+|\d{1,2}[.)]\s+)/, "").replace(/:$/, "").trim();
      if (heading.test(line) && stageWords.test(label) && label.length <= 100) {
        const base = slug(label);
        const existing = stages.find((item) => item.key === base);
        if (existing) { current = existing; continue; }
        if (stageKeys.has(base) || stages.length >= 12) { current = null; continue; }
        stageKeys.add(base);
        current = {
          key: base, name: label, description: "", entry_criteria: "", exit_criteria: "",
          duration_days: null, approval_required: false,
          evidence: [{ source_id: source.id, quote: line.slice(0, 1000) }],
          tasks: [], milestones: [],
        };
        stages.push(current);
        continue;
      }
      if (!current || !/^[-*•]\s+/.test(line)) continue;
      const item = line.replace(/^[-*•]\s+/, "").trim();
      if (item.length < 3 || item.length > 160) continue;
      if (/^(?:milestone|sign-off)\s*:/i.test(item) && current.milestones.length < 8) {
        const name = item.replace(/^(?:milestone|sign-off)\s*:\s*/i, "");
        if (name.length >= 2 && !current.milestones.some((m) => m.name.toLowerCase() === name.toLowerCase()))
          current.milestones.push({ name, description: "", evidence: [{ source_id: source.id, quote: line }] });
      } else if (actionWords.test(item) && current.tasks.length < 12) {
        const title = item.replace(/^(?:task|action)\s*:\s*/i, "");
        const base = slug(`${current.key}-${title}`);
        if (title.length < 2 || taskKeys.has(base)) continue;
        taskKeys.add(base);
        current.tasks.push({ key: base, title, description: "", priority: "MEDIUM", depends_on: [],
          evidence: [{ source_id: source.id, quote: line }] });
      }
    }
  }
  return {
    summary: implementation.description?.trim().slice(0, 5000) || `${implementation.name} — proposed source outline for human review.`,
    stages,
    open_questions: stages.length
      ? ["Confirm stage scope, owners, dates and any dependencies not explicitly stated in the selected sources."]
      : ["Which delivery stages and work items should be added? The selected sources contained no explicit lifecycle headings."],
  };
}
