import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  ArrowLeft,
  ArrowDownToLine,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Columns2,
  FileCheck2,
  FilePlus2,
  FileText,
  GitCompareArrows,
  History,
  Loader2,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { documentTypes, templateFor } from "../../../packages/domain/document-templates";
import { api } from "./api";
import { extractImportFile, IMPORT_ACCEPT, IMPORT_FORMATS, titleFromImport } from "./import-file";

type Row = Record<string, any>;
const typeName = (type: string) =>
  documentTypes.find((entry) => entry.id === type)?.name ??
  (type === "REFERENCE" ? "Reference file" : type.replaceAll("_", " "));
const date = (value?: string) =>
  value
    ? new Date(value).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "Not recorded";
const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const inlineMarkdown = (text: string) =>
  escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

function previewMarkdown(markdown: string) {
  const lines = markdown.replaceAll("\r", "").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) blocks.push(`<ul>${list.map((x) => `<li>${inlineMarkdown(x)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    if (line.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) {
      flushParagraph(); flushList();
      const head = line.split("|").slice(1, -1);
      i++;
      const rows: string[][] = [];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) {
        i++;
        rows.push(lines[i].split("|").slice(1, -1));
      }
      blocks.push(`<div class="document-preview-table-wrap"><table><thead><tr>${head.map((c) => `<th>${inlineMarkdown(c.trim())}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${inlineMarkdown(c.trim())}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { flushParagraph(); flushList(); const level = Math.min(4, heading[1].length + 1); blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
    if (/^[-*]\s+/.test(line)) { flushParagraph(); list.push(line.slice(2)); continue; }
    if (/^\d+\.\s+/.test(line)) { flushParagraph(); list.push(line.replace(/^\d+\.\s+/, "")); continue; }
    if (/^---+$/.test(line)) { flushParagraph(); flushList(); blocks.push("<hr>"); continue; }
    if (line.startsWith("> ")) { flushParagraph(); flushList(); blocks.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`); continue; }
    flushList(); paragraph.push(line);
  }
  flushParagraph(); flushList();
  return blocks.join("");
}

type DiffPart = { kind: "same" | "added" | "removed"; text: string };
function compareLines(before: string, after: string): DiffPart[] {
  const left = before.split("\n").slice(0, 800);
  const right = after.split("\n").slice(0, 800);
  const dp = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const result: DiffPart[] = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { result.push({ kind: "same", text: left[i++] }); j++; }
    else if (j < right.length && (i === left.length || dp[i][j + 1] >= dp[i + 1][j])) result.push({ kind: "added", text: right[j++] });
    else result.push({ kind: "removed", text: left[i++] });
  }
  return result;
}

function DocumentPreview({ content }: { content: string }) {
  return (
    <article
      className="document-preview"
      dangerouslySetInnerHTML={{ __html: previewMarkdown(content) }}
    />
  );
}

export function Documents({
  records,
  canWrite,
  canReview,
  ai,
  onBackToAutopilot,
  implementationId,
  implementationName,
  focusDocumentId,
}: {
  records: Row[];
  canWrite: boolean;
  canReview: boolean;
  ai: { ai_connected?: boolean; ai_provider?: string; ai_model?: string } | null;
  onBackToAutopilot?: () => void;
  implementationId?: string;
  implementationName?: string;
  focusDocumentId?: string;
}) {
  const [localRecords, setLocalRecords] = useState(records);
  const [implementations, setImplementations] = useState<Row[]>([]);
  const [active, setActive] = useState<Row | null>(null);
  const [versions, setVersions] = useState<Row[]>([]);
  const [editor, setEditor] = useState<"edit" | "preview" | "compare">("edit");
  const [compareBase, setCompareBase] = useState("");
  const [compareHead, setCompareHead] = useState("");
  const [create, setCreate] = useState(false);
  const [filter, setFilter] = useState("All documents");
  const [query, setQuery] = useState("");
  const [implementationFilter, setImplementationFilter] = useState("All implementations");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState({ name: "", content: "", status: "DRAFT", change_summary: "" });
  const [createType, setCreateType] = useState("BRD");
  const [createImplementation, setCreateImplementation] = useState("");
  const [createName, setCreateName] = useState("");
  const [createNotes, setCreateNotes] = useState("");
  const [sourceNotes, setSourceNotes] = useState<string[]>([]);
  const [openQuestions, setOpenQuestions] = useState<string[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<string | null>(null);
  const [importedFileName, setImportedFileName] = useState("");
  useEffect(() => setLocalRecords(records), [records]);
  const realDocs = useMemo(() => localRecords.filter((r) => r.source !== "DEMO_METADATA"), [localRecords]);
  const selectedImplementation = implementations.find((r) => r.id === createImplementation);
  const activeImplementationName = implementationName ?? selectedImplementation?.name ?? "Implementation";
  const filters = ["All documents", "BRD", "UAT", "Technical", "Delivery"];
  const visible = realDocs.filter((r) => {
    const effectiveImplementation = implementationId ?? implementationFilter;
    const matchesImplementation = effectiveImplementation === "All implementations" || r.implementation_id === effectiveImplementation;
    const matchesQuery = `${r.name} ${typeName(r.type)} ${r.implementation?.name ?? ""}`.toLowerCase().includes(query.toLowerCase());
    const t = r.type ?? "REFERENCE";
    const matchesType = filter === "All documents" || (filter === "BRD" ? t === "BRD" : filter === "UAT" ? t.startsWith("UAT") : filter === "Technical" ? ["INTEGRATION_SPEC", "SOLUTION_DESIGN"].includes(t) : ["KICKOFF_STORYBOARD", "PROJECT_CHARTER", "TRAINING_PLAN", "CUTOVER_PLAN", "RAID_LOG"].includes(t));
    return matchesImplementation && matchesQuery && matchesType;
  }).sort((a, b) => (b.updated_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.created_at ?? ""));

  useEffect(() => {
    let mounted = true;
    api<Row[]>("implementations?limit=100").then((rows) => {
      if (mounted) {
        setImplementations(rows);
        setCreateImplementation((current) => current || rows[0]?.id || "");
      }
    }).catch((e) => mounted && setError(e.message));
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let mounted = true;
    api<Row[]>("documents?limit=100")
      .then((rows) => {
        if (!mounted) return;
        setLocalRecords(rows);
        if (focusDocumentId) {
          const selected = rows.find((row) => row.id === focusDocumentId);
          if (selected) setActive(selected);
          else setError("This project document is no longer available.");
        }
      })
      .catch((e) => mounted && setError(e.message));
    return () => { mounted = false; };
  }, [focusDocumentId]);

  useEffect(() => {
    if (implementationId) {
      setImplementationFilter(implementationId);
      setCreateImplementation(implementationId);
    }
  }, [implementationId]);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    api<Row[]>(`documents/${active.id}/versions?implementation_id=${encodeURIComponent(active.implementation_id)}`)
      .then((rows) => {
        if (!mounted) return;
        const sorted = [...rows].sort((a, b) => b.version - a.version);
        setVersions(sorted);
        setCompareHead(String(sorted[0]?.id ?? ""));
        setCompareBase(String(sorted[1]?.id ?? sorted[0]?.id ?? ""));
      }).catch((e) => mounted && setError(e.message));
    return () => { mounted = false; };
  }, [active?.id, active?.version]);

  useEffect(() => {
    if (!active) return;
    setDraft({ name: active.name, content: active.content ?? "", status: active.status ?? "DRAFT", change_summary: "" });
    setSourceNotes(active.generation_notes ?? []);
    setOpenQuestions(active.open_questions ?? []);
    setEditor("edit");
  }, [active?.id]);

  async function createFromTemplate() {
    if (!canWrite || !selectedImplementation) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const [requirements, tasks, stakeholders, risks] = await Promise.all([
        api<Row[]>(`requirements?implementation_id=${createImplementation}&limit=100`),
        api<Row[]>(`tasks?implementation_id=${createImplementation}&limit=100`),
        api<Row[]>(`stakeholders?implementation_id=${createImplementation}&limit=100`),
        api<Row[]>(`risks?implementation_id=${createImplementation}&limit=100`),
      ]);
      const type = documentTypes.find((x) => x.id === createType);
      const content = imported ?? `${templateFor(createType, selectedImplementation, { requirements, tasks, stakeholders, risks })}${createNotes.trim() ? `\n\n## Additional context from requester\n\n${createNotes.trim()}\n` : ""}`;
      const row = await api<Row>("documents", {
        method: "POST",
        body: JSON.stringify({
          implementation_id: createImplementation,
          name: createName.trim() || (imported ? titleFromImport(importedFileName) : `${selectedImplementation.name} · ${type?.name ?? typeName(createType)}`),
          type: createType,
          content,
          status: "DRAFT",
          template_id: imported ? "file-import-v1" : `nexus-${createType.toLowerCase()}-v1`,
          change_summary: imported ? `Imported from ${importedFileName}` : `Created from ${type?.name ?? typeName(createType)} template`,
        }),
      });
      setLocalRecords((current) => [row, ...current.filter((item) => item.id !== row.id)]);
      setCreate(false); setImported(null); setImportedFileName(""); setCreateName(""); setCreateNotes("");
      setActive(row); setNotice("Draft created. Review the open items before sharing it.");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function generateWithAi() {
    if (!canWrite || !selectedImplementation || !ai?.ai_connected) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const row = await api<Row>("documents/generate", {
        method: "POST",
        body: JSON.stringify({
          implementation_id: createImplementation,
          type: createType,
          name: createName.trim() || undefined,
          notes: createNotes,
        }),
      });
      setCreate(false); setCreateName(""); setCreateNotes("");
      setActive(row); setNotice("AI draft generated from workspace records. Validate the cited context and open questions before review.");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function save(nextStatus = draft.status) {
    if (!active || !canWrite) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const updated = await api<Row>(`documents/${active.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name,
          content: draft.content,
          status: nextStatus,
          open_questions: openQuestions,
          change_summary: draft.change_summary.trim() || (nextStatus !== active.status ? `Status changed to ${nextStatus.replaceAll("_", " ")}` : "Content edited"),
        }),
      });
      setLocalRecords((current) => current.map((item) => item.id === updated.id ? updated : item));
      setActive(updated);
      setDraft((current) => ({ ...current, status: updated.status, change_summary: "" }));
      setNotice(updated.version === active.version ? "No content changes to version." : `Version ${updated.version} saved to history.`);
      const rows = await api<Row[]>(`documents/${updated.id}/versions?implementation_id=${encodeURIComponent(updated.implementation_id)}`);
      const sorted = [...rows].sort((a, b) => b.version - a.version);
      setVersions(sorted); setCompareHead(String(sorted[0]?.id ?? "")); setCompareBase(String(sorted[1]?.id ?? sorted[0]?.id ?? ""));
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await extractImportFile(file, { format: "markdown", maxChars: 100_000 });
      setImported(text); setImportedFileName(file.name); setCreateName(titleFromImport(file.name)); setCreate(true); setError("");
    } catch (error) { setError(error instanceof Error ? error.message : `The file could not be read. Supported: ${IMPORT_FORMATS}.`); }
  }

  function exportMarkdown() {
    if (!active) return;
    const url = URL.createObjectURL(new Blob([draft.content], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${draft.name || "document"}.md`; link.click(); URL.revokeObjectURL(url);
  }

  const baseVersion = versions.find((v) => String(v.id) === compareBase);
  const headVersion = versions.find((v) => String(v.id) === compareHead);
  const diffParts = useMemo(
    () => editor === "compare" && baseVersion && headVersion && baseVersion.id !== headVersion.id
      ? compareLines(baseVersion.content, headVersion.content)
      : [],
    [editor, baseVersion?.id, headVersion?.id],
  );
  const addedLines = diffParts.filter((part) => part.kind === "added").length;
  const removedLines = diffParts.filter((part) => part.kind === "removed").length;
  const latestVersion = versions[0]?.version ?? active?.version ?? 0;
  const hasChanges = !!active && (draft.name !== active.name || draft.content !== (active.content ?? "") || draft.status !== (active.status ?? "DRAFT") || JSON.stringify(openQuestions) !== JSON.stringify(active.open_questions ?? []));
  const summary = {
    total: realDocs.length,
    review: realDocs.filter((r) => r.status === "IN_REVIEW").length,
    approved: realDocs.filter((r) => r.status === "APPROVED").length,
    drafts: realDocs.filter((r) => !r.status || r.status === "DRAFT").length,
  };

  if (active) return (
    <div className="documents-page">
      <div className="document-editor-heading">
        <div className="document-editor-navigation">
        <button className="text-button" onClick={() => { setActive(null); setError(""); }}><ArrowLeft size={15} /> {implementationId ? "Project documents" : "All documents"}</button>
          {onBackToAutopilot && <button className="text-button" onClick={() => { if (hasChanges && !window.confirm("Leave without saving your document changes?")) return; onBackToAutopilot(); }}><ArrowLeft size={15} /> Implementation Autopilot</button>}
        </div>
        <div className="document-editor-actions">
          <button className="button" onClick={exportMarkdown}><ArrowDownToLine size={15} /> Export .md</button>
          {canWrite && <button className="button primary" onClick={() => save()} disabled={!hasChanges || busy}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Save version</button>}
        </div>
      </div>
      <div className="document-title-row">
        <div><span className="eyebrow">{typeName(active.type)} · {implementations.find((r) => r.id === active.implementation_id)?.name ?? activeImplementationName}</span><input className="document-title-input" aria-label="Document title" value={draft.name} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /><div className="document-meta-line"><span className={`badge ${draft.status.toLowerCase()}`}><i />{draft.status.replaceAll("_", " ")}</span><span>Version {latestVersion}</span><span>Updated {date(active.updated_at ?? active.created_at)}</span><span>{active.source === "AI_GENERATED" ? "AI-assisted draft" : active.source === "UPLOAD" ? "Imported file" : "Workspace draft"}</span></div></div>
      </div>
      {notice && <div className="document-alert success" role="status"><CheckCircle2 size={16} />{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></div>}
      {error && <div className="document-alert error" role="alert"><CircleAlert size={16} />{error}<button aria-label="Dismiss" onClick={() => setError("")}><X size={14} /></button></div>}
      <div className="document-review-toolbar">
        <div className="document-mode-switch" role="tablist" aria-label="Document view">
          <button className={editor === "edit" ? "active" : ""} role="tab" aria-selected={editor === "edit"} onClick={() => setEditor("edit")}><Pencil size={14} />Edit</button>
          <button className={editor === "preview" ? "active" : ""} role="tab" aria-selected={editor === "preview"} onClick={() => setEditor("preview")}><FileCheck2 size={14} />Preview</button>
          <button className={editor === "compare" ? "active" : ""} role="tab" aria-selected={editor === "compare"} onClick={() => setEditor("compare")}><GitCompareArrows size={14} />Compare</button>
        </div>
          <span className="quiet"><History size={14} /> {versions.length} saved {versions.length === 1 ? "version" : "versions"} · changes stay in this implementation</span>
      </div>
      {editor === "compare" ? (
        <div className="document-compare-view">
          <div className="document-compare-head"><div><GitCompareArrows size={17} /><strong>Version comparison</strong><span>Changed lines are highlighted; saved versions are immutable.</span></div><div className="document-compare-selectors"><label>From<select value={compareBase} onChange={(e) => setCompareBase(e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {date(v.created_at)}</option>)}</select></label><ArrowRightIcon /><label>To<select value={compareHead} onChange={(e) => setCompareHead(e.target.value)}>{versions.map((v) => <option key={v.id} value={v.id}>v{v.version} · {date(v.created_at)}</option>)}</select></label></div></div>
          <div className="document-diff-legend"><span><i className="removed" /> Removed</span><span><i className="added" /> Added</span>{(baseVersion?.content?.split("\n").length ?? 0) > 800 && <small>Showing the first 800 lines per version.</small>}</div>
          {baseVersion && headVersion && baseVersion.id !== headVersion.id ? <><div className="document-diff-summary"><span><i className="added" />{addedLines} lines added</span><span><i className="removed" />{removedLines} lines removed</span><span>Comparing v{baseVersion.version} → v{headVersion.version}</span></div><div className="document-diff"><div className="diff-side"><div>Previous · v{baseVersion.version}<small>{baseVersion.name}</small></div>{diffParts.filter((p) => p.kind !== "added").map((p, i) => <pre key={i} className={p.kind}>{p.text || " "}</pre>)}</div><div className="diff-side"><div>Current · v{headVersion.version}<small>{headVersion.name}</small></div>{diffParts.filter((p) => p.kind !== "removed").map((p, i) => <pre key={i} className={p.kind}>{p.text || " "}</pre>)}</div></div></> : <div className="document-diff-empty"><GitCompareArrows size={19} />Choose two different saved versions to review what changed.</div>}
        </div>
      ) : (
        <div className={`document-workbench ${editor === "preview" ? "preview-only" : ""}`}>
          <div className="document-content-panel">
            <div className="document-panel-header"><span>{editor === "edit" ? "EDITOR" : "DOCUMENT PREVIEW"}</span>{editor === "edit" && <small>Markdown · {draft.content.length.toLocaleString()} characters</small>}</div>
            {editor === "edit" ? <textarea aria-label="Edit document content in Markdown" className="document-editor" value={draft.content} maxLength={100000} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, content: e.target.value })} spellCheck /> : <DocumentPreview content={draft.content} />}
          </div>
          <aside className="document-context-panel">
            <section><div className="document-panel-header"><span>REVIEW WORKFLOW</span></div><div className="document-review-actions"><label>Document status<select value={draft.status} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>{["DRAFT", "IN_REVIEW", ...(canReview || draft.status === "APPROVED" ? ["APPROVED"] : []), ...(canReview || draft.status === "ARCHIVED" ? ["ARCHIVED"] : [])].map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}</select></label><label>Version note<input value={draft.change_summary} disabled={!canWrite} maxLength={500} placeholder="What changed in this revision?" onChange={(e) => setDraft({ ...draft, change_summary: e.target.value })} /></label>{canWrite && <div className="document-status-actions">{active.status !== "IN_REVIEW" && active.status !== "APPROVED" && active.status !== "ARCHIVED" && <button className="button" disabled={busy} onClick={() => save("IN_REVIEW")}>Submit for review</button>}{canReview && active.status === "IN_REVIEW" && <button className="button primary" disabled={busy} onClick={() => save("APPROVED")}>Approve version</button>}</div>}</div></section>
            <section><div className="document-panel-header"><span>VERSION HISTORY</span><button className="text-button" onClick={() => setEditor("compare")}><Columns2 size={14} /> Compare</button></div><div className="document-version-list">{versions.length ? versions.map((v) => <div className="document-version" key={v.id}><span className={`version-node ${String(v.id) === String(versions[0]?.id) ? "current" : ""}`}><History size={13} /></span><div><strong>Version {v.version}</strong><small>{v.change_summary}</small><time>{date(v.created_at)}</time></div>{String(v.id) === String(versions[0]?.id) && <span className="current-tag">CURRENT</span>}</div>) : <p className="quiet">First save will start the version history.</p>}</div></section>
            {openQuestions.length > 0 && <section className="document-open-questions"><div className="document-panel-header"><span><CircleAlert size={13} /> OPEN QUESTIONS</span><small>{openQuestions.length} to resolve before approval</small></div><ul>{openQuestions.map((q, i) => <li key={i}>{q}{canWrite && active.status !== "APPROVED" && <button className="text-button" type="button" onClick={() => setOpenQuestions((current) => current.filter((_, index) => index !== i))}>Mark resolved</button>}</li>)}</ul></section>}
            {sourceNotes.length > 0 && <section><div className="document-panel-header"><span><Sparkles size={13} /> GROUNDED IN</span></div><ul className="document-source-notes">{sourceNotes.map((note, i) => <li key={i}>{note}</li>)}</ul></section>}
          </aside>
        </div>
      )}
      {hasChanges && <div className="document-unsaved"><span><i /> Unsaved changes</span><button className="text-button" onClick={() => { setDraft({ name: active.name, content: active.content ?? "", status: active.status ?? "DRAFT", change_summary: "" }); setOpenQuestions(active.open_questions ?? []); }}>Discard</button><button className="button primary" disabled={busy} onClick={() => save()}>{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />}Save version</button></div>}
    </div>
  );

  return (
    <div className="documents-page">
      <input ref={importRef} className="visually-hidden" type="file" accept={IMPORT_ACCEPT} onChange={importFile} />
      <div className="documents-heading"><div><div className="eyebrow">{implementationId ? "IMPLEMENTATION WORKSPACE" : "IMPLEMENTATION KNOWLEDGE"}</div><h1>{implementationId ? "Project documents" : "Documents"}</h1><p>{implementationId ? `Keep ${activeImplementationName}’s storyboard, BRD and delivery artifacts together with their source history.` : "Draft, review and keep an accountable history of every implementation document."}</p></div><div className="documents-heading-actions">{onBackToAutopilot && <button className="button" onClick={onBackToAutopilot}><ArrowLeft size={15} />Back to Autopilot</button>}{canWrite && <><button className="button" onClick={() => importRef.current?.click()}><Upload size={15} />Import file</button><button className="button primary" onClick={() => { setCreate(true); setImported(null); setImportedFileName(""); setError(""); }}><Plus size={16} />New document</button></>}</div></div>
      {notice && <div className="document-alert success" role="status"><CheckCircle2 size={16} />{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></div>}
      {error && <div className="document-alert error" role="alert"><CircleAlert size={16} />{error}<button aria-label="Dismiss" onClick={() => setError("")}><X size={14} /></button></div>}
      {create && <section className="document-create-flow" aria-labelledby="new-document-title"><div className="document-create-heading"><span className="document-create-icon"><FilePlus2 size={19} /></span><div><div className="eyebrow">DOCUMENT WORKSPACE</div><h2 id="new-document-title">Start with the right structure</h2><p>Choose a customer implementation and a proven document format.</p></div><button className="icon-button" onClick={() => { setCreate(false); setImported(null); }} aria-label="Close"><X size={17} /></button></div>
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="document-create-fields"><label>Document type<select value={createType} onChange={(e) => { setCreateType(e.target.value); setCreateName(""); }}>{documentTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>{implementationId ? <div className="document-create-context"><span>Implementation</span><strong>{activeImplementationName}</strong></div> : <label>Implementation<select required value={createImplementation} onChange={(e) => setCreateImplementation(e.target.value)}>{implementations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>}<label className="document-create-name">Document title<input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder={`${activeImplementationName} · ${typeName(createType)}`} maxLength={160} /></label></div>
          {imported ? <div className="document-import-summary"><FileText size={16} />Text extracted from {importedFileName} will be kept as the first editable draft. Review it before sharing.</div> : <div className="document-template-summary"><div><span className="document-template-icon"><FileText size={17} /></span><div><strong>{typeName(createType)}</strong><small>{createType === "BRD" ? "Uses your uploaded BRD structure: scope, requirements, integrations, risks, UAT, sign-off and open items." : "Structured sections, acceptance tables and explicit prompts for decisions that still need confirmation."}</small></div></div><span className="document-template-tag">EDITABLE TEMPLATE</span></div>}
          <label className="document-ai-notes">Additional instructions <span>Optional</span><textarea rows={2} value={createNotes} onChange={(e) => setCreateNotes(e.target.value)} placeholder="Add project-specific context or emphasis for this document." maxLength={4000} /></label>
          {ai?.ai_connected && <p className="document-data-disclosure"><Shield size={14} /> If you choose AI generation, customer and project names, scope, target dates, requirement/task/milestone/risk descriptions, stakeholder names and roles, and your extra instructions go to <strong>{ai.ai_provider ?? "your configured AI provider"}</strong>. Emails and existing document bodies are not sent.</p>}
          {!ai?.ai_connected && <p className="document-provider-hint"><Sparkles size={14} /> AI generation is not connected yet. Add a server-side provider in the local environment to enable it; no project data is sent while disconnected.</p>}
          <div className="document-create-actions"><button type="button" className="button" onClick={() => { setCreate(false); setImported(null); }}>Cancel</button><button type="button" className="button" disabled={busy || !canWrite || !selectedImplementation} onClick={createFromTemplate}>{busy ? <Loader2 size={15} className="spin" /> : <FileText size={15} />}Create from template</button>{ai?.ai_connected && <button type="button" className="button primary" disabled={busy || !canWrite || !selectedImplementation} onClick={generateWithAi}>{busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}Generate with AI</button>}</div>
        </form>
      </section>}
      <div className="document-summary-row"><div><span>Total documents</span><strong>{summary.total}</strong></div><div><span>In review</span><strong>{summary.review}</strong></div><div><span>Approved</span><strong>{summary.approved}</strong></div><div><span>Drafts to finish</span><strong>{summary.drafts}</strong></div></div>
      <div className="document-library"><div className="document-library-toolbar"><div className="document-filter-tabs" role="tablist" aria-label="Document types">{filters.map((f) => <button key={f} className={filter === f ? "active" : ""} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>{f}</button>)}</div><div className="document-list-controls"><label className="document-search"><Search size={15} /><input aria-label="Search documents" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a document" /></label>{!implementationId && <label className="document-implementation-filter"><select value={implementationFilter} onChange={(e) => setImplementationFilter(e.target.value)} aria-label="Filter by implementation"><option>All implementations</option>{implementations.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select><ChevronDown size={13} /></label>}</div></div>
        {visible.length ? <div className="document-table-wrap"><table className="document-table"><thead><tr><th>Document</th>{!implementationId && <th>Implementation</th>}<th>Status</th><th>Version</th><th>Last updated</th><th><span className="visually-hidden">Open</span></th></tr></thead><tbody>{visible.map((r) => <tr key={r.id} onClick={() => { setActive(r); setError(""); setNotice(""); }} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setActive(r); }}><td><span className="document-cell-icon"><FileText size={17} /></span><span className="document-cell-title"><strong>{r.name}</strong><small>{typeName(r.type)}{r.source === "AI_GENERATED" ? " · AI-assisted" : r.source === "UPLOAD" ? " · Imported" : ""}</small></span></td>{!implementationId && <td>{implementations.find((i) => i.id === r.implementation_id)?.name ?? "Implementation"}</td>}<td><span className={`badge ${(r.status ?? "DRAFT").toLowerCase()}`}><i />{(r.status ?? "DRAFT").replaceAll("_", " ")}</span></td><td>v{r.version ?? 1}</td><td>{date(r.updated_at ?? r.created_at)}</td><td><button aria-label={`Open ${r.name}`} className="document-open-button" onClick={(e) => { e.stopPropagation(); setActive(r); setError(""); setNotice(""); }}><ChevronDown size={15} /></button></td></tr>)}</tbody></table></div> : <div className="document-empty"><span><FileText size={21} /></span><h3>{query || filter !== "All documents" || (!implementationId && implementationFilter !== "All implementations") ? "No matching documents" : implementationId ? "Your project documents are ready" : "Your document workspace is ready"}</h3><p>{query || filter !== "All documents" || (!implementationId && implementationFilter !== "All implementations") ? "Try another search or filter." : "Create a BRD from your uploaded format, set up a UAT plan, or import an existing file. Drafts and every saved revision stay in this workspace."}</p>{!query && canWrite && !create && <button className="button primary" onClick={() => setCreate(true)}><FilePlus2 size={15} />Create the first document</button>}</div>}
      </div>
      <div className="document-library-foot"><span><History size={14} /> Every save creates an immutable revision.</span><span><PanelRight size={14} />Review states and source notes stay attached to each document.</span><button className="text-button" onClick={() => importRef.current?.click()}><Upload size={14} /> Import .md or .txt</button></div>
      {records.some((r) => r.source === "DEMO_METADATA") && <p className="document-metadata-note"><CircleAlert size={14} /> {records.filter((r) => r.source === "DEMO_METADATA").length} sample registry entries have metadata only—no files or content are attached.</p>}
    </div>
  );
}

function ArrowRightIcon() { return <span className="document-compare-arrow">→</span>; }
function Shield({ size }: { size: number }) { return <CheckCircle2 size={size} />; }
