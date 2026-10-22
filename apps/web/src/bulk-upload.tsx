import { useState, type DragEvent } from "react";
import { ArrowLeft, Check, FileText, Loader2, Plus, UploadCloud, X } from "lucide-react";
import { api } from "./api";
import { extractImportFile, IMPORT_ACCEPT, IMPORT_FORMATS, isImportableFile, MAX_IMPORT_BYTES, titleFromImport } from "./import-file";
import "./bulk-upload.css";

export type AssetKind = "TEMPLATE" | "DOCUMENT" | "KNOWLEDGE_SOURCE" | "STANDARD" | "AI_INSTRUCTION";
type UploadStatus = "queued" | "uploading" | "created" | "skipped" | "failed";
type UploadItem = { id: string; file: File; title: string; status: UploadStatus; detail: string };
const MAX_FILES = 25;
const kinds: { value: AssetKind; label: string }[] = [
  { value: "DOCUMENT", label: "Document library" },
  { value: "TEMPLATE", label: "Templates" },
  { value: "KNOWLEDGE_SOURCE", label: "Knowledge sources" },
  { value: "STANDARD", label: "Standards & policies" },
  { value: "AI_INSTRUCTION", label: "AI instructions" },
];
const sizeLabel = (bytes: number) => `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

export function BulkUpload({
  defaultKind,
  existing,
  onClose,
  onComplete,
  onBusyChange,
}: {
  defaultKind: AssetKind;
  existing: { kind: string; name: string }[];
  onClose: () => void;
  onComplete: () => Promise<void>;
  onBusyChange: (value: boolean) => void;
}) {
  const [kind, setKind] = useState<AssetKind>(defaultKind);
  const [authority, setAuthority] = useState("REFERENCE");
  const [documentType, setDocumentType] = useState("");
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const hasCreated = items.some((item) => item.status === "created");
  const remaining = items.filter((item) => item.status === "queued" || item.status === "failed").length;
  const created = items.filter((item) => item.status === "created").length;
  const skipped = items.filter((item) => item.status === "skipped").length;
  const failed = items.filter((item) => item.status === "failed").length;

  function queue(files: FileList | File[]) {
    if (busy) return;
    const incoming = Array.from(files);
    const available = MAX_FILES - items.length;
    if (available <= 0) {
      setMessage(`A batch can contain up to ${MAX_FILES} files.`);
      return;
    }
    setItems((current) => [
      ...current,
      ...incoming.slice(0, available).map((file) => ({
        id: crypto.randomUUID(),
        file,
        title: titleFromImport(file.name),
        status: isImportableFile(file) && file.size <= MAX_IMPORT_BYTES ? "queued" as const : "skipped" as const,
        detail: !isImportableFile(file) ? "Unsupported format" : file.size > MAX_IMPORT_BYTES ? "Over 10 MB" : "Ready to import",
      })),
    ]);
    setMessage(incoming.length > available ? `Added ${available} files. A batch can contain up to ${MAX_FILES}.` : "");
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    queue(event.dataTransfer.files);
  }
  function updateItem(id: string, change: Partial<UploadItem>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...change } : item));
  }
  async function importFiles() {
    if (busy || !remaining) return;
    setBusy(true);
    onBusyChange(true);
    setMessage("");
    const known = new Set(existing.filter((asset) => asset.kind === kind).map((asset) => asset.name.trim().toLocaleLowerCase()));
    let createdNow = 0;
    try {
      for (const item of items) {
        if (item.status !== "queued" && item.status !== "failed") continue;
        const title = item.title.trim();
        if (title.length < 2) {
          updateItem(item.id, { status: "failed", detail: "Enter a title with at least 2 characters" });
          continue;
        }
        if (known.has(title.toLocaleLowerCase())) {
          updateItem(item.id, { status: "skipped", detail: "A library item with this title already exists" });
          continue;
        }
        updateItem(item.id, { status: "uploading", detail: "Importing…" });
        try {
          const content = await extractImportFile(item.file, { format: "markdown", maxChars: 200_000 });
          await api("intelligence/assets", {
            method: "POST",
            body: JSON.stringify({
              kind,
              name: title,
              description: `Imported from ${item.file.name}`,
              content,
              authority,
              ...(kind === "TEMPLATE" && documentType.trim() ? { document_type: documentType.trim() } : {}),
            }),
          });
          known.add(title.toLocaleLowerCase());
          createdNow += 1;
          updateItem(item.id, { status: "created", detail: "Draft created · review before publishing" });
        } catch (error) {
          updateItem(item.id, { status: "failed", detail: error instanceof Error ? error.message : "Import failed" });
        }
      }
      // Refresh even after an ambiguous network failure: the server may have
      // created the draft before the response was lost. The refreshed title
      // list prevents a retry from creating another copy.
      await onComplete();
      setMessage(createdNow ? `${createdNow} draft${createdNow === 1 ? "" : "s"} added to the library. Review and publish each item when ready.` : "No new drafts were created. Review the file results below.");
    } catch (error) {
      setMessage(`The library could not refresh: ${error instanceof Error ? error.message : "please reload this page"}`);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  return (
    <div className="bulk-upload">
      <button className="intel-back" onClick={onClose} disabled={busy}><ArrowLeft size={15} /> Back to library</button>
      <div className="intel-head">
        <div><span className="intel-kicker">ORGANIZATION LIBRARY · BULK IMPORT</span><h2>Bring your knowledge together</h2><p>Add up to 25 files. PDF, Word, Excel and CSV are converted into editable drafts.</p></div>
      </div>
      <div className="bulk-settings">
        <label>Destination<select value={kind} disabled={busy || hasCreated} onChange={(event) => setKind(event.target.value as AssetKind)}>{kinds.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>Authority<select value={authority} disabled={busy || hasCreated} onChange={(event) => setAuthority(event.target.value)}><option value="REFERENCE">Reference</option><option value="APPROVED">Approved guidance</option><option value="POLICY">Organization policy</option></select></label>
        {kind === "TEMPLATE" && <label>Document type (optional)<input value={documentType} disabled={busy || hasCreated} maxLength={80} placeholder="BRD, UAT, training…" onChange={(event) => setDocumentType(event.target.value)} /></label>}
      </div>
      <div className="bulk-drop" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
        <div className="bulk-drop-icon"><UploadCloud size={22} /></div>
        <strong>Drop files here, or choose from your computer</strong>
        <p>{IMPORT_FORMATS} · 10 MB per file · 25 files per batch</p>
        <label className="button"><Plus size={15} /> Choose files<input type="file" multiple accept={IMPORT_ACCEPT} disabled={busy || items.length >= MAX_FILES} onChange={(event) => { if (event.target.files) queue(event.target.files); event.target.value = ""; }} /></label>
      </div>
      <div className="bulk-privacy"><Check size={14} /> Files become private workspace drafts. Nothing is published or sent to an AI provider during import.</div>
      {!!items.length && <>
        <div className="bulk-list-head"><div><h3>Selected files <span>{items.length}</span></h3><p>Edit titles before import. Existing titles in the selected destination are skipped.</p></div><div className="bulk-summary">{created > 0 && <span className="created">{created} created</span>}{skipped > 0 && <span>{skipped} skipped</span>}{failed > 0 && <span className="failed">{failed} failed</span>}</div></div>
        <div className="bulk-list">{items.map((item) => <div className={`bulk-row ${item.status}`} key={item.id}>
          <span className="bulk-file-icon"><FileText size={17} /></span>
          <div className="bulk-file"><strong>{item.file.name}</strong><small>{sizeLabel(item.file.size)}</small></div>
          <label className="bulk-title">Library title<input aria-label={`Title for ${item.file.name}`} value={item.title} disabled={busy || item.status === "created"} maxLength={160} onChange={(event) => updateItem(item.id, { title: event.target.value, status: item.status === "failed" ? "queued" : item.status, detail: item.status === "failed" ? "Ready to import" : item.detail })} /></label>
          <span className="bulk-status">{item.status === "uploading" ? <Loader2 size={14} className="spin" /> : item.status === "created" ? <Check size={14} /> : null}{item.detail}</span>
          <button className="bulk-remove" aria-label={`Remove ${item.file.name}`} disabled={busy || item.status === "created"} onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}><X size={15} /></button>
        </div>)}</div>
        <div className="bulk-footer"><div role="status">{message || `${remaining} file${remaining === 1 ? "" : "s"} ready to import`}</div><button className="button primary" disabled={busy || !remaining} onClick={importFiles}>{busy ? <Loader2 size={15} className="spin" /> : <UploadCloud size={15} />}{busy ? "Importing drafts…" : failed ? "Retry remaining" : "Import drafts"}</button></div>
      </>}
      {!items.length && message && <p role="status" className="bulk-message">{message}</p>}
    </div>
  );
}
