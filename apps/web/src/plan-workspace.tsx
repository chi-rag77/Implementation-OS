import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, CircleHelp, FileText, GitCompareArrows, Link2, Loader2, Plus, ShieldCheck, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import { api } from "./api";
import type { PlanDraft, PlanSource } from "../../../packages/domain/plan";
import "./plan-workspace.css";

type Proposal = {
  id: string; status: "DRAFT" | "APPROVED" | "REJECTED"; plan: PlanDraft;
  source_snapshots: PlanSource[]; generation_mode: "AI" | "MANUAL_OUTLINE";
  provider_name: string | null; revision: number; edited_by_human: boolean;
  reviewer_note: string; approved_at: string | null; created_at: string;
  applied_entities: { stages: string[]; tasks: string[]; milestones: string[]; dependencies: string[] };
};
type Current = { stages: any[]; tasks: any[]; milestones: any[] };
type ChangeItem = { kind: "Stage" | "Task" | "Milestone"; name: string; action: "ADD" | "REUSE"; stageKey: string };
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function EvidenceEditor({ refs, sources, disabled, onChange, onPreview }: {
  refs: { source_id: string; quote: string }[]; sources: PlanSource[]; disabled: boolean;
  onChange: (refs: { source_id: string; quote: string }[]) => void; onPreview: (id: string) => void;
}) {
  return <details className="plan-evidence">
    <summary><Link2 size={13} /> Evidence <span>{refs.length ? `${refs.length} linked` : "Add a citation or explain human-authored work"}</span><ChevronDown size={13} /></summary>
    <div className="plan-evidence-body">
      {refs.map((ref, index) => {
        const source = sources.find((item) => item.id === ref.source_id);
        return <div className="plan-citation-row" key={index}>
          <div className="plan-citation-top"><select aria-label="Citation source" disabled={disabled} value={ref.source_id} onChange={(event) => onChange(refs.map((item, i) => i === index ? { source_id: event.target.value, quote: "" } : item))}>
            {sources.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select><button type="button" className="plan-text-action" onClick={() => onPreview(ref.source_id)}>View source</button>{!disabled && <button type="button" aria-label="Remove citation" className="plan-icon-action" onClick={() => onChange(refs.filter((_, i) => i !== index))}><X size={14} /></button>}</div>
          <textarea aria-label="Exact source quotation" disabled={disabled} value={ref.quote} maxLength={1000} rows={2} placeholder="Paste an exact excerpt from this source" onChange={(event) => onChange(refs.map((item, i) => i === index ? { ...item, quote: event.target.value } : item))} />
          {ref.quote && source && !source.content.includes(ref.quote) && <small className="plan-invalid">This quote does not exactly match the selected source.</small>}
        </div>;
      })}
      {!disabled && refs.length < 3 && sources.length > 0 && <button type="button" className="plan-text-action" onClick={() => onChange([...refs, { source_id: sources[0].id, quote: "" }])}><Plus size={13} /> Add source quote</button>}
    </div>
  </details>;
}

export function PlanWorkspace({ implementationId, implementationName, canManage, aiConnected, aiProvider, aiPlanModel, onProjectRecordsChanged }: {
  implementationId: string; implementationName: string; canManage: boolean; aiConnected: boolean;
  aiProvider?: string; aiPlanModel?: string; onProjectRecordsChanged: () => void;
}) {
  const [sources, setSources] = useState<PlanSource[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [current, setCurrent] = useState<Current>({ stages: [], tasks: [], milestones: [] });
  const [plan, setPlan] = useState<PlanDraft | null>(null);
  const [note, setNote] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [consent, setConsent] = useState(false);
  const [previewId, setPreviewId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selected = proposals.find((item) => item.id === selectedId) ?? proposals[0] ?? null;
  const snapshotSources = selected?.source_snapshots ?? [];
  const preview = snapshotSources.find((item) => item.id === previewId) ?? sources.find((item) => item.id === previewId);
  const dirty = !!selected && !!plan && (JSON.stringify(plan) !== JSON.stringify(selected.plan) || note !== (selected.reviewer_note ?? ""));

  async function refresh(preserveId?: string) {
    const [available, state] = await Promise.all([
      api<PlanSource[]>(`implementations/${implementationId}/plan/sources`),
      api<{ proposals: Proposal[]; current: Current }>(`implementations/${implementationId}/plan`),
    ]);
    setSources(available);
    setProposals(state.proposals);
    setCurrent(state.current);
    const chosen = state.proposals.find((item) => item.id === preserveId) ?? state.proposals[0] ?? null;
    setSelectedId(chosen?.id ?? "");
    setPlan(chosen ? structuredClone(chosen.plan) : null);
    setNote(chosen?.reviewer_note ?? "");
    setAcknowledge(false);
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    refresh().catch((cause) => { if (active) setError(cause.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [implementationId]);
  function selectProposal(id: string) {
    if (dirty && !window.confirm("Discard unsaved plan edits?")) return;
    const next = proposals.find((item) => item.id === id);
    if (!next) return;
    setSelectedId(id); setPlan(structuredClone(next.plan)); setNote(next.reviewer_note ?? ""); setAcknowledge(false); setError(""); setNotice(""); setPreviewId("");
  }
  async function action(task: () => Promise<unknown>, success: string, id?: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await task();
      await refresh(id ?? (result as Proposal | undefined)?.id ?? selected?.id);
      setNotice(success);
      return result;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This action did not complete."); return null; }
    finally { setBusy(false); }
  }
  async function prepare(mode: "AI" | "MANUAL_OUTLINE") {
    if (!selectedSources.length) { setError("Choose at least one source first."); return; }
    if (mode === "AI" && !consent) { setError("Confirm the provider disclosure before generating with AI."); return; }
    await action(() => api<Proposal>(`implementations/${implementationId}/plan/proposals`, {
      method: "POST", body: JSON.stringify({ source_ids: selectedSources, mode }),
    }), mode === "AI" ? "Cited AI proposal prepared. Review every item before applying." : "Source outline prepared. Add or edit work before applying.");
  }
  async function save() {
    if (!selected || !plan) return;
    await action(() => api<Proposal>(`implementations/${implementationId}/plan/proposals/${selected.id}`, {
      method: "PATCH", body: JSON.stringify({ expected_revision: selected.revision, plan, reviewer_note: note }),
    }), "Draft revision saved.");
  }
  async function approve() {
    if (!selected || dirty) return;
    const result = await action(() => api<Proposal>(`implementations/${implementationId}/plan/proposals/${selected.id}/approve`, {
      method: "POST", body: JSON.stringify({ acknowledge_open_questions: acknowledge }),
    }), "Plan approved. Missing stages, tasks, milestones and dependencies were added to the project.");
    if (result) onProjectRecordsChanged();
  }
  async function reject() {
    if (!selected || dirty || note.trim().length < 3) { setError("Save your edits and provide a reason before rejecting."); return; }
    await action(() => api<Proposal>(`implementations/${implementationId}/plan/proposals/${selected.id}/reject`, {
      method: "POST", body: JSON.stringify({ expected_revision: selected.revision, reason: note.trim() }),
    }), "Proposal rejected. Project records were not changed.");
  }
  const totals = useMemo(() => {
    if (!plan) return { stages: 0, tasks: 0, milestones: 0, already: 0, items: [] as ChangeItem[] };
    let already = 0;
    const items: ChangeItem[] = [];
    for (const stage of plan.stages) {
      const match = current.stages.find((item) => item.key === stage.key);
      if (match) already++;
      items.push({ kind: "Stage", name: stage.name, action: match ? "REUSE" : "ADD", stageKey: stage.key });
      for (const work of stage.tasks) {
        const exists = current.tasks.some((item) => item.stage_id === match?.id && item.title?.toLowerCase() === work.title.toLowerCase());
        if (exists) already++;
        items.push({ kind: "Task", name: work.title, action: exists ? "REUSE" : "ADD", stageKey: stage.key });
      }
      for (const milestone of stage.milestones) {
        const exists = current.milestones.some((item) => item.name?.toLowerCase() === milestone.name.toLowerCase());
        if (exists) already++;
        items.push({ kind: "Milestone", name: milestone.name, action: exists ? "REUSE" : "ADD", stageKey: stage.key });
      }
    }
    return { stages: plan.stages.length, tasks: plan.stages.reduce((sum, stage) => sum + stage.tasks.length, 0), milestones: plan.stages.reduce((sum, stage) => sum + stage.milestones.length, 0), already, items };
  }, [plan, current]);
  const editable = canManage && selected?.status === "DRAFT" && !busy;
  const setStage = (index: number, change: Partial<PlanDraft["stages"][number]>) => setPlan((old) => old && ({ ...old, stages: old.stages.map((item, i) => i === index ? { ...item, ...change } : item) }));

  if (loading) return <div className="plan-loading" role="status"><Loader2 className="spin" size={20} /> Loading plan workspace…</div>;
  return <div className="plan-workspace">
    <header className="plan-hero"><div><span className="plan-eyebrow"><GitCompareArrows size={13} /> EVIDENCE → EXECUTION</span><h2>Implementation plan</h2><p>Turn source material into a proposal your team can inspect, edit and approve.</p></div><div className="plan-hero-state"><ShieldCheck size={16} /><span>Human approval required<br /><small>No project record changes during preparation</small></span></div></header>
    <div className="plan-steps"><span className="done"><b>1</b> Select sources</span><ArrowRight size={15} /><span className={selected ? "done" : ""}><b>2</b> Prepare a proposal</span><ArrowRight size={15} /><span className={selected?.status === "APPROVED" ? "done" : ""}><b>3</b> Review & apply</span></div>
    {error && <div className="plan-alert error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}><X size={15} /></button></div>}
    {notice && <div className="plan-alert success" role="status"><CheckCircle2 size={16} />{notice}<button aria-label="Dismiss notice" onClick={() => setNotice("")}><X size={15} /></button></div>}
    <div className="plan-grid"><main className="plan-main">
      <section className="plan-section"><div className="plan-section-head"><div><span className="plan-section-kicker">01 · SOURCE PACKAGE</span><h3>What should shape this plan?</h3><p>Choose up to six library items or documents from {implementationName}. Each selected text snapshot stays with the proposal.</p></div><span className="plan-count">{selectedSources.length}/6 selected</span></div>
        {sources.length ? <div className="plan-source-list">{sources.map((source) => <label className={`plan-source ${selectedSources.includes(source.id) ? "selected" : ""}`} key={source.id}>
          <input type="checkbox" checked={selectedSources.includes(source.id)} disabled={!canManage || busy || (!selectedSources.includes(source.id) && selectedSources.length >= 6)} onChange={() => setSelectedSources((old) => old.includes(source.id) ? old.filter((id) => id !== source.id) : [...old, source.id])} />
          <span className="plan-source-icon">{source.kind === "DOCUMENT" ? <FileText size={16} /> : <BookOpen size={16} />}</span><span className="plan-source-name"><strong>{source.title}</strong><small>{source.kind === "DOCUMENT" ? "Project document" : "Organization library"} · {source.status.toLowerCase()}{source.version ? ` · v${source.version}` : ""}</small></span>
          <button type="button" className="plan-text-action" onClick={(event) => { event.preventDefault(); setPreviewId(source.id); }}>Preview</button>
        </label>)}</div> : <div className="plan-empty"><FileText size={20} /><strong>No readable sources yet</strong><p>Import project documents in the Documents tab or add files in Workspace settings → Implementation intelligence.</p></div>}
        {canManage && <div className="plan-prepare"><div><button className="button" disabled={busy || !selectedSources.length} onClick={() => prepare("MANUAL_OUTLINE")}><FileText size={15} /> Prepare source outline</button><span>Uses only explicit headings and action lines; no AI call.</span></div><div className="plan-ai-action"><label className="plan-consent"><input type="checkbox" checked={consent} disabled={!aiConnected || busy} onChange={(event) => setConsent(event.target.checked)} /> On request, selected excerpts will be sent to {aiProvider ?? "the configured AI provider"}{aiPlanModel ? ` (${aiPlanModel})` : ""}. Review its data terms.</label><button className="button primary" disabled={busy || !aiConnected || !selectedSources.length || !consent} onClick={() => prepare("AI")}>{busy ? <Loader2 size={15} className="spin" /> : <WandSparkles size={15} />} Generate cited plan</button>{!aiConnected && <small>AI provider not connected. Source outline and manual review remain available.</small>}</div></div>}
      </section>
      <section className="plan-section"><div className="plan-section-head"><div><span className="plan-section-kicker">02 · REVIEW THE PROPOSAL</span><h3>Plan studio</h3><p>Every suggested item should have a source. Human additions need a review note.</p></div>{proposals.length > 0 && <select className="plan-proposal-select" aria-label="Select proposal" value={selected?.id} onChange={(event) => selectProposal(event.target.value)}>{proposals.map((item) => <option key={item.id} value={item.id}>{date(item.created_at)} · {item.generation_mode === "AI" ? "AI draft" : "Source outline"} · {item.status.toLowerCase()} · r{item.revision}</option>)}</select>}</div>
        {!selected || !plan ? <div className="plan-empty"><Sparkles size={21} /><strong>No proposal yet</strong><p>Select source documents above, then prepare an outline or generate a cited plan.</p></div> : <>
          <div className="plan-proposal-meta"><span className={`plan-status ${selected.status.toLowerCase()}`}>{selected.status === "DRAFT" ? "Needs review" : selected.status.toLowerCase()}</span><span>{selected.generation_mode === "AI" ? `${selected.provider_name ?? "AI"} proposal` : "Source-only outline"}</span><span>Revision {selected.revision}</span><span>{snapshotSources.length} frozen sources</span></div>
          <label className="plan-field">Scope summary<textarea rows={3} maxLength={5000} disabled={!editable} value={plan.summary} onChange={(event) => setPlan({ ...plan, summary: event.target.value })} /></label>
          <div className="plan-stage-heading"><h4>Delivery stages <span>{plan.stages.length}</span></h4>{editable && plan.stages.length < 12 && <button className="plan-text-action" onClick={() => setPlan({ ...plan, stages: [...plan.stages, { key: uid("stage"), name: "New stage", description: "", entry_criteria: "", exit_criteria: "", duration_days: null, approval_required: false, evidence: [], tasks: [], milestones: [] }] })}><Plus size={14} /> Add stage</button>}</div>
          {!plan.stages.length && <div className="plan-empty compact"><CircleHelp size={18} /><strong>No explicit stages found</strong><p>Add a stage yourself and link a source quote, or generate with AI when connected.</p></div>}
          {plan.stages.map((stage, index) => <details className="plan-stage" key={stage.key}><summary><span className="plan-stage-index">{String(index + 1).padStart(2, "0")}</span><span><strong>{stage.name}</strong><small>{stage.tasks.length} tasks · {stage.milestones.length} milestones · {stage.evidence.length} citations</small></span><span className="plan-stage-diff">{current.stages.some((item) => item.key === stage.key) ? "Stage exists" : "+ New stage"}</span><ChevronDown size={17} /></summary><div className="plan-stage-body">
            <div className="plan-fields-two"><label className="plan-field">Stage name<input disabled={!editable} maxLength={160} value={stage.name} onChange={(event) => setStage(index, { name: event.target.value })} /></label><label className="plan-field">Stable stage key<input disabled maxLength={60} value={stage.key} /></label></div>
            <label className="plan-field">Purpose<textarea disabled={!editable} maxLength={2000} rows={2} value={stage.description} onChange={(event) => setStage(index, { description: event.target.value })} /></label>
            <div className="plan-fields-two"><label className="plan-field">Entry criteria<input disabled={!editable} maxLength={2000} value={stage.entry_criteria} onChange={(event) => setStage(index, { entry_criteria: event.target.value })} /></label><label className="plan-field">Exit criteria<input disabled={!editable} maxLength={2000} value={stage.exit_criteria} onChange={(event) => setStage(index, { exit_criteria: event.target.value })} /></label></div>
            <div className="plan-stage-options"><label>Duration (days) <input type="number" min={1} max={365} disabled={!editable} value={stage.duration_days ?? ""} onChange={(event) => setStage(index, { duration_days: event.target.value ? Number(event.target.value) : null })} /></label><label><input type="checkbox" disabled={!editable} checked={stage.approval_required} onChange={(event) => setStage(index, { approval_required: event.target.checked })} /> Approval gate</label>{editable && <button className="plan-text-action destructive" onClick={() => setPlan({ ...plan, stages: plan.stages.filter((_, i) => i !== index) })}><Trash2 size={13} /> Remove stage</button>}</div>
            <EvidenceEditor refs={stage.evidence} sources={snapshotSources} disabled={!editable} onPreview={setPreviewId} onChange={(evidence) => setStage(index, { evidence })} />
            <div className="plan-subheading"><strong>Tasks</strong>{editable && stage.tasks.length < 12 && <button className="plan-text-action" onClick={() => setStage(index, { tasks: [...stage.tasks, { key: uid("task"), title: "New task", description: "", priority: "MEDIUM", depends_on: [], evidence: [] }] })}><Plus size={13} /> Add task</button>}</div>
            {stage.tasks.map((work, taskIndex) => { const update = (change: Partial<typeof work>) => setStage(index, { tasks: stage.tasks.map((item, i) => i === taskIndex ? { ...item, ...change } : item) }); return <div className="plan-work-item" key={work.key}><div className="plan-work-item-top"><span className="plan-work-dot" /><input aria-label="Task title" disabled={!editable} maxLength={160} value={work.title} onChange={(event) => update({ title: event.target.value })} /><select aria-label="Task priority" disabled={!editable} value={work.priority} onChange={(event) => update({ priority: event.target.value as typeof work.priority })}>{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((priority) => <option key={priority}>{priority}</option>)}</select>{editable && <button aria-label="Remove task" className="plan-icon-action" onClick={() => setStage(index, { tasks: stage.tasks.filter((_, i) => i !== taskIndex) })}><X size={14} /></button>}</div><textarea aria-label="Task description" disabled={!editable} maxLength={2000} rows={2} value={work.description} placeholder="Describe the deliverable or acceptance outcome" onChange={(event) => update({ description: event.target.value })} />
              <div className="plan-dependencies"><span>Blocked by</span>{work.depends_on.map((key) => <span className="plan-dependency" key={key}>{plan.stages.flatMap((item) => item.tasks).find((item) => item.key === key)?.title ?? key}{editable && <button aria-label={`Remove dependency ${key}`} onClick={() => update({ depends_on: work.depends_on.filter((item) => item !== key) })}><X size={11} /></button>}</span>)}{editable && <select aria-label="Add task dependency" value="" onChange={(event) => event.target.value && update({ depends_on: [...work.depends_on, event.target.value] })}><option value="">+ Dependency</option>{plan.stages.flatMap((item) => item.tasks).filter((item) => item.key !== work.key && !work.depends_on.includes(item.key)).map((item) => <option key={item.key} value={item.key}>{item.title}</option>)}</select>}</div>
              <EvidenceEditor refs={work.evidence} sources={snapshotSources} disabled={!editable} onPreview={setPreviewId} onChange={(evidence) => update({ evidence })} /></div>; })}
            <div className="plan-subheading"><strong>Milestones</strong>{editable && stage.milestones.length < 8 && <button className="plan-text-action" onClick={() => setStage(index, { milestones: [...stage.milestones, { name: "New milestone", description: "", evidence: [] }] })}><Plus size={13} /> Add milestone</button>}</div>
            {stage.milestones.map((milestone, milestoneIndex) => { const update = (change: Partial<typeof milestone>) => setStage(index, { milestones: stage.milestones.map((item, i) => i === milestoneIndex ? { ...item, ...change } : item) }); return <div className="plan-work-item milestone" key={milestoneIndex}><div className="plan-work-item-top"><CheckCircle2 size={15} /><input aria-label="Milestone name" disabled={!editable} maxLength={160} value={milestone.name} onChange={(event) => update({ name: event.target.value })} />{editable && <button aria-label="Remove milestone" className="plan-icon-action" onClick={() => setStage(index, { milestones: stage.milestones.filter((_, i) => i !== milestoneIndex) })}><X size={14} /></button>}</div><textarea aria-label="Milestone description" disabled={!editable} maxLength={2000} rows={2} value={milestone.description} onChange={(event) => update({ description: event.target.value })} /><EvidenceEditor refs={milestone.evidence} sources={snapshotSources} disabled={!editable} onPreview={setPreviewId} onChange={(evidence) => update({ evidence })} /></div>; })}
          </div></details>)}
          <div className="plan-questions"><div className="plan-subheading"><strong>Open questions <span>{plan.open_questions.length}</span></strong>{editable && <button className="plan-text-action" onClick={() => setPlan({ ...plan, open_questions: [...plan.open_questions, "What needs confirmation?"] })}><Plus size={13} /> Add question</button>}</div>{plan.open_questions.map((question, index) => <div className="plan-question" key={index}><CircleHelp size={16} /><input aria-label={`Open question ${index + 1}`} disabled={!editable} maxLength={500} value={question} onChange={(event) => setPlan({ ...plan, open_questions: plan.open_questions.map((item, i) => i === index ? event.target.value : item) })} />{editable && <button className="plan-icon-action" aria-label="Remove question" onClick={() => setPlan({ ...plan, open_questions: plan.open_questions.filter((_, i) => i !== index) })}><X size={14} /></button>}</div>)}</div>
        </>}
      </section>
    </main><aside className="plan-side">
      <section className="plan-side-card"><div className="plan-side-heading"><GitCompareArrows size={17} /><strong>Change preview</strong></div>{plan ? <><p>Estimated against current project records. Approval adds missing items; it never replaces or deletes existing work.</p><div className="plan-diff-stats"><div><strong>{totals.stages}</strong><span>Stages in proposal</span></div><div><strong>{totals.tasks}</strong><span>Tasks in proposal</span></div><div><strong>{totals.milestones}</strong><span>Milestones in proposal</span></div></div><div className="plan-diff-note"><Check size={14} /> {totals.already} matching item{totals.already === 1 ? "" : "s"} will be reused; {totals.items.length - totals.already} will be added.</div><div className="plan-diff-list">{totals.items.map((item, index) => <div className={`plan-diff-item ${item.kind !== "Stage" ? "nested" : ""}`} key={`${item.stageKey}-${item.kind}-${index}`}><span className={item.action.toLowerCase()}>{item.action}</span><strong>{item.name}</strong><small>{item.kind}</small></div>)}</div><small className="plan-diff-caveat">Dependency links are checked and added during approval. Refresh before applying to compare with the latest records.</small></> : <p>Prepare a proposal to compare it with current project records.</p>}</section>
      {selected && <section className="plan-side-card plan-review"><div className="plan-side-heading"><ShieldCheck size={17} /><strong>Review gate</strong></div>{selected.status === "DRAFT" ? <><p>Saving and approving are separate actions. No external messages will be sent.</p><label className="plan-field">Reviewer note<textarea rows={3} maxLength={2000} disabled={!canManage || busy} value={note} placeholder="Record changes, assumptions and approval context" onChange={(event) => setNote(event.target.value)} /></label>{!!plan?.open_questions.length && <label className="plan-ack"><input type="checkbox" checked={acknowledge} disabled={!canManage || busy} onChange={(event) => setAcknowledge(event.target.checked)} /> I reviewed the {plan.open_questions.length} open question{plan.open_questions.length === 1 ? "" : "s"}; they remain visible after approval.</label>}{canManage && <div className="plan-review-actions"><button className="button" disabled={busy || !dirty} onClick={save}>{busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />} Save revision</button><button className="button primary" disabled={busy || dirty || !plan?.stages.length || (!!plan.open_questions.length && !acknowledge) || (selected.edited_by_human && note.trim().length < 3)} onClick={approve}>Approve & apply <ArrowRight size={14} /></button><button className="plan-text-action destructive" disabled={busy || dirty || note.trim().length < 3} onClick={reject}>Reject proposal</button></div>}{dirty && <small className="plan-unsaved">Save this revision before approval.</small>}</> : <div className="plan-reviewed"><CheckCircle2 size={19} /><strong>{selected.status === "APPROVED" ? "Applied to delivery records" : "Proposal rejected"}</strong><span>{selected.status === "APPROVED" ? `Approved ${selected.approved_at ? date(selected.approved_at) : ""}` : selected.reviewer_note || "No changes applied"}</span></div>}</section>}
      {preview && <section className="plan-side-card plan-source-preview"><div className="plan-side-heading"><FileText size={17} /><strong>Source snapshot</strong><button className="plan-icon-action" aria-label="Close source preview" onClick={() => setPreviewId("")}><X size={15} /></button></div><p>{preview.title} · {preview.kind === "DOCUMENT" ? "Project document" : "Library item"}</p><pre>{preview.content}</pre><small>Only this captured text is cited in the proposal.</small></section>}
    </aside></div>
  </div>;
}
