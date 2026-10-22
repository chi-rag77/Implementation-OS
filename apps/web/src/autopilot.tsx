import React, { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  AlertCircle, ArrowRight, AudioLines, Check, CheckCircle2, CircleHelp,
  Clock3, FileText, Link2, Loader2, LockKeyhole, MessageSquareText,
  Play, ShieldCheck, Sparkles, Upload, Video, WandSparkles,
} from "lucide-react";
import { api } from "./api";
import { extractImportFile, IMPORT_ACCEPT, IMPORT_FORMATS, titleFromImport } from "./import-file";

type Row = Record<string, any>;
type Props = {
  implementation: Row;
  canWrite: boolean;
  canManage: boolean;
  aiConnected: boolean;
  aiProvider?: string;
  onOpenDocuments: (documentId: string) => void;
  onProjectRecordsChanged: () => void;
};
const steps = ["Project context", "Meeting capture", "Drafting", "Human review", "Delivery records"];
const statusLabel = (value?: string) => (value ?? "READY").replaceAll("_", " ").toLowerCase().replace(/^./, (s) => s.toUpperCase());
const failureLabel: Record<string, string> = {
  AI_PROVIDER_TIMEOUT: "Provider timed out",
  AI_PROVIDER_RATE_LIMITED: "Provider busy",
  AI_PROVIDER_UNAVAILABLE: "Provider unavailable",
  AI_PROVIDER_REJECTED: "Provider rejected request",
  AI_RESPONSE_INCOMPLETE: "Draft incomplete",
  AI_RESPONSE_INVALID: "Draft unreadable",
  AI_OUTPUT_INVALID: "Draft format invalid",
};
const formatTimestamp = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

export function Autopilot({ implementation, canWrite, canManage, aiConnected, aiProvider, onOpenDocuments, onProjectRecordsChanged }: Props) {
  const [runs, setRuns] = useState<Row[]>([]);
  const [activeId, setActiveId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("Kickoff / discovery call");
  const [transcript, setTranscript] = useState("");
  const [providers, setProviders] = useState<Row | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = runs.find((run) => run.id === activeId) ?? runs[0] ?? null;

  async function load(preferCurrent = true) {
    const [nextRuns, nextProviders] = await Promise.all([
      api<Row[]>(`autopilot?implementation_id=${encodeURIComponent(implementation.id)}`),
      api<Row>("autopilot/providers"),
    ]);
    setRuns(nextRuns);
    setProviders(nextProviders);
    const nextActive = nextRuns.find((run) => preferCurrent && run.id === activeId) ?? nextRuns[0];
    setActiveId(nextActive?.id ?? "");
  }
  useEffect(() => {
    let mounted = true;
    Promise.all([
      api<Row[]>(`autopilot?implementation_id=${encodeURIComponent(implementation.id)}`),
      api<Row>("autopilot/providers"),
    ]).then(([nextRuns, nextProviders]) => {
      if (!mounted) return;
      setRuns(nextRuns); setProviders(nextProviders);
      setActiveId((current) => nextRuns.some((run) => run.id === current) ? current : nextRuns[0]?.id ?? "");
    }).catch((e) => mounted && setError(e.message));
    return () => { mounted = false; };
  }, [implementation.id]);

  async function act(label: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await load(); if (label) setNotice(label); return true; }
    catch (e: any) { setError(e.message); await load().catch(() => undefined); return false; }
    finally { setBusy(false); }
  }
  async function start() {
    setBusy(true); setError(""); setNotice("");
    try {
      const run = await api<Row>("autopilot/runs", { method: "POST", body: JSON.stringify({ implementation_id: implementation.id }) });
      setActiveId(run.id); await load(false); setActiveId(run.id);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function importTranscript() {
    if (!active || !transcript.trim()) return;
    await act("Transcript imported and attached to this workflow.", async () => {
      await api(`autopilot/runs/${active.id}/transcripts`, { method: "POST", body: JSON.stringify({ title: meetingTitle.trim() || "Imported meeting transcript", content: transcript }) });
      setTranscript("");
    });
  }
  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try { setMeetingTitle(titleFromImport(file.name)); setTranscript(await extractImportFile(file, { format: "text", maxChars: 100_000 })); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : `This file could not be read. Supported: ${IMPORT_FORMATS}.`); }
  }
  async function decision(proposal: Row, value: "APPROVED" | "REJECTED") {
    const succeeded = await act(value === "APPROVED" ? "Approved. Supported delivery records are now linked to this meeting evidence." : "Proposal rejected and recorded.", async () => {
      await api(`autopilot/proposals/${proposal.id}/decision`, { method: "POST", body: JSON.stringify({ decision: value }) });
    });
    if (succeeded && value === "APPROVED") onProjectRecordsChanged();
  }
  const stepIndex = active ? active.current_step === "COMPLETE" ? steps.length : Math.max(0, steps.findIndex((s) => s.toUpperCase().replaceAll(" ", "_") === active.current_step)) : 0;
  const approvedDocs = Boolean(active?.storyboard?.status === "APPROVED" && active?.brd?.status === "APPROVED");
  const draftsReady = Boolean(active?.status === "WAITING_APPROVAL" && active.storyboard && active.brd);
  const unresolved = (active?.proposals ?? []).some((p: Row) => p.status === "PROPOSED");

  return <div className="autopilot-page">
    <header className="autopilot-heading">
      <div>
        <div className="eyebrow">IMPLEMENTATION WORKFLOW</div>
        <h2>Implementation Autopilot</h2>
        <p>Prepare kickoff and discovery work from project context and meeting evidence. You stay in control of every decision.</p>
      </div>
      {runs.length > 1 && <label className="autopilot-run-select">Workflow<select value={active?.id ?? ""} onChange={(e) => setActiveId(e.target.value)}>{runs.map((run) => <option key={run.id} value={run.id}>{statusLabel(run.status)} · {new Date(run.created_at).toLocaleDateString()}</option>)}</select></label>}
    </header>

    {error && <div className="autopilot-alert error" role="alert"><AlertCircle size={16} />{error}</div>}
    {notice && <div className="autopilot-alert success" role="status"><CheckCircle2 size={16} />{notice}</div>}

    {!active ? <section className="autopilot-start">
      <span className="autopilot-icon"><WandSparkles size={22} /></span>
      <div><h3>Start with the customer context you already have</h3><p>Create a resumable kickoff-to-BRD workflow for <strong>{implementation.name}</strong>. It will not change project records until a manager approves proposals.</p></div>
      <button className="button primary" disabled={!canWrite || busy} onClick={start}>{busy ? <Loader2 className="spin" size={16} /> : <Play size={15} />}Start workflow</button>
    </section> : <>
      <section className="autopilot-progress">
        <div className="autopilot-progress-top"><div><span className="eyebrow">KICKOFF → BRD</span><strong>{statusLabel(active.status)}</strong></div><div className="autopilot-run-controls"><span className={`autopilot-run-status ${active.status.toLowerCase()}`}><i />{active.last_error_code ? failureLabel[active.last_error_code] ?? statusLabel(active.last_error_code) : statusLabel(active.current_step)}</span>{["FAILED", "IN_PROGRESS"].includes(active.status) && <button className="text-button" disabled={busy} onClick={() => act("Workflow resumed. Your inputs and previous drafts are preserved.", async () => { await api(`autopilot/runs/${active.id}/resume`, { method: "POST", body: "{}" }); })}><Play size={13} />Resume</button>}{canManage && !["COMPLETED", "CANCELLED"].includes(active.status) && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm("Cancel this workflow? Imported transcripts and saved drafts will be kept.")) void act("Workflow cancelled. Imported evidence and drafts were preserved.", async () => { await api(`autopilot/runs/${active.id}/cancel`, { method: "POST", body: "{}" }); }); }}>Cancel workflow</button>}</div></div>
        <div className="autopilot-steps">{steps.map((step, index) => <div key={step} className={`autopilot-step ${index < stepIndex ? "complete" : index === stepIndex ? "current" : ""}`}><span>{index < stepIndex ? <Check size={13} /> : index + 1}</span><small>{step}</small></div>)}</div>
      </section>

      <div className="autopilot-grid">
        <div className="autopilot-main-column">
          <section className="autopilot-section">
            <div className="autopilot-section-heading"><div className="autopilot-icon cyan"><MessageSquareText size={18} /></div><div><h3>Capture the conversation</h3><p>Import an approved transcript or connect live meeting capture when available.</p></div></div>
            <div className="autopilot-meet-provider"><span className="provider-logo"><Video size={17} /></span><div><strong>Google Meet</strong><small>{providers?.google_meet?.message ?? "Checking connector status…"}</small></div><span className="connector-status"><i />Not connected</span></div>
            <div className="autopilot-import"><div className="autopilot-import-head"><strong>Import transcript</strong><button className="button" disabled={!canWrite || busy} onClick={() => fileRef.current?.click()}><Upload size={14} />Import file</button><input ref={fileRef} type="file" accept={IMPORT_ACCEPT} hidden onChange={readFile} /></div>
              <label className="autopilot-field">Meeting name<input value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} maxLength={160} /></label>
              <label className="autopilot-field">Transcript<textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} maxLength={100000} rows={5} placeholder="Paste timestamped notes, speaker-labelled transcript text, or WebVTT captions…" /></label>
              <div className="autopilot-import-foot"><small>{IMPORT_FORMATS} · files up to 10 MB and 100,000 extracted characters. Content stays in this workspace until you request AI drafting.</small><button className="button primary" disabled={!canWrite || busy || transcript.trim().length < 20} onClick={importTranscript}>{busy ? <Loader2 className="spin" size={15} /> : <AudioLines size={15} />}Import transcript</button></div>
            </div>
            {!!active.source_meetings?.length && <div className="autopilot-source-list"><strong>Attached meeting evidence</strong>{active.source_meetings.map((meeting: Row) => <div key={meeting.id}><span><CheckCircle2 size={15} />{meeting.title}</span><small>{meeting.segment_count} transcript segments</small></div>)}</div>}
          </section>

          <section className="autopilot-section">
            <div className="autopilot-section-heading"><div className="autopilot-icon"><Sparkles size={18} /></div><div><h3>Prepare the kickoff and requirements drafts</h3><p>Generate a kickoff storyboard and a BRD in the existing Nexus format.</p></div></div>
            {!aiConnected && <div className="autopilot-ai-notice"><LockKeyhole size={16} /><div><strong>AI provider not connected</strong><p>Workflow and imported evidence are saved. Configure the server-side AI provider in the local environment and restart to enable evidence analysis and draft generation. No project data has been sent.</p></div></div>}
            {aiConnected && <div className="autopilot-data-disclosure"><ShieldCheck size={15} />On request, project scope, delivery records, and attached transcript segments will be sent to <strong>{aiProvider ?? "the configured AI provider"}</strong>. Review the provider’s data terms before continuing.</div>}
            <button className="button" disabled={!canWrite || busy || draftsReady || ["COMPLETED", "CANCELLED"].includes(active.status)} onClick={() => act("Editable storyboard and BRD templates prepared. Transcript excerpts are included verbatim and have not been analyzed.", async () => { await api(`autopilot/runs/${active.id}/prepare-templates`, { method: "POST", body: "{}" }); })}>{busy ? <Loader2 className="spin" size={15} /> : <FileText size={15} />}Prepare structured templates from project records</button>
            <button className="button primary" disabled={!canWrite || busy || draftsReady || !aiConnected || ["COMPLETED", "CANCELLED"].includes(active.status)} onClick={() => act("Storyboard and BRD drafts are ready for review.", async () => { await api(`autopilot/runs/${active.id}/generate`, { method: "POST", body: "{}" }); })}>{busy ? <Loader2 className="spin" size={15} /> : draftsReady ? <Check size={15} /> : <Sparkles size={15} />}{draftsReady ? "Drafts ready for review" : active.status === "FAILED" ? "Retry draft preparation" : "Generate storyboard + BRD"}{!draftsReady && <ArrowRight size={14} />}</button>
            {active.status === "FAILED" && active.last_error_code && <p className="autopilot-retry-note">Your transcript and saved drafts are preserved. {active.storyboard || active.brd ? "Retry will generate only the missing draft." : "Retry when the provider is available, or prepare editable templates without AI."}</p>}
          </section>

          <section className="autopilot-section">
            <div className="autopilot-section-heading"><div className="autopilot-icon"><FileText size={18} /></div><div><h3>Drafts and approvals</h3><p>Open each artifact in this implementation’s Documents tab to edit, compare versions, and submit for review.</p></div></div>
            <div className="autopilot-artifacts">
              {[{ label: "Kickoff storyboard", doc: active.storyboard }, { label: "Business requirements", doc: active.brd }].map(({ label, doc }) => <div className="autopilot-artifact" key={label}><span className="artifact-icon"><FileText size={16} /></span><div><strong>{doc?.name ?? label}</strong><small>{doc ? `Version ${doc.version} · ${statusLabel(doc.status)}` : "Waiting for draft generation"}</small></div>{doc && <button className="button" onClick={() => onOpenDocuments(doc.id)}>Open {label.toLowerCase()}<ArrowRight size={13} /></button>}</div>)}
            </div>
            <div className="autopilot-approval-note"><LockKeyhole size={14} />Approval stays attached to this project. The phase cannot close until both documents are approved.</div>
          </section>
        </div>

        <aside className="autopilot-side-column">
          <section className="autopilot-section compact"><div className="autopilot-section-heading"><div className="autopilot-icon cyan"><Link2 size={17} /></div><div><h3>Evidence-backed proposals</h3><p>Nothing is written into delivery records until a manager approves it.</p></div></div>
            {active.proposals?.length ? <div className="autopilot-proposals">{active.proposals.map((proposal: Row) => <article key={proposal.id} className="autopilot-proposal"><div className="proposal-type"><span>{statusLabel(proposal.proposal_type)}</span><span className={`proposal-state ${proposal.status.toLowerCase()}`}>{statusLabel(proposal.status)}</span></div><strong>{proposal.title}</strong>{proposal.description && <p>{proposal.description}</p>}{proposal.evidence?.length ? <details><summary><Link2 size={13} />{proposal.evidence.length} source {proposal.evidence.length === 1 ? "reference" : "references"}</summary>{proposal.evidence.map((ev: Row) => <blockquote key={ev.transcript_id}><small>{ev.meeting_title} · {ev.speaker} · {formatTimestamp(ev.timestamp_ms)}</small><span>“{ev.excerpt}”</span></blockquote>)}</details> : <span className="proposal-no-evidence"><CircleHelp size={13} />Needs human confirmation</span>}{proposal.status === "PROPOSED" && <div className="proposal-actions"><button className="button" disabled={!canManage || busy} onClick={() => decision(proposal, "REJECTED")}>Reject</button><button className="button primary" disabled={!canManage || busy || (["REQUIREMENT", "ACTION", "RISK"].includes(proposal.proposal_type) && !proposal.evidence?.length)} onClick={() => decision(proposal, "APPROVED")}>{canManage ? "Approve" : "Manager review"}</button></div>}{proposal.target_entity_id && <span className="proposal-linked"><CheckCircle2 size={13} />Linked to an approved delivery record</span>}</article>)}</div> : <div className="autopilot-empty-proposals"><Sparkles size={17} /><span>{aiConnected ? "Draft proposals will appear here after analysis." : "No suggestions yet. Connect AI to analyze the source evidence."}</span></div>}
            {!canManage && !!active.proposals?.some((p: Row) => p.status === "PROPOSED") && <div className="autopilot-manager-note"><LockKeyhole size={14} />An implementation manager must review these suggestions.</div>}
          </section>
          <section className="autopilot-section compact"><div className="autopilot-section-heading"><div className="autopilot-icon green"><ShieldCheck size={17} /></div><div><h3>Human control</h3><p>AI prepares work; your team owns decisions.</p></div></div><ul className="autopilot-safety-list"><li><CheckCircle2 size={14} />No external email is sent</li><li><CheckCircle2 size={14} />No project record changes before approval</li><li><CheckCircle2 size={14} />Source quotations are checked before linking</li><li><CheckCircle2 size={14} />Generation failures preserve your input</li></ul></section>
          <section className="autopilot-complete"><div><Clock3 size={15} />{approvedDocs ? unresolved ? "Resolve all proposals before completion." : "Documents approved. Ready for manager sign-off." : "Complete both document approvals to close this phase."}</div><button className="button" disabled={!canManage || busy || !approvedDocs || unresolved || active.status === "COMPLETED"} onClick={() => act("Kickoff-to-BRD phase completed.", async () => { await api(`autopilot/runs/${active.id}/complete`, { method: "POST", body: "{}" }); })}>{active.status === "COMPLETED" ? <><CheckCircle2 size={14} />Phase complete</> : "Complete phase"}</button></section>
        </aside>
      </div>
    </>}
  </div>;
}
