import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  ClipboardList,
  FileText,
  History,
  Layers3,
  LibraryBig,
  Loader2,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { api } from "./api";
import { BulkUpload, type AssetKind } from "./bulk-upload";
import { extractImportFile, IMPORT_ACCEPT, IMPORT_FORMATS } from "./import-file";
import "./intelligence.css";

type Stage = {
  key: string;
  name: string;
  description: string;
  entry_criteria: string;
  exit_criteria: string;
  duration_days: number | null;
  approval_required: boolean;
  tasks: {
    title: string;
    description: string;
    priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  }[];
  milestones: { name: string; description: string }[];
};
type Playbook = {
  id: string;
  name: string;
  description: string;
  implementation_type: string;
  status: string;
  published_version: number;
  updated_at: string;
  draft_snapshot: { stages: Stage[] };
};
type Asset = {
  id: string;
  name: string;
  description: string;
  content: string;
  kind: string;
  document_type: string | null;
  source_url: string | null;
  authority: string;
  status: string;
  published_version: number;
  updated_at: string;
};
type Section =
  | "overview"
  | "playbooks"
  | "templates"
  | "documents"
  | "sources"
  | "standards"
  | "instructions"
  | "versions";
const sections: { id: Section; label: string; icon: typeof Layers3 }[] = [
  { id: "overview", label: "Overview", icon: Layers3 },
  { id: "playbooks", label: "Playbooks", icon: ClipboardList },
  { id: "templates", label: "Templates", icon: FileText },
  { id: "documents", label: "Document library", icon: LibraryBig },
  { id: "sources", label: "Knowledge sources", icon: UploadCloud },
  { id: "standards", label: "Standards & policies", icon: ShieldCheck },
  { id: "instructions", label: "AI instructions", icon: Sparkles },
  { id: "versions", label: "Version history", icon: History },
];
const kindFor: Record<Section, string | null> = {
  overview: null,
  playbooks: null,
  templates: "TEMPLATE",
  documents: "DOCUMENT",
  sources: "KNOWLEDGE_SOURCE",
  standards: "STANDARD",
  instructions: "AI_INSTRUCTION",
  versions: null,
};
const emptyStage = (index: number): Stage => ({
  key: `stage-${index + 1}`,
  name: "",
  description: "",
  entry_criteria: "",
  exit_criteria: "",
  duration_days: null,
  approval_required: false,
  tasks: [],
  milestones: [],
});
const slug = (name: string, index: number) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || `stage-${index + 1}`;
const date = (value: string) =>
  new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

export function IntelligenceLibrary({ canManage }: { canManage: boolean }) {
  const [section, setSection] = useState<Section>("overview");
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<{
    type: "playbook" | "asset";
    id: string;
  } | null>(null);
  const [draftPlaybook, setDraftPlaybook] = useState<Playbook | null>(null);
  const [draftAsset, setDraftAsset] = useState<Asset | null>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [versionFor, setVersionFor] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [bulkKind, setBulkKind] = useState<AssetKind | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  async function refresh() {
    setError("");
    const result = await api<{ playbooks: Playbook[]; assets: Asset[] }>(
      "intelligence/overview",
    );
    setPlaybooks(result.playbooks);
    setAssets(result.assets);
    return result;
  }
  useEffect(() => {
    if (!canManage) {
      setBusy(false);
      return;
    }
    refresh()
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, [canManage]);
  function navigate(next: Section) {
    if (bulkBusy) return;
    setSection(next);
    setBulkKind(null);
    setSelected(null);
    setVersions([]);
    setVersionFor("");
    setError("");
    setNotice("");
    setDirty(false);
    setCreating(null);
  }
  function openPlaybook(item: Playbook) {
    setSelected({ type: "playbook", id: item.id });
    setDraftPlaybook(structuredClone(item));
    setDirty(false);
    setVersions([]);
    setVersionFor("");
  }
  function openAsset(item: Asset) {
    setSelected({ type: "asset", id: item.id });
    setDraftAsset(structuredClone(item));
    setDirty(false);
    setVersions([]);
    setVersionFor("");
  }
  function changePlaybook(next: Playbook) {
    setDraftPlaybook(next);
    setDirty(true);
  }
  function changeAsset(next: Asset) {
    setDraftAsset(next);
    setDirty(true);
  }
  async function perform<T>(action: () => Promise<T>, success: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await action();
      await refresh();
      setNotice(success);
      return result;
    } catch (e: any) {
      setError(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  }
  async function createPlaybook() {
    if (!newName.trim()) return;
    const item = await perform(
      () =>
        api<Playbook>("intelligence/playbooks", {
          method: "POST",
          body: JSON.stringify({
            name: newName.trim(),
            description: "",
            implementation_type: "ENTERPRISE",
          }),
        }),
      "Draft playbook created.",
    );
    if (item) {
      setSection("playbooks");
      openPlaybook(item);
      setCreating(null);
      setNewName("");
    }
  }
  async function createAsset(kind: string) {
    if (!newName.trim()) return;
    const item = await perform(
      () =>
        api<Asset>("intelligence/assets", {
          method: "POST",
          body: JSON.stringify({
            kind,
            name: newName.trim(),
            content: "",
            description: "",
            authority: "REFERENCE",
          }),
        }),
      "Library draft created.",
    );
    if (item) {
      openAsset(item);
      setCreating(null);
      setNewName("");
    }
  }
  async function savePlaybook(publish = false) {
    if (!draftPlaybook) return;
    const snapshot = {
      stages: draftPlaybook.draft_snapshot.stages.map((s, i) => ({
        ...s,
        key: slug(s.name, i),
      })),
    };
    if (
      new Set(snapshot.stages.map((s) => s.key)).size !== snapshot.stages.length
    ) {
      setError("Stage names must be unique.");
      return;
    }
    const saved = await perform(
      () =>
        api<Playbook>(`intelligence/playbooks/${draftPlaybook.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: draftPlaybook.name,
            description: draftPlaybook.description,
            implementation_type: draftPlaybook.implementation_type,
            draft_snapshot: snapshot,
          }),
        }),
      "Playbook draft saved.",
    );
    if (!saved) return;
    setDraftPlaybook(saved);
    setDirty(false);
    if (publish) {
      const published = await perform(
        () =>
          api<Playbook>(`intelligence/playbooks/${saved.id}/publish`, {
            method: "POST",
            body: "{}",
          }),
        "Playbook published. New implementations can now use this version.",
      );
      if (published) setDraftPlaybook(published);
    }
  }
  async function saveAsset(publish = false) {
    if (!draftAsset) return;
    const saved = await perform(
      () =>
        api<Asset>(`intelligence/assets/${draftAsset.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: draftAsset.name,
            description: draftAsset.description,
            content: draftAsset.content,
            document_type: draftAsset.document_type,
            source_url: draftAsset.source_url,
            authority: draftAsset.authority,
          }),
        }),
      "Library draft saved.",
    );
    if (!saved) return;
    setDraftAsset(saved);
    setDirty(false);
    if (publish) {
      const published = await perform(
        () =>
          api<Asset>(`intelligence/assets/${saved.id}/publish`, {
            method: "POST",
            body: "{}",
          }),
        "Library item published.",
      );
      if (published) setDraftAsset(published);
    }
  }
  async function showVersions(type: "playbook" | "asset", id: string) {
    setVersionFor(id);
    setError("");
    try {
      setVersions(
        await api(
          `intelligence/${type === "playbook" ? "playbooks" : "assets"}/${id}/versions`,
        ),
      );
    } catch (e: any) {
      setError(e.message);
    }
  }
  const filteredAssets = assets.filter(
    (a) => a.kind === kindFor[section] && a.status !== "ARCHIVED",
  );
  const activePlaybooks = playbooks.filter((p) => p.status !== "ARCHIVED");
  const published = playbooks.filter((p) => p.status === "PUBLISHED").length;
  const publishedAssets = assets.filter((a) => a.status === "PUBLISHED");
  const coverage: { label: string; section: Section; ready: boolean }[] = [
    { label: "Implementation playbook", section: "playbooks", ready: published > 0 },
    { label: "BRD template", section: "templates", ready: publishedAssets.some((a) => a.kind === "TEMPLATE" && a.document_type?.toUpperCase() === "BRD") },
    { label: "UAT template", section: "templates", ready: publishedAssets.some((a) => a.kind === "TEMPLATE" && a.document_type?.toUpperCase() === "UAT") },
    { label: "Delivery standards", section: "standards", ready: publishedAssets.some((a) => a.kind === "STANDARD") },
    { label: "Knowledge sources", section: "sources", ready: publishedAssets.some((a) => a.kind === "KNOWLEDGE_SOURCE") },
    { label: "AI instructions", section: "instructions", ready: publishedAssets.some((a) => a.kind === "AI_INSTRUCTION") },
  ];
  const coverageCount = coverage.filter((item) => item.ready).length;
  const selectedPlaybook = selected?.type === "playbook" ? draftPlaybook : null;
  const selectedAsset = selected?.type === "asset" ? draftAsset : null;

  if (!canManage)
    return (
      <div className="intel-empty">
        <ShieldCheck size={24} />
        <h2>Administrator access required</h2>
        <p>
          Only workspace owners and admins can configure organization
          intelligence.
        </p>
      </div>
    );
  return (
    <div className="intel">
      <div className="intel-title">
        <div>
          <span className="intel-kicker">
            ORGANIZATION · IMPLEMENTATION INTELLIGENCE
          </span>
          <h1>Teach the OS how your team delivers.</h1>
          <p>
            One trusted library for methodology, documents, standards and AI
            guidance.
          </p>
        </div>
        <span className="intel-local">
          <ShieldCheck size={14} /> Workspace private
        </span>
      </div>
      <div className="intel-layout">
        <nav
          className="intel-nav"
          aria-label="Implementation intelligence sections"
        >
          <span className="intel-nav-heading">LIBRARY</span>
          {sections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={section === id ? "active" : ""}
              disabled={bulkBusy}
              onClick={() => navigate(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
              <ChevronRight size={13} />
            </button>
          ))}
          <div className="intel-nav-note">
            <Sparkles size={17} />
            <strong>Human-approved by design</strong>
            <p>
              Drafts stay private to this workspace until an admin publishes a
              version.
            </p>
          </div>
        </nav>
        <div className="intel-content">
          {error && (
            <div className="intel-alert error" role="alert">
              {error}
              <button onClick={() => setError("")}>Dismiss</button>
            </div>
          )}
          {notice && (
            <div className="intel-alert success" role="status">
              <Check size={15} />
              {notice}
            </div>
          )}
          {busy ? (
            <div className="intel-empty">
              <Loader2 className="spin" size={22} />
              Loading your library…
            </div>
          ) : bulkKind ? (
            <BulkUpload
              defaultKind={bulkKind}
              existing={assets}
              onClose={() => setBulkKind(null)}
              onComplete={async () => { await refresh(); }}
              onBusyChange={setBulkBusy}
            />
          ) : creating ? (
            <>
              <button
                className="intel-back"
                onClick={() => {
                  setCreating(null);
                  setNewName("");
                }}
              >
                <ArrowLeft size={15} /> Back to library
              </button>
              <div className="intel-head">
                <div>
                  <span className="intel-kicker">NEW DRAFT</span>
                  <h2>
                    {creating === "PLAYBOOK"
                      ? "Create an implementation playbook"
                      : `Add ${creating.toLowerCase().replaceAll("_", " ")}`}
                  </h2>
                  <p>
                    Begin with a name. You can build and review the content
                    before publishing it.
                  </p>
                </div>
              </div>
              <form
                className="intel-create-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  creating === "PLAYBOOK"
                    ? createPlaybook()
                    : createAsset(creating);
                }}
              >
                <label>
                  Name
                  <input
                    autoFocus
                    required
                    minLength={2}
                    maxLength={160}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={
                      creating === "PLAYBOOK"
                        ? "e.g. Enterprise implementation"
                        : "Give this knowledge a clear name"
                    }
                  />
                </label>
                <div>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setCreating(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="button primary"
                    disabled={saving || newName.trim().length < 2}
                  >
                    {saving ? (
                      <Loader2 className="spin" size={15} />
                    ) : (
                      <Plus size={15} />
                    )}{" "}
                    Create draft
                  </button>
                </div>
              </form>
            </>
          ) : section === "overview" ? (
            <>
              <div className="intel-head">
                <div>
                  <span className="intel-kicker">
                    YOUR ORGANIZATION'S METHOD
                  </span>
                  <h2>Implementation intelligence</h2>
                  <p>
                    Start with a playbook, then add the source material and
                    rules that guide delivery.
                  </p>
                </div>
                <div className="intel-actions">
                  <button className="button" onClick={() => setBulkKind("DOCUMENT")}><UploadCloud size={15} /> Bulk upload</button>
                  <button className="button primary" onClick={() => setCreating("PLAYBOOK")}><Plus size={15} /> New playbook</button>
                </div>
              </div>
              <div className="intel-stats">
                <div>
                  <span>Published playbooks</span>
                  <strong>{published}</strong>
                  <small>available at project creation</small>
                </div>
                <div>
                  <span>Published library items</span>
                  <strong>{publishedAssets.length}</strong>
                  <small>trusted organization context</small>
                </div>
                <div>
                  <span>Needs review</span>
                  <strong>
                    {playbooks.filter((p) => !p.published_version).length +
                      assets.filter((a) => !a.published_version).length}
                  </strong>
                  <small>drafts not yet active</small>
                </div>
              </div>
              <div className="intel-coverage">
                <div className="intel-coverage-head">
                  <div>
                    <span className="intel-kicker">KNOWLEDGE COVERAGE</span>
                    <h3>{coverageCount} of {coverage.length} foundations in place</h3>
                    <p>Based on published material only. Coverage does not imply AI has reviewed its quality.</p>
                  </div>
                  <strong>{Math.round((coverageCount / coverage.length) * 100)}%</strong>
                </div>
                <div className="intel-coverage-track" role="progressbar" aria-valuenow={coverageCount} aria-valuemin={0} aria-valuemax={coverage.length} aria-label="Knowledge coverage"><span style={{ width: `${(coverageCount / coverage.length) * 100}%` }} /></div>
                <div className="intel-coverage-items">
                  {coverage.map((item) => <button key={item.label} onClick={() => navigate(item.section)} className={item.ready ? "ready" : "missing"}>
                    {item.ready ? <Check size={13} /> : <Plus size={13} />}
                    {item.label}
                    <ArrowRight size={13} />
                  </button>)}
                </div>
              </div>
              <div className="intel-section-label">
                BUILD YOUR KNOWLEDGE BASE
              </div>
              <div className="intel-start-grid">
                {[
                  {
                    id: "playbooks" as Section,
                    icon: ClipboardList,
                    title: "Map your methodology",
                    text: "Create stages, delivery tasks and milestones.",
                  },
                  {
                    id: "templates" as Section,
                    icon: FileText,
                    title: "Shape your documents",
                    text: "Keep BRD, UAT and other formats consistent.",
                  },
                  {
                    id: "standards" as Section,
                    icon: ShieldCheck,
                    title: "Set delivery standards",
                    text: "Define what must be checked and approved.",
                  },
                  {
                    id: "instructions" as Section,
                    icon: Sparkles,
                    title: "Guide AI drafts",
                    text: "Document your preferred voice and rules.",
                  },
                ].map(({ id, icon: Icon, title, text }) => (
                  <button key={id} onClick={() => navigate(id)}>
                    <span className="intel-start-icon">
                      <Icon size={18} />
                    </span>
                    <strong>{title}</strong>
                    <small>{text}</small>
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
              <div className="intel-section-label">RECENTLY UPDATED</div>
              <div className="intel-list">
                {[
                  ...playbooks.map((p) => ({
                    ...p,
                    type: "playbook" as const,
                  })),
                  ...assets.map((a) => ({ ...a, type: "asset" as const })),
                ]
                  .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
                  .slice(0, 6)
                  .map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        navigate(
                          item.type === "playbook"
                            ? "playbooks"
                            : (
                                {
                                  TEMPLATE: "templates",
                                  DOCUMENT: "documents",
                                  STANDARD: "standards",
                                  AI_INSTRUCTION: "instructions",
                                  KNOWLEDGE_SOURCE: "sources",
                                } as Record<string, Section>
                              )[(item as Asset).kind],
                        );
                        item.type === "playbook"
                          ? openPlaybook(item as Playbook)
                          : openAsset(item as Asset);
                      }}
                    >
                      <span className="intel-list-icon">
                        {item.type === "playbook" ? (
                          <ClipboardList size={17} />
                        ) : (
                          <BookOpen size={17} />
                        )}
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.type === "playbook"
                            ? "Playbook"
                            : (item as Asset).kind.replaceAll("_", " ")}{" "}
                          · Updated {date(item.updated_at)}
                        </small>
                      </span>
                      <em className={item.status.toLowerCase()}>
                        {item.status.toLowerCase()}
                      </em>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                {!playbooks.length && !assets.length && (
                  <div className="intel-empty">
                    <LibraryBig size={25} />
                    <h3>Your library starts here</h3>
                    <p>
                      Create the first playbook to turn your methodology into a
                      repeatable implementation plan.
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : selectedPlaybook ? (
            <>
              <button
                className="intel-back"
                onClick={() => {
                  setSelected(null);
                  setVersions([]);
                }}
              >
                <ArrowLeft size={15} /> All playbooks
              </button>
              <div className="intel-head">
                <div>
                  <span className="intel-kicker">
                    PLAYBOOK EDITOR · {selectedPlaybook.status}
                  </span>
                  <h2>{selectedPlaybook.name}</h2>
                  <p>
                    Published v{selectedPlaybook.published_version || "—"} ·
                    Edits stay in draft until you publish again.
                  </p>
                </div>
                <div className="intel-actions">
                  <button
                    className="button"
                    onClick={() =>
                      showVersions("playbook", selectedPlaybook.id)
                    }
                  >
                    <History size={15} /> Versions
                  </button>
                  <button
                    className="button"
                    disabled={saving || !dirty}
                    onClick={() => savePlaybook()}
                  >
                    {saving ? (
                      <Loader2 className="spin" size={15} />
                    ) : (
                      <Check size={15} />
                    )}{" "}
                    Save draft
                  </button>
                  <button
                    className="button primary"
                    disabled={saving}
                    onClick={() => savePlaybook(true)}
                  >
                    Publish version <ArrowRight size={15} />
                  </button>
                </div>
              </div>
              <div className="intel-editor-meta">
                <label>
                  Playbook name
                  <input
                    value={selectedPlaybook.name}
                    onChange={(e) =>
                      changePlaybook({
                        ...selectedPlaybook,
                        name: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Implementation type
                  <input
                    value={selectedPlaybook.implementation_type}
                    onChange={(e) =>
                      changePlaybook({
                        ...selectedPlaybook,
                        implementation_type: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="wide">
                  When should this playbook be used?
                  <textarea
                    rows={2}
                    value={selectedPlaybook.description}
                    onChange={(e) =>
                      changePlaybook({
                        ...selectedPlaybook,
                        description: e.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <div className="intel-subhead">
                <div>
                  <h3>Delivery stages</h3>
                  <p>
                    Projects created from a published version inherit these
                    stages, tasks and milestones.
                  </p>
                </div>
                <button
                  className="button"
                  onClick={() =>
                    changePlaybook({
                      ...selectedPlaybook,
                      draft_snapshot: {
                        stages: [
                          ...selectedPlaybook.draft_snapshot.stages,
                          emptyStage(
                            selectedPlaybook.draft_snapshot.stages.length,
                          ),
                        ],
                      },
                    })
                  }
                >
                  <Plus size={15} /> Add stage
                </button>
              </div>
              <div className="intel-stage-list">
                {selectedPlaybook.draft_snapshot.stages.map((stage, index) => {
                  const replace = (next: Stage) =>
                    changePlaybook({
                      ...selectedPlaybook,
                      draft_snapshot: {
                        stages: selectedPlaybook.draft_snapshot.stages.map(
                          (s, i) => (i === index ? next : s),
                        ),
                      },
                    });
                  return (
                    <section className="intel-stage" key={index}>
                      <div className="intel-stage-number">
                        {String(index + 1).padStart(2, "0")}
                      </div>
                      <div className="intel-stage-body">
                        <div className="intel-stage-top">
                          <input
                            aria-label={`Stage ${index + 1} name`}
                            value={stage.name}
                            placeholder="Stage name · e.g. Discovery"
                            onChange={(e) =>
                              replace({
                                ...stage,
                                name: e.target.value,
                                key: slug(e.target.value, index),
                              })
                            }
                          />
                          <button
                            aria-label="Remove stage"
                            title="Remove stage"
                            onClick={() =>
                              changePlaybook({
                                ...selectedPlaybook,
                                draft_snapshot: {
                                  stages:
                                    selectedPlaybook.draft_snapshot.stages.filter(
                                      (_, i) => i !== index,
                                    ),
                                },
                              })
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                        <input
                          className="intel-stage-description"
                          aria-label={`Stage ${index + 1} purpose`}
                          value={stage.description}
                          placeholder="Purpose of this stage"
                          onChange={(e) =>
                            replace({ ...stage, description: e.target.value })
                          }
                        />
                        <div className="intel-stage-criteria">
                          <input
                            aria-label={`Stage ${index + 1} entry criteria`}
                            value={stage.entry_criteria ?? ""}
                            placeholder="Entry criteria"
                            onChange={(e) =>
                              replace({
                                ...stage,
                                entry_criteria: e.target.value,
                              })
                            }
                          />
                          <input
                            aria-label={`Stage ${index + 1} exit criteria`}
                            value={stage.exit_criteria ?? ""}
                            placeholder="Exit criteria"
                            onChange={(e) =>
                              replace({
                                ...stage,
                                exit_criteria: e.target.value,
                              })
                            }
                          />
                          <input
                            aria-label={`Stage ${index + 1} duration in days`}
                            type="number"
                            min={1}
                            max={365}
                            value={stage.duration_days ?? ""}
                            placeholder="Days"
                            onChange={(e) =>
                              replace({
                                ...stage,
                                duration_days: e.target.value
                                  ? Number(e.target.value)
                                  : null,
                              })
                            }
                          />
                          <label>
                            <input
                              type="checkbox"
                              checked={!!stage.approval_required}
                              onChange={(e) =>
                                replace({
                                  ...stage,
                                  approval_required: e.target.checked,
                                })
                              }
                            />{" "}
                            Approval gate
                          </label>
                        </div>
                        <div className="intel-stage-columns">
                          <div>
                            <div className="intel-mini-title">
                              TASKS{" "}
                              <button
                                onClick={() =>
                                  replace({
                                    ...stage,
                                    tasks: [
                                      ...stage.tasks,
                                      {
                                        title: "",
                                        description: "",
                                        priority: "MEDIUM",
                                      },
                                    ],
                                  })
                                }
                              >
                                <Plus size={13} /> Add
                              </button>
                            </div>
                            {stage.tasks.map((task, ti) => (
                              <div className="intel-mini-card" key={ti}>
                                <div className="intel-mini-row">
                                  <input
                                    aria-label={`Task ${ti + 1} title`}
                                    value={task.title}
                                    placeholder="Task title"
                                    onChange={(e) =>
                                      replace({
                                        ...stage,
                                        tasks: stage.tasks.map((t, i) =>
                                          i === ti
                                            ? { ...t, title: e.target.value }
                                            : t,
                                        ),
                                      })
                                    }
                                  />
                                  <button
                                    aria-label="Remove task"
                                    onClick={() =>
                                      replace({
                                        ...stage,
                                        tasks: stage.tasks.filter(
                                          (_, i) => i !== ti,
                                        ),
                                      })
                                    }
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                                <div className="intel-mini-details">
                                  <input
                                    aria-label={`Task ${ti + 1} description`}
                                    value={task.description}
                                    placeholder="Description"
                                    onChange={(e) =>
                                      replace({
                                        ...stage,
                                        tasks: stage.tasks.map((t, i) =>
                                          i === ti
                                            ? {
                                                ...t,
                                                description: e.target.value,
                                              }
                                            : t,
                                        ),
                                      })
                                    }
                                  />
                                  <select
                                    aria-label={`Task ${ti + 1} priority`}
                                    value={task.priority}
                                    onChange={(e) =>
                                      replace({
                                        ...stage,
                                        tasks: stage.tasks.map((t, i) =>
                                          i === ti
                                            ? {
                                                ...t,
                                                priority: e.target
                                                  .value as Stage["tasks"][number]["priority"],
                                              }
                                            : t,
                                        ),
                                      })
                                    }
                                  >
                                    <option value="LOW">Low</option>
                                    <option value="MEDIUM">Medium</option>
                                    <option value="HIGH">High</option>
                                    <option value="CRITICAL">Critical</option>
                                  </select>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div>
                            <div className="intel-mini-title">
                              MILESTONES{" "}
                              <button
                                onClick={() =>
                                  replace({
                                    ...stage,
                                    milestones: [
                                      ...stage.milestones,
                                      { name: "", description: "" },
                                    ],
                                  })
                                }
                              >
                                <Plus size={13} /> Add
                              </button>
                            </div>
                            {stage.milestones.map((m, mi) => (
                              <div className="intel-mini-card" key={mi}>
                                <div className="intel-mini-row">
                                  <input
                                    aria-label={`Milestone ${mi + 1} name`}
                                    value={m.name}
                                    placeholder="Milestone name"
                                    onChange={(e) =>
                                      replace({
                                        ...stage,
                                        milestones: stage.milestones.map(
                                          (x, i) =>
                                            i === mi
                                              ? { ...x, name: e.target.value }
                                              : x,
                                        ),
                                      })
                                    }
                                  />
                                  <button
                                    aria-label="Remove milestone"
                                    onClick={() =>
                                      replace({
                                        ...stage,
                                        milestones: stage.milestones.filter(
                                          (_, i) => i !== mi,
                                        ),
                                      })
                                    }
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                </div>
                                <input
                                  className="intel-mini-description"
                                  aria-label={`Milestone ${mi + 1} description`}
                                  value={m.description}
                                  placeholder="Completion criteria"
                                  onChange={(e) =>
                                    replace({
                                      ...stage,
                                      milestones: stage.milestones.map(
                                        (x, i) =>
                                          i === mi
                                            ? {
                                                ...x,
                                                description: e.target.value,
                                              }
                                            : x,
                                      ),
                                    })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </section>
                  );
                })}
                {!selectedPlaybook.draft_snapshot.stages.length && (
                  <div className="intel-empty">
                    <Layers3 size={25} />
                    <h3>Build your first stage</h3>
                    <p>
                      Start with kickoff or discovery. Add only the tasks your
                      team consistently performs.
                    </p>
                  </div>
                )}
              </div>
              {versionFor === selectedPlaybook.id && (
                <VersionList versions={versions} />
              )}
            </>
          ) : selectedAsset ? (
            <>
              <button
                className="intel-back"
                onClick={() => {
                  setSelected(null);
                  setVersions([]);
                }}
              >
                <ArrowLeft size={15} /> Back to library
              </button>
              <div className="intel-head">
                <div>
                  <span className="intel-kicker">
                    {selectedAsset.kind.replaceAll("_", " ")} ·{" "}
                    {selectedAsset.status}
                  </span>
                  <h2>{selectedAsset.name}</h2>
                  <p>
                    Published v{selectedAsset.published_version || "—"} · Edits
                    stay in draft until published.
                  </p>
                </div>
                <div className="intel-actions">
                  <button
                    className="button"
                    onClick={() => showVersions("asset", selectedAsset.id)}
                  >
                    <History size={15} /> Versions
                  </button>
                  <button
                    className="button"
                    disabled={saving || !dirty}
                    onClick={() => saveAsset()}
                  >
                    <Check size={15} /> Save draft
                  </button>
                  <button
                    className="button primary"
                    disabled={saving}
                    onClick={() => saveAsset(true)}
                  >
                    Publish version <ArrowRight size={15} />
                  </button>
                </div>
              </div>
              <div className="intel-editor-meta">
                <label>
                  Name
                  <input
                    value={selectedAsset.name}
                    onChange={(e) =>
                      changeAsset({ ...selectedAsset, name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Authority
                  <select
                    value={selectedAsset.authority}
                    onChange={(e) =>
                      changeAsset({
                        ...selectedAsset,
                        authority: e.target.value,
                      })
                    }
                  >
                    <option value="REFERENCE">Reference</option>
                    <option value="APPROVED">Approved guidance</option>
                    <option value="POLICY">Organization policy</option>
                  </select>
                </label>
                <label className="wide">
                  Description
                  <textarea
                    rows={2}
                    value={selectedAsset.description}
                    onChange={(e) =>
                      changeAsset({
                        ...selectedAsset,
                        description: e.target.value,
                      })
                    }
                  />
                </label>
                {selectedAsset.kind === "TEMPLATE" && (
                  <label>
                    Document type
                    <input
                      value={selectedAsset.document_type ?? ""}
                      placeholder="e.g. BRD"
                      onChange={(e) =>
                        changeAsset({
                          ...selectedAsset,
                          document_type: e.target.value,
                        })
                      }
                    />
                  </label>
                )}
                {selectedAsset.kind === "KNOWLEDGE_SOURCE" && (
                  <label>
                    Source URL
                    <input
                      type="url"
                      value={selectedAsset.source_url ?? ""}
                      placeholder="https://…"
                      onChange={(e) =>
                        changeAsset({
                          ...selectedAsset,
                          source_url: e.target.value || null,
                        })
                      }
                    />
                  </label>
                )}
              </div>
              {selectedAsset.kind === "AI_INSTRUCTION" && (
                <div className="intel-alert info">
                  <ShieldCheck size={15} /> Stored in your workspace only. These
                  instructions are not yet sent to or applied by the external AI
                  provider.
                </div>
              )}
              <div className="intel-subhead">
                <div>
                  <h3>
                    {selectedAsset.kind === "TEMPLATE"
                      ? "Document structure"
                      : "Knowledge content"}
                  </h3>
                  <p>
                    Write directly or import PDF, Word, Excel, CSV and text files. Review extracted content before publishing.
                  </p>
                </div>
                <span className="intel-wordcount">
                  {selectedAsset.content.length.toLocaleString()} characters
                </span>
              </div>
              <label className="intel-import">
                <UploadCloud size={15} /> Import file
                <input
                  type="file"
                  accept={IMPORT_ACCEPT}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    try {
                      changeAsset({
                        ...selectedAsset,
                        content: await extractImportFile(file, { format: "markdown", maxChars: 200_000 }),
                      });
                      setNotice(
                        `${file.name} loaded into your draft. Review and save before publishing.`,
                      );
                    } catch (error) {
                      setError(error instanceof Error ? error.message : `The file could not be read. Supported: ${IMPORT_FORMATS}.`);
                    }
                  }}
                />
              </label>
              <textarea
                className="intel-content-editor"
                aria-label="Knowledge content"
                value={selectedAsset.content}
                onChange={(e) =>
                  changeAsset({ ...selectedAsset, content: e.target.value })
                }
                placeholder={
                  selectedAsset.kind === "TEMPLATE"
                    ? "# Document title\n\n## 1. Executive summary\n\n[Content to prepare and review]"
                    : "Write the authoritative guidance your implementation team follows…"
                }
              />
              {versionFor === selectedAsset.id && (
                <VersionList versions={versions} />
              )}
            </>
          ) : section === "playbooks" ? (
            <>
              <div className="intel-head">
                <div>
                  <span className="intel-kicker">DELIVERY METHOD</span>
                  <h2>Implementation playbooks</h2>
                  <p>
                    Design once. Launch each new project from a reviewed
                    version.
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setCreating("PLAYBOOK")}
                >
                  <Plus size={15} /> New playbook
                </button>
              </div>
              <div className="intel-list">
                {activePlaybooks.map((p) => (
                  <button key={p.id} onClick={() => openPlaybook(p)}>
                    <span className="intel-list-icon">
                      <ClipboardList size={18} />
                    </span>
                    <span>
                      <strong>{p.name}</strong>
                      <small>
                        {p.draft_snapshot.stages.length} stages ·{" "}
                        {p.draft_snapshot.stages.reduce(
                          (n, s) => n + s.tasks.length,
                          0,
                        )}{" "}
                        tasks · Updated {date(p.updated_at)}
                      </small>
                    </span>
                    <em className={p.status.toLowerCase()}>
                      {p.status === "PUBLISHED"
                        ? `v${p.published_version} published`
                        : "draft"}
                    </em>
                    <ChevronRight size={15} />
                  </button>
                ))}
                {!activePlaybooks.length && (
                  <div className="intel-empty">
                    <ClipboardList size={25} />
                    <h3>No playbooks yet</h3>
                    <p>
                      Capture the stages your team repeats, then publish one to
                      use at project creation.
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : section === "versions" ? (
            <>
              <div className="intel-head">
                <div>
                  <span className="intel-kicker">AUDITABLE KNOWLEDGE</span>
                  <h2>Version history</h2>
                  <p>
                    Published versions are immutable. Open an item to inspect
                    its exact snapshot.
                  </p>
                </div>
              </div>
              <div className="intel-list">
                {[
                  ...playbooks
                    .filter((p) => p.published_version)
                    .map((p) => ({ ...p, type: "playbook" as const })),
                  ...assets
                    .filter((a) => a.published_version)
                    .map((a) => ({ ...a, type: "asset" as const })),
                ]
                  .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
                  .map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSection(
                          item.type === "playbook"
                            ? "playbooks"
                            : (
                                {
                                  TEMPLATE: "templates",
                                  DOCUMENT: "documents",
                                  STANDARD: "standards",
                                  AI_INSTRUCTION: "instructions",
                                  KNOWLEDGE_SOURCE: "sources",
                                } as Record<string, Section>
                              )[(item as Asset).kind],
                        );
                        item.type === "playbook"
                          ? openPlaybook(item as Playbook)
                          : openAsset(item as Asset);
                        showVersions(item.type, item.id);
                      }}
                    >
                      <span className="intel-list-icon">
                        <History size={17} />
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          Published version {item.published_version} · Updated{" "}
                          {date(item.updated_at)}
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                {!published && !publishedAssets.length && (
                  <div className="intel-empty">No published versions yet.</div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="intel-head">
                <div>
                  <span className="intel-kicker">ORGANIZATION LIBRARY</span>
                  <h2>{sections.find((s) => s.id === section)?.label}</h2>
                  <p>
                    {section === "sources"
                      ? "Store source text and provenance for human review."
                      : "Keep your team's approved knowledge in one versioned place."}
                  </p>
                </div>
                <div className="intel-actions">
                  <button className="button" onClick={() => setBulkKind(kindFor[section] as AssetKind)}><UploadCloud size={15} /> Bulk upload</button>
                  <button className="button primary" onClick={() => setCreating(kindFor[section]!)}><Plus size={15} /> Add {section === "sources" ? "source" : "item"}</button>
                </div>
              </div>
              {section === "instructions" && (
                <div className="intel-alert info">
                  <ShieldCheck size={15} /> AI instructions are stored and
                  versioned here, but are not yet applied to generation or sent
                  to the AI provider.
                </div>
              )}
              <div className="intel-list">
                {filteredAssets.map((a) => (
                  <button key={a.id} onClick={() => openAsset(a)}>
                    <span className="intel-list-icon">
                      <BookOpen size={17} />
                    </span>
                    <span>
                      <strong>{a.name}</strong>
                      <small>
                        {a.authority.toLowerCase()} · Updated{" "}
                        {date(a.updated_at)}
                        {a.document_type ? ` · ${a.document_type}` : ""}
                      </small>
                    </span>
                    <em className={a.status.toLowerCase()}>
                      {a.status === "PUBLISHED"
                        ? `v${a.published_version} published`
                        : "draft"}
                    </em>
                    <ChevronRight size={15} />
                  </button>
                ))}
                {!filteredAssets.length && (
                  <div className="intel-empty">
                    <BookOpen size={25} />
                    <h3>Nothing here yet</h3>
                    <p>
                      Add a draft, review its authority, and publish when your
                      team is ready to rely on it.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function VersionList({ versions }: { versions: any[] }) {
  const [expanded, setExpanded] = useState("");
  return (
    <section className="intel-versions">
      <div className="intel-subhead">
        <div>
          <h3>Published history</h3>
          <p>Earlier implementations keep the version they started with.</p>
        </div>
      </div>
      {versions.map((v) => (
        <div key={v.id}>
          <button onClick={() => setExpanded(expanded === v.id ? "" : v.id)}>
            <History size={15} />
            <strong>Version {v.version}</strong>
            <span>{date(v.created_at)}</span>
            <ChevronRight size={15} />
          </button>
          {expanded === v.id && (
            <div className="intel-version-detail">
              <strong>{v.snapshot.name ?? "Published snapshot"}</strong>
              {v.snapshot.description && <p>{v.snapshot.description}</p>}
              {Array.isArray(v.snapshot.stages) ? (
                <ol>
                  {v.snapshot.stages.map((stage: Stage, i: number) => (
                    <li key={`${stage.key}-${i}`}>
                      <span>{stage.name}</span>
                      <small>
                        {stage.tasks?.length ?? 0} tasks ·{" "}
                        {stage.milestones?.length ?? 0} milestones
                        {stage.approval_required ? " · approval gate" : ""}
                      </small>
                    </li>
                  ))}
                </ol>
              ) : (
                <>
                  <small>
                    {v.snapshot.kind?.replaceAll("_", " ")} ·{" "}
                    {v.snapshot.authority?.toLowerCase()}
                  </small>
                  <div className="intel-version-content">
                    {v.snapshot.content}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {versions.length === 0 && <p>No published version yet.</p>}
    </section>
  );
}
