import React, {
  useEffect,
  useState,
  useRef,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  Clock3,
  FileText,
  Flag,
  FolderKanban,
  GitBranch,
  Layers3,
  LayoutDashboard,
  Link2,
  ListTodo,
  Loader2,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Unplug,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import { api, configureAuth, getAuth, selectWorkspace } from "./api";
import { CommandCenter } from "./command-center";
import { Documents } from "./documents";
import { Autopilot } from "./autopilot";
import { Schedule } from "./schedule";
import { IntelligenceLibrary } from "./intelligence";
import { PlanWorkspace } from "./plan-workspace";
import "./styles.css";
import "./workspace-design.css";
import "./command-center.css";

type RecordData = Record<string, any>;
type View =
  | "overview"
  | "implementations"
  | "tasks"
  | "schedule"
  | "knowledge"
  | "integrations"
  | "settings"
  | "create"
  | "detail";
const label = (v: string | undefined) =>
  v
    ? v
        .toLowerCase()
        .replaceAll("_", " ")
        .replace(/^./, (c) => c.toUpperCase())
    : "Not assessed";
const formatDate = (v: string | undefined) =>
  v
    ? new Date(v.slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      })
    : "Not set";
const initials = (v: string) =>
  v
    .split(" ")
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();
function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-icon">
        <Layers3 size={small ? 18 : 22} />
      </span>
      {!small && (
        <span>
          AI Implementation <strong>OS</strong>
        </span>
      )}
    </span>
  );
}
function Badge({ value }: { value: string }) {
  return (
    <span className={`badge ${value?.toLowerCase()}`}>
      <i />
      {label(value)}
    </span>
  );
}
function Empty({
  icon: Icon = FolderKanban,
  title,
  children,
}: {
  icon?: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={22} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Loading() {
  return (
    <div className="loading" role="status" aria-label="Loading workspace">
      <div className="skeleton wide" />
      <div className="skeleton short" />
      <div className="skeleton panel" />
      <div className="skeleton panel" />
    </div>
  );
}
function Panel({
  title,
  icon: Icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-heading">
        <h2>
          {Icon && <Icon size={17} />} {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}
function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="drawer"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-label={title}
    >
      <div className="drawer-top">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close panel"
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function App() {
  const [config, setConfig] = useState<RecordData | null>(null),
    [workspace, setWorkspace] = useState<RecordData | null>(null),
    [context, setContext] = useState<RecordData | null>(null),
    [authNeeded, setAuthNeeded] = useState(false),
    [onboarding, setOnboarding] = useState(false);
  const [view, setView] = useState<View>("overview"),
    [selected, setSelected] = useState<string | null>(null),
    [data, setData] = useState<any>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0),
    [mobile, setMobile] = useState(false),
    [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<any[] | null>(null),
    [searchBusy, setSearchBusy] = useState(false),
    [searchError, setSearchError] = useState("");
  const [evidence, setEvidence] = useState(false),
    [composer, setComposer] = useState<"tasks" | "stages" | null>(null),
    [tab, setTab] = useState("Overview"),
    [focusDocumentId, setFocusDocumentId] = useState(""),
    [stageFilter, setStageFilter] = useState(""),
    [notice, setNotice] = useState(""),
    [filter, setFilter] = useState("All implementations"),
    [taskBusy, setTaskBusy] = useState<string | null>(null);
  async function initialize() {
    setBusy(true);
    setError("");
    try {
      const c = await api("config");
      setConfig(c);
      if (!c.demo) {
        if (!c.auth_configured) {
          setAuthNeeded(true);
          setBusy(false);
          return;
        }
        if (!getAuth()) configureAuth(c.supabase_url, c.publishable_key);
        if (!(await getAuth()!.auth.getSession()).data.session) {
          setAuthNeeded(true);
          setBusy(false);
          return;
        }
      }
      const ws = await api<RecordData[]>("workspaces");
      if (!ws.length) {
        setOnboarding(true);
        setBusy(false);
        return;
      }
      selectWorkspace(ws[0].id);
      setWorkspace(ws[0]);
      setContext(await api("context"));
      setAuthNeeded(false);
      setOnboarding(false);
      setVersion((v) => v + 1);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }
  useEffect(() => {
    initialize();
  }, []);
  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setData(null);
    const path =
      view === "detail"
        ? `implementations/${selected}/overview`
        : view === "tasks"
          ? "tasks?limit=100"
          : view === "knowledge"
            ? "documents?limit=100"
            : view === "settings"
              ? "members"
              : view === "create"
                ? "companies?limit=100"
                : view === "integrations" || view === "schedule"
                  ? null
                  : "portfolio";
    if (!path) {
      setBusy(false);
      return;
    }
    api(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [workspace, view, selected, version]);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [view, selected]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const go = (next: View) => {
    if (next !== view) {
      setBusy(true);
      setData(null);
    }
    setView(next);
    setMobile(false);
    setEvidence(false);
    setNotice("");
    setFilter("All implementations");
  };
  const open = (id: string) => {
    if (id !== selected) {
      setBusy(true);
      setData(null);
    }
    setSelected(id);
    setTab("Overview");
    setStageFilter("");
    go("detail");
  };
  async function completeTask(id: string, status: string) {
    setTaskBusy(id);
    setError("");
    try {
      await api(`tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: status === "COMPLETED" ? "IN_PROGRESS" : "COMPLETED",
        }),
      });
      setVersion((v) => v + 1);
      setNotice("Task updated. Activity and audit history recorded.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTaskBusy(null);
    }
  }
  async function search(e: FormEvent) {
    e.preventDefault();
    setSearchBusy(true);
    setSearchError("");
    try {
      setResults(await api(`search?q=${encodeURIComponent(query)}`));
    } catch (e: any) {
      setSearchError(e.message);
    } finally {
      setSearchBusy(false);
    }
  }
  if (authNeeded) return <Login config={config} onReady={initialize} />;
  if (onboarding) return <Onboarding onReady={initialize} />;
  if (!workspace)
    return (
      <main className="startup">
        <Logo />
        {error ? (
          <div className="error" role="alert">
            {error}
            <button onClick={initialize}>Try again</button>
          </div>
        ) : (
          <Loading />
        )}
      </main>
    );
  const navItems: [View, string, LucideIcon][] = [
    ["overview", "Command center", LayoutDashboard],
    ["implementations", "Implementations", FolderKanban],
    ["tasks", "Tasks", ListTodo],
    ["schedule", "Schedule", CalendarDays],
    ["knowledge", "Documents", FileText],
  ];
  const taskStage = data?.stages?.find((stage: RecordData) => stage.id === stageFilter);
  const visibleTasks = stageFilter
    ? (data?.tasks ?? []).filter((task: RecordData) => task.stage_id === stageFilter)
    : data?.tasks ?? [];
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      {mobile && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        />
      )}
      <aside
        id="catalog-navigation"
        className={`sidebar ${mobile ? "is-open" : ""}`}
        aria-label="Workspace catalog"
        hidden={!mobile}
      >
        <div className="sidebar-brand">
          <Logo />
        </div>
        <div className="workspace-selector">
          <span className="workspace-avatar">A</span>
          <span>
            {workspace.name}
            <small>Implementation workspace</small>
          </span>
          <ChevronsUpDown size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navItems.map(([key, text, Icon]) => (
            <button
              key={key}
              className={`nav-item ${view === key || (key === "implementations" && ["detail", "create"].includes(view)) ? "active" : ""}`}
              onClick={() => go(key)}
            >
              <Icon size={18} />
              {text}
              {key === "implementations" && (
                <span className="nav-count">{data?.items?.length ?? ""}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="icon-tint">
            <GitBranch size={17} />
          </span>
          <strong>Connected by context.</strong>
          <p>Every decision. Every dependency. One implementation story.</p>
          <button
            onClick={() => {
              go("knowledge");
            }}
          >
            Open documents <ArrowUpRight size={13} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === "integrations" ? "active" : ""}`}
            onClick={() => go("integrations")}
          >
            <Unplug size={18} />
            Integrations
          </button>
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => go("settings")}
          >
            <Settings2 size={18} />
            Workspace settings
          </button>
          <div className="profile">
            <span className="avatar">{config?.demo ? "DE" : "ME"}</span>
            <span>
              {config?.demo ? "Demo operator" : "Your account"}
              <small>{label(context?.role)}</small>
            </span>
            {!config?.demo && (
              <button
                className="icon-button"
                aria-label="Sign out"
                onClick={async () => {
                  await getAuth()?.auth.signOut();
                  location.reload();
                }}
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="topbar">
          <button
            className="brand-home"
            onClick={() => go("overview")}
            aria-label="Implementation OS home"
          >
            <Logo />
          </button>
          <button
            className={`button catalog-trigger ${mobile ? "selected" : ""}`}
            aria-expanded={mobile}
            aria-controls="catalog-navigation"
            onClick={() => setMobile(!mobile)}
          >
            <LayoutDashboard size={16} />
            Catalog
            <ChevronDown size={13} />
          </button>
          <div className="breadcrumbs">
            <span>{workspace.name}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="search-trigger"
              onClick={() => setSearchOpen(true)}
            >
              <Search size={15} />
              <span>Search implementations, tasks, documents…</span>
              <kbd>⌘ K</kbd>
            </button>
            <button
              className="icon-button"
              onClick={() => go("settings")}
              aria-label="Workspace settings"
            >
              <Settings2 size={19} />
            </button>
            <span className="avatar small">{initials(workspace.name)}</span>
          </div>
        </header>
        {config?.demo && (
          <div className="demo-bar">
            <span>
              <i />
              LOCAL DEMO
            </span>
            Sample implementation data · changes stay on this computer
            <span className="demo-right">
              {config.ai_connected ? `${config.ai_provider ?? "AI provider"} connected · no live meeting integrations` : "No live AI or integrations connected"}
            </span>
          </div>
        )}
        <main id="main-content" tabIndex={-1}>
          {notice && (
            <div className="notice" role="status">
              <CheckCircle2 size={16} />
              {notice}
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              <CircleAlert size={17} />
              {error}
              <button onClick={() => setVersion((v) => v + 1)}>Retry</button>
            </div>
          )}
          {busy ? (
            <Loading />
          ) : view === "create" ? (
            <CreateImplementation
              companies={data ?? []}
              onCancel={() => go("implementations")}
              onCreated={open}
            />
          ) : view === "integrations" ? (
            <Integrations />
          ) : view === "settings" ? (
            <WorkspaceSettings
              workspace={workspace}
              context={context}
              members={data ?? []}
            />
          ) : view === "schedule" ? (
            <Schedule
              canWrite={!!context?.permissions.write}
              canManage={!!context?.permissions.manage}
              onOpenImplementation={open}
            />
          ) : view === "detail" && data ? (
            <>
              <div className="backline">
                <button
                  className="text-button"
                  onClick={() => go("implementations")}
                >
                  <ArrowLeft size={14} />
                  All implementations
                </button>
                <span>Updated from workspace records</span>
              </div>
              <div className="page-heading">
                <div className="implementation-heading">
                  <div className="company-avatar large">
                    {data.implementation.name.slice(0, 1)}
                  </div>
                  <div>
                    <div className="eyebrow">CUSTOMER IMPLEMENTATION</div>
                    <h1>{data.implementation.name}</h1>
                    <div className="subtitle-row">
                      <Badge value={data.implementation.status} />
                      <span>
                        {label(data.implementation.implementation_type)}
                      </span>
                      <span className="dot-divider" />
                      <span>
                        <CalendarDays size={13} />
                        Go-live{" "}
                        {formatDate(data.implementation.target_go_live_date)}
                      </span>
                      {data.implementation.playbook_snapshot?.version && <span><Layers3 size={13} /> Playbook v{data.implementation.playbook_snapshot.version}</span>}
                    </div>
                  </div>
                </div>
                <div className="heading-actions">
                  <button className="button" onClick={() => setEvidence(true)}>
                    <GitBranch size={16} />
                    View evidence graph
                  </button>
                  {context?.permissions.write && (
                    <button
                      className="button primary"
                      onClick={() => setComposer("tasks")}
                    >
                      <Plus size={16} />
                      Add task
                    </button>
                  )}
                </div>
              </div>
              <ImplementationJourney
                stages={data.stages}
                currentView={tab}
                onOpenJourney={() => {
                  setTab("Overview");
                  window.setTimeout(() => document.querySelector(".stage-track")?.scrollIntoView({
                    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                    block: "center",
                  }), 0);
                }}
              />
              <div
                className="tabs"
                role="tablist"
                aria-label="Implementation sections"
              >
                {[
                  "Overview",
                  "Schedule",
                  "Autopilot",
                  "Plan",
                  "Tasks",
                  "Requirements",
                  "Documents",
                  "Stakeholders",
                  "Activity",
                ].map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => { setFocusDocumentId(""); setTab(t); }}
                  >
                    {t}
                    {t === "Tasks" && <span>{data.tasks.length}</span>}
                  </button>
                ))}
              </div>
              {tab === "Overview" ? (
                <>
                  <section className="pulse">
                    <div className="pulse-score">
                      <div
                        className={`score-ring ${data.health.health_status.toLowerCase()}`}
                        style={
                          {
                            "--progress": `${data.health.health_score ?? 0}%`,
                          } as React.CSSProperties
                        }
                      >
                        <span>
                          {data.health.health_score ?? "—"}
                          <small>/ 100</small>
                        </span>
                      </div>
                      <div>
                        <div className="eyebrow">IMPLEMENTATION PULSE</div>
                        <h2>
                          {data.health.health_status === "HEALTHY"
                            ? "Moving in the right direction"
                            : data.health.health_status === "UNKNOWN"
                              ? "Ready to build your plan"
                              : "A few things need your attention"}
                        </h2>
                        <p>
                          {data.health.signals.length
                            ? `${data.health.signals.length} evidence-backed signals affecting delivery readiness.`
                            : "Health updates as tasks, milestones and risks are recorded."}
                        </p>
                        <Badge value={data.health.health_status} />
                      </div>
                    </div>
                    <div className="pulse-stats">
                      <div>
                        <span>Task completion</span>
                        <strong>
                          {data.health.completed}
                          <small> / {data.health.total}</small>
                        </strong>
                        <Progress value={data.health.progress} />
                      </div>
                      <div>
                        <span>Target go-live</span>
                        <strong>
                          {formatDate(data.implementation.target_go_live_date)}
                        </strong>
                        <small>Customer-owned milestone</small>
                      </div>
                      <div>
                        <span>Data coverage</span>
                        <strong>
                          {data.health.confidence}
                          <small>%</small>
                        </strong>
                        <small>Rule-based · not an AI prediction</small>
                      </div>
                    </div>
                  </section>
                  <Panel
                    title="Your path to go-live"
                    icon={Flag}
                    action={
                      <span className="heading-actions">
                        <span className="quiet">
                          {
                            data.stages.filter(
                              (s: any) => s.status === "COMPLETED",
                            ).length
                          }{" "}
                          of {data.stages.length} stages complete
                        </span>
                        {context?.permissions.manage && (
                          <button
                            className="text-button"
                            onClick={() => setComposer("stages")}
                          >
                            <Plus size={13} />
                            Add stage
                          </button>
                        )}
                      </span>
                    }
                  >
                    <div className="stage-track">
                      {data.stages.map((s: any) => (
                        <button
                          key={s.id}
                          className={`stage ${s.status.toLowerCase()}`}
                          onClick={() => { setStageFilter(s.id); setTab("Tasks"); }}
                          title={`${s.name}: ${s.progress}% complete`}
                          aria-label={`Open ${s.name} tasks, ${s.progress}% complete`}
                        >
                          <span className="stage-node">
                            {s.status === "COMPLETED" ? (
                              <Check size={14} />
                            ) : s.status === "IN_PROGRESS" ? (
                              <Activity size={14} />
                            ) : (
                              <Circle size={10} />
                            )}
                          </span>
                          <strong>{s.name}</strong>
                          <small>
                            {s.status === "IN_PROGRESS"
                              ? "CURRENT STAGE"
                              : s.status === "COMPLETED"
                                ? "Complete"
                                : `${s.task_count} tasks`}
                          </small>
                        </button>
                      ))}
                    </div>
                  </Panel>
                  <div className="detail-grid">
                    <div className="main-column">
                      <Panel
                        title="What needs to happen next"
                        icon={ListTodo}
                        action={
                          <button
                            className="text-button"
                            onClick={() => setTab("Tasks")}
                          >
                            All tasks <ArrowRight size={13} />
                          </button>
                        }
                      >
                        <TaskList
                          tasks={data.tasks
                            .filter(
                              (t: any) =>
                                !["COMPLETED", "CANCELLED"].includes(t.status),
                            )
                            .sort(
                              (a: any, b: any) =>
                                Number(b.status === "BLOCKED") -
                                Number(a.status === "BLOCKED"),
                            )
                            .slice(0, 5)}
                          canWrite={context?.permissions.write}
                          onComplete={completeTask}
                          pending={taskBusy}
                        />
                      </Panel>
                      <Panel
                        title="Delivery signals"
                        icon={Activity}
                        action={
                          <span className="mini-label">
                            RULE-BASED ANALYSIS
                          </span>
                        }
                      >
                        <div className="signals">
                          {data.health.signals.length ? (
                            data.health.signals.map((s: any) => (
                              <button
                                className="signal-row"
                                key={s.type}
                                onClick={() => setEvidence(true)}
                              >
                                <span
                                  className={`signal-icon ${s.severity.toLowerCase()}`}
                                >
                                  <CircleAlert size={17} />
                                </span>
                                <span>
                                  <strong>{s.title}</strong>
                                  <small>
                                    {s.count} linked{" "}
                                    {s.count === 1 ? "record" : "records"} ·{" "}
                                    {label(s.severity)} priority
                                  </small>
                                </span>
                                <ArrowUpRight size={16} />
                              </button>
                            ))
                          ) : (
                            <Empty title="No delivery signals">
                              Keep the implementation records up to date to
                              reveal emerging risks.
                            </Empty>
                          )}
                        </div>
                      </Panel>
                    </div>
                    <div className="side-column">
                      <Panel
                        title="Implementation intelligence"
                        icon={Sparkles}
                        className="intelligence-panel"
                      >
                        <span className="mini-label iris">
                          EVIDENCE, NOT GUESSWORK
                        </span>
                        <h3>See the story behind the status.</h3>
                        <p>
                          Connect requirements, conversations and delivery work
                          to understand what is changing—and why.
                        </p>
                        <div className="evidence-mini">
                          <MessageSquare size={16} />
                          <ChevronRight size={12} />
                          <FileText size={16} />
                          <ChevronRight size={12} />
                          <ListTodo size={16} />
                          <ChevronRight size={12} />
                          <Flag size={16} />
                        </div>
                        <button
                          className="button full"
                          onClick={() => setEvidence(true)}
                        >
                          Explore {data.evidence.length} source connections{" "}
                          <ArrowRight size={15} />
                        </button>
                        <div className="provider-note">
                          <Circle size={9} />
                          {config?.ai_connected ? `${config.ai_provider ?? "AI provider"} connected` : "AI provider not connected"}
                        </div>
                      </Panel>
                      <Panel
                        title="Latest activity"
                        icon={Clock3}
                        action={
                          <button
                            className="text-button"
                            onClick={() => setTab("Activity")}
                          >
                            View all
                          </button>
                        }
                      >
                        <ActivityList events={data.activity.slice(0, 4)} />
                      </Panel>
                    </div>
                  </div>
                </>
              ) : tab === "Schedule" ? (
                <Schedule
                  canWrite={!!context?.permissions.write}
                  canManage={!!context?.permissions.manage}
                  implementationId={data.implementation.id}
                  onOpenImplementation={open}
                />
              ) : tab === "Autopilot" ? (
                <Autopilot
                  implementation={data.implementation}
                  canWrite={!!context?.permissions.write}
                  canManage={!!context?.permissions.manage}
                  aiConnected={!!config?.ai_connected}
                  aiProvider={config?.ai_provider}
                  onOpenDocuments={(id) => { setFocusDocumentId(id); setTab("Documents"); }}
                  onProjectRecordsChanged={() => setVersion((current) => current + 1)}
                />
              ) : tab === "Plan" ? (
                <PlanWorkspace
                  implementationId={data.implementation.id}
                  implementationName={data.implementation.name}
                  canManage={!!context?.permissions.manage}
                  aiConnected={!!config?.plan_ai_connected}
                  aiProvider={config?.ai_provider}
                  aiPlanModel={config?.ai_plan_model}
                  onProjectRecordsChanged={() => setVersion((current) => current + 1)}
                />
              ) : tab === "Tasks" ? (
                <Panel
                  title={taskStage ? `${taskStage.name} tasks` : "Implementation tasks"}
                  icon={ListTodo}
                  action={
                    <span className="heading-actions">
                      <span className="quiet">{visibleTasks.length}{stageFilter ? " in this stage" : " total"}</span>
                      {stageFilter && <button className="text-button" onClick={() => setStageFilter("")}>All implementation tasks <X size={13} /></button>}
                    </span>
                  }
                >
                  {taskStage && (taskStage.entry_criteria || taskStage.exit_criteria || taskStage.approval_required || taskStage.duration_days) && <div className="stage-brief">
                    <div><span>ENTRY</span><strong>{taskStage.entry_criteria || "Not defined"}</strong></div>
                    <div><span>EXIT</span><strong>{taskStage.exit_criteria || "Not defined"}</strong></div>
                    <div><span>PLAN</span><strong>{taskStage.duration_days ? `${taskStage.duration_days} days` : "No duration"}{taskStage.approval_required ? " · Approval required" : ""}</strong></div>
                  </div>}
                  <TaskList
                    tasks={visibleTasks}
                    canWrite={context?.permissions.write}
                    onComplete={completeTask}
                    pending={taskBusy}
                  />
                </Panel>
              ) : tab === "Requirements" ? (
                <Records
                  title="Requirements"
                  rows={data.requirements}
                  kind="requirements"
                />
              ) : tab === "Documents" ? (
                <Documents
                  records={data.documents ?? []}
                  canWrite={!!context?.permissions.write}
                  canReview={!!context?.permissions.manage}
                  ai={config}
                  implementationId={data.implementation.id}
                  implementationName={data.implementation.name}
                  focusDocumentId={focusDocumentId}
                  onBackToAutopilot={() => { setFocusDocumentId(""); setTab("Autopilot"); }}
                />
              ) : tab === "Stakeholders" ? (
                <Records
                  title="People involved"
                  rows={data.stakeholders}
                  kind="stakeholders"
                />
              ) : (
                <Panel title="Implementation activity">
                  <ActivityList events={data.activity} />
                </Panel>
              )}
            </>
          ) : view === "tasks" ? (
            <>
              <PageTitle
                eyebrow="YOUR DELIVERY WORK"
                title="Tasks"
                text="Keep owners, blockers and next steps clear."
              />
              <Panel title="Workspace tasks" icon={ListTodo}>
                <TaskList
                  tasks={data ?? []}
                  canWrite={context?.permissions.write}
                  onComplete={completeTask}
                  pending={taskBusy}
                />
              </Panel>
              <p className="quiet">Showing up to 100 most recent tasks.</p>
            </>
          ) : view === "knowledge" ? (
            <Documents
              records={data ?? []}
              canWrite={!!context?.permissions.write}
              canReview={!!context?.permissions.manage}
              ai={config}
              onBackToAutopilot={selected ? () => { setTab("Autopilot"); go("detail"); } : undefined}
            />
          ) : view === "overview" && data?.items ? (
            <CommandCenter
              data={data}
              canManage={!!context?.permissions.manage}
              onOpen={open}
              onCreate={() => go("create")}
              onPortfolio={() => go("implementations")}
              onTasks={() => go("tasks")}
              onKnowledge={() => go("knowledge")}
              onIntegrations={() => go("integrations")}
              aiConnected={!!config?.ai_connected}
            />
          ) : data?.items ? (
            <>
              <div className="page-heading">
                <PageTitle
                  eyebrow="WORKSPACE OVERVIEW"
                  title={
                    view === "overview"
                      ? "Every implementation. One clear picture."
                      : "Implementations"
                  }
                  text="Know what’s moving, what needs attention, and what to do next."
                />
                {context?.permissions.manage && (
                  <button
                    className="button primary"
                    onClick={() => go("create")}
                  >
                    <Plus size={17} />
                    New implementation
                  </button>
                )}
              </div>
              <div className="portfolio-stats">
                <div>
                  <span>Active implementations</span>
                  <strong>
                    {data.summary.active}
                    <small>in delivery</small>
                  </strong>
                </div>
                <div>
                  <span>Need attention</span>
                  <strong>
                    {data.summary.attention}
                    <small>
                      <span className="status-dot amber" />
                      Review delivery signals
                    </small>
                  </strong>
                </div>
                <div>
                  <span>Open tasks</span>
                  <strong>
                    {data.summary.open_tasks}
                    <small>across your workspace</small>
                  </strong>
                </div>
                <div>
                  <span>Completed tasks</span>
                  <strong>
                    {data.summary.completed_tasks}
                    <small>
                      <CheckCircle2 size={13} />
                      Progress you can trace
                    </small>
                  </strong>
                </div>
              </div>
              <div className="section-title">
                <div>
                  <h2>
                    Implementation portfolio{" "}
                    <span className="count">{data.items.length}</span>
                  </h2>
                  <p>Your customers’ journey from kickoff to go-live.</p>
                </div>
                <span className="quiet">
                  <CalendarDays size={14} />
                  {new Date().toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              </div>
              <div className="table-panel">
                <div className="table-toolbar">
                  <div className="filter-tabs">
                    {["All implementations", "Needs attention", "Active"].map(
                      (f) => (
                        <button
                          key={f}
                          className={filter === f ? "selected" : ""}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                        </button>
                      ),
                    )}
                  </div>
                  <span className="quiet">
                    Sorted by latest created <ArrowDown size={13} />
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Implementation</th>
                        <th>Health</th>
                        <th>Current stage</th>
                        <th>Progress</th>
                        <th>Go-live</th>
                        <th>Owner</th>
                        <th>
                          <span className="sr-only">Open</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items
                        .filter(
                          (i: any) =>
                            filter === "All implementations" ||
                            (filter === "Active" && i.status === "ACTIVE") ||
                            (filter === "Needs attention" &&
                              ["WATCH", "AT_RISK", "BLOCKED"].includes(
                                i.health.health_status,
                              )),
                        )
                        .map((i: any, index: number) => (
                          <tr key={i.id}>
                            <td>
                              <button
                                className="implementation-link"
                                onClick={() => open(i.id)}
                              >
                                <span
                                  className={`company-avatar tone-${index % 4}`}
                                >
                                  {i.company?.name?.[0] ?? i.name[0]}
                                </span>
                                <span>
                                  <strong>{i.company?.name ?? i.name}</strong>
                                  <small>
                                    {i.name
                                      .replace(i.company?.name ?? "", "")
                                      .trim() || "New implementation"}
                                  </small>
                                </span>
                              </button>
                            </td>
                            <td>
                              <Badge value={i.health.health_status} />
                            </td>
                            <td>
                              <span className="stage-label">
                                {i.current_stage === "UAT" && (
                                  <span className="status-dot iris-dot" />
                                )}
                                {i.current_stage}
                              </span>
                            </td>
                            <td>
                              <div className="table-progress">
                                <Progress value={i.health.progress} />
                                <span>{i.health.progress}%</span>
                              </div>
                            </td>
                            <td>{formatDate(i.target_go_live_date)}</td>
                            <td>
                              <span className="owner-cell">
                                <span className="avatar small">
                                  {initials(
                                    i.metadata?.owner_name ?? "Not assigned",
                                  )}
                                </span>
                                {i.metadata?.owner_name ?? "Unassigned"}
                              </span>
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label={`Open ${i.name}`}
                                onClick={() => open(i.id)}
                              >
                                <ArrowUpRight size={16} />
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {!data.items.length && (
                  <Empty title="Your first implementation starts here">
                    Create a draft and build a plan with clear ownership and
                    source evidence.
                  </Empty>
                )}
              </div>
              <div className="portfolio-bottom">
                <Panel title="Prioritize the next conversation" icon={Flag}>
                  <div className="attention-list">
                    {data.items
                      .filter((i: any) => i.health.signals.length)
                      .slice(0, 3)
                      .map((i: any) => (
                        <button key={i.id} onClick={() => open(i.id)}>
                          <span className="signal-icon medium">
                            <CircleAlert size={17} />
                          </span>
                          <span>
                            <strong>{i.company?.name ?? i.name}</strong>
                            <small>{i.health.signals[0].title}</small>
                          </span>
                          <Badge value={i.health.health_status} />
                          <ArrowRight size={16} />
                        </button>
                      ))}
                    {!data.items.some((i: any) => i.health.signals.length) && (
                      <Empty title="Nothing needs attention yet">
                        Delivery signals appear when there is enough
                        implementation evidence.
                      </Empty>
                    )}
                  </div>
                </Panel>
                <div className="context-callout">
                  <span className="icon-tint">
                    <GitBranch size={22} />
                  </span>
                  <div className="eyebrow">THE IMPLEMENTATION GRAPH</div>
                  <h2>
                    Less searching.
                    <br />
                    More understanding.
                  </h2>
                  <p>
                    Follow a requirement back to the conversation that created
                    it. See how a blocked task affects the next milestone.
                  </p>
                  <button
                    className="text-button"
                    onClick={() =>
                      data.items[0] ? open(data.items[0].id) : go("create")
                    }
                  >
                    Explore an implementation <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </main>
        <footer className="app-footer">
          <span>Implementation OS</span>
          <span>Built around progress. Grounded in evidence.</span>
          <span>Design system v1.0</span>
        </footer>
      </div>
      {searchOpen && (
        <Dialog
          title="Search your workspace"
          onClose={() => setSearchOpen(false)}
        >
          <form className="search-form" onSubmit={search}>
            <Search size={18} />
            <input
              autoFocus
              aria-label="Search query"
              minLength={2}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tasks, requirements, documents…"
            />
            <button className="button primary" disabled={searchBusy}>
              {searchBusy ? <Loader2 size={16} className="spin" /> : "Search"}
            </button>
          </form>
          {searchError && (
            <p role="alert" className="error">
              {searchError}
            </p>
          )}
          <div className="search-results">
            {results?.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  if (r.implementation) open(r.implementation);
                  setSearchOpen(false);
                }}
              >
                <span className="icon-tint">
                  <FileText size={16} />
                </span>
                <span>
                  <small>{label(r.entity)}</small>
                  <strong>{r.title}</strong>
                  <p>{r.snippet}</p>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))}
            {results?.length === 0 && (
              <Empty icon={Search} title="No matching records">
                Try a company name, task title, or requirement.
              </Empty>
            )}
            {!results && (
              <p className="quiet">
                Search is restricted to this workspace. Enter at least two
                characters.
              </p>
            )}
          </div>
        </Dialog>
      )}
      {evidence && data && (
        <Dialog
          title="Evidence & connections"
          onClose={() => setEvidence(false)}
        >
          <p className="drawer-description">
            Follow the source trail behind this implementation. These are stored
            links, not AI-generated claims.
          </p>
          {data.evidence.map((e: any) => (
            <article className="evidence-card" key={e.id}>
              <span className="mini-label">{label(e.relationship)}</span>
              <h3>
                {
                  data.entities.find((n: any) => n.id === e.source_entity_id)
                    ?.label
                }
              </h3>
              <div className="connection-arrow">
                <ArrowDown size={18} />
              </div>
              <h3>
                {
                  data.entities.find((n: any) => n.id === e.target_entity_id)
                    ?.label
                }
              </h3>
              {e.excerpt && <blockquote>“{e.excerpt}”</blockquote>}
              {e.speaker && <small>{e.speaker}</small>}
            </article>
          ))}
          {!data.evidence.length && (
            <Empty icon={GitBranch} title="No evidence linked yet">
              Add source records and link them to delivery work through the API.
            </Empty>
          )}
        </Dialog>
      )}
      {composer && data?.implementation && (
        <Dialog
          title={composer === "tasks" ? "Add a task" : "Add a stage"}
          onClose={() => setComposer(null)}
        >
          <WorkComposer
            kind={composer}
            implementation={data.implementation.id}
            stages={data.stages}
            onSaved={() => {
              setComposer(null);
              setVersion((v) => v + 1);
              setNotice("Saved to your implementation.");
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

function WorkComposer({
  kind,
  implementation,
  stages,
  onSaved,
}: {
  kind: "tasks" | "stages";
  implementation: string;
  stages: RecordData[];
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="form-panel drawer-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const f = new FormData(e.currentTarget);
        try {
          const title = String(f.get("title"));
          const body =
            kind === "tasks"
              ? {
                  implementation_id: implementation,
                  title,
                  description: f.get("description"),
                  stage_id: f.get("stage") || null,
                  due_date: f.get("date") || null,
                  priority: f.get("priority"),
                }
              : {
                  implementation_id: implementation,
                  name: title,
                  key: title
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, ""),
                  sequence: stages.length
                    ? Math.max(...stages.map((s) => s.sequence)) + 1
                    : 0,
                  description: f.get("description"),
                };
          await api(kind, { method: "POST", body: JSON.stringify(body) });
          onSaved();
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="quiet">
        {kind === "tasks"
          ? "Keep the outcome specific and the next step clear."
          : "Stages represent your delivery methodology. Add only what this implementation needs."}
      </p>
      <label>
        {kind === "tasks" ? "Task title" : "Stage name"}
        <input name="title" required minLength={2} maxLength={160} autoFocus />
      </label>
      <label>
        Description
        <textarea name="description" rows={3} maxLength={10000} />
      </label>
      {kind === "tasks" && (
        <>
          <label>
            Stage
            <select name="stage">
              <option value="">No stage yet</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select name="priority" defaultValue="MEDIUM">
              {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((p) => (
                <option key={p} value={p}>
                  {label(p)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due date
            <input type="date" name="date" />
          </label>
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <button className="button primary full" disabled={busy}>
        {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}Save{" "}
        {kind === "tasks" ? "task" : "stage"}
      </button>
    </form>
  );
}

function PageTitle({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="page-title">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  );
}
function Progress({ value }: { value: number }) {
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Task completion"
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}
function ImplementationJourney({
  stages,
  currentView,
  onOpenJourney,
}: {
  stages: RecordData[];
  currentView: string;
  onOpenJourney: () => void;
}) {
  const completed = stages.filter((stage) => stage.status === "COMPLETED").length;
  const inProgressIndex = stages.findIndex((stage) => stage.status === "IN_PROGRESS");
  const nextPendingIndex = stages.findIndex((stage) => stage.status !== "COMPLETED");
  const currentIndex = inProgressIndex >= 0
    ? inProgressIndex
    : nextPendingIndex >= 0
      ? nextPendingIndex
      : Math.max(0, stages.length - 1);
  const current = stages[currentIndex];
  const next = stages[currentIndex + 1];
  const viewLabels: Record<string, string> = {
    Overview: "Project overview",
    Schedule: "Milestones & client meetings",
    Autopilot: "Meeting intelligence",
    Plan: "Evidence-backed delivery plan",
    Tasks: "Delivery work",
    Requirements: "Requirements",
    Documents: "Project documents",
    Stakeholders: "People & ownership",
    Activity: "Project history",
  };
  return (
    <section className="implementation-journey" aria-label="Implementation journey">
      <div className="implementation-journey-context">
        <span className="journey-kicker"><Flag size={13} /> IMPLEMENTATION JOURNEY</span>
        <strong>{current?.name ?? "Journey not mapped yet"}</strong>
        <small>{stages.length ? `Stage ${currentIndex + 1} of ${stages.length} · ${completed} complete` : "Add stages to map the path to go-live"}</small>
      </div>
      <div className="implementation-journey-track" role="img" aria-label={`${completed} of ${stages.length} implementation stages complete`}>
        {stages.map((stage, index) => (
          <span
            key={stage.id}
            className={`journey-segment ${stage.status.toLowerCase()} ${index === currentIndex ? "current" : ""}`}
            title={`${stage.name} · ${label(stage.status)}`}
          />
        ))}
      </div>
      <div className="implementation-journey-next">
        <span>YOU ARE IN</span>
        <strong>{viewLabels[currentView] ?? currentView}</strong>
        {next ? <small>Next: {next.name}</small> : <small>{stages.length ? "Final stage" : "Start by defining stages"}</small>}
      </div>
      <button className="journey-overview-link" onClick={onOpenJourney}>
        View journey <ArrowRight size={14} />
      </button>
    </section>
  );
}

function TaskList({
  tasks,
  canWrite,
  onComplete,
  pending,
}: {
  tasks: RecordData[];
  canWrite: boolean;
  onComplete: (id: string, status: string) => void;
  pending: string | null;
}) {
  if (!tasks.length)
    return (
      <Empty icon={ListTodo} title="No tasks yet">
        Define the implementation plan before assigning delivery work.
      </Empty>
    );
  return (
    <div className="task-list">
      {tasks.map((t) => (
        <div className="task-row" key={t.id}>
          <button
            className={`task-check ${t.status === "COMPLETED" ? "checked" : ""}`}
            disabled={!canWrite || !!pending}
            onClick={() => onComplete(t.id, t.status)}
            aria-label={`${t.status === "COMPLETED" ? "Reopen" : "Complete"} ${t.title}`}
          >
            {pending === t.id ? (
              <Loader2 size={16} className="spin" />
            ) : t.status === "COMPLETED" ? (
              <Check size={13} />
            ) : (
              <Circle size={16} />
            )}
          </button>
          <div className="task-info">
            <strong>{t.title}</strong>
            <span>
              {t.status === "BLOCKED"
                ? "Blocked · resolve prerequisite before continuing"
                : `${label(t.priority)} priority`}
            </span>
          </div>
          <Badge value={t.status} />
          <time>{formatDate(t.due_date)}</time>
        </div>
      ))}
    </div>
  );
}
function ActivityList({ events }: { events: RecordData[] }) {
  return (
    <div className="activity-list">
      {events.map((e) => (
        <div className="activity-row" key={e.id}>
          <span className="activity-dot" />
          <div>
            <strong>{e.payload?.label ?? label(e.event_type)}</strong>
            <p>{label(e.event_type)}</p>
            <time>
              {new Date(e.created_at).toLocaleDateString("en-GB", {
                month: "short",
                day: "numeric",
              })}{" "}
              · {e.actor_type === "USER" ? "Workspace member" : "System"}
            </time>
          </div>
        </div>
      ))}
      {!events.length && (
        <p className="quiet">Activity appears as the implementation evolves.</p>
      )}
    </div>
  );
}
function Records({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: RecordData[];
  kind: string;
}) {
  return (
    <Panel title={title} icon={kind === "stakeholders" ? Users : FileText}>
      <div className="records">
        {rows.map((r) => (
          <div className="record" key={r.id}>
            <span className="record-icon">
              {kind === "stakeholders" ? (
                <Users size={18} />
              ) : (
                <FileText size={18} />
              )}
            </span>
            <span>
              <strong>{r.title ?? r.name}</strong>
              <small>
                {r.description ??
                  r.role ??
                  (r.source === "DEMO_METADATA"
                    ? "Demo document metadata · no file uploaded"
                    : "Source material")}
              </small>
            </span>
            {r.status ? (
              <Badge value={r.status} />
            ) : r.processing_status ? (
              <span className="quiet">{label(r.processing_status)}</span>
            ) : (
              <span className="quiet">{r.company}</span>
            )}
          </div>
        ))}
      </div>
      {!rows.length && (
        <Empty title="Nothing added yet">
          This section will show records linked to your implementation.
        </Empty>
      )}
    </Panel>
  );
}
function CreateImplementation({
  companies,
  onCancel,
  onCreated,
}: {
  companies: RecordData[];
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [playbooks, setPlaybooks] = useState<RecordData[]>([]);
  const [playbookId, setPlaybookId] = useState("");
  const [playbooksLoading, setPlaybooksLoading] = useState(true);
  useEffect(() => {
    api<RecordData[]>("intelligence/playbooks/available")
      .then((items) => { setPlaybooks(items); if (items.length) setPlaybookId(items[0].id); })
      .catch((e) => setError(e.message))
      .finally(() => setPlaybooksLoading(false));
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      let company_id = String(form.get("company"));
      if (!company_id) {
        const company = await api("companies", {
          method: "POST",
          body: JSON.stringify({ name: form.get("company_name") }),
        });
        company_id = company.id;
      }
      const result = await api(playbookId ? "implementations/from-playbook" : "implementations", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          company_id,
          description: form.get("description"),
          target_go_live_date: form.get("date") || null,
          ...(playbookId ? { playbook_id: playbookId } : {}),
        }),
      });
      onCreated(result.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="create-page">
      <button className="text-button" onClick={onCancel}>
        <ArrowLeft size={15} />
        Back to implementations
      </button>
      <PageTitle
        eyebrow="A CLEAR START"
        title="Create an implementation"
        text="Choose a published methodology, then set the context for this customer."
      />
      <div className="create-grid">
        <form onSubmit={submit} className="form-panel">
          <h2>Implementation details</h2>
          <p className="quiet">
            Your implementation starts as a draft. No invitations or AI actions
            are triggered.
          </p>
          <label>
            Implementation name
            <input
              name="name"
              required
              minLength={2}
              maxLength={160}
              placeholder="e.g. Danone Autonomous Sourcing"
              autoFocus
            />
          </label>
          {companies.length ? (
            <label>
              Customer company
              <select name="company" required>
                <option value="">Select a company</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Customer company name
              <input
                name="company_name"
                required
                minLength={2}
                placeholder="Company name"
              />
            </label>
          )}
          <label>
            What does success look like?
            <textarea
              name="description"
              maxLength={10000}
              rows={4}
              placeholder="Describe the outcomes, scope and key decisions for this implementation."
            />
          </label>
          <label>
            Target go-live <span className="optional">Optional</span>
            <input name="date" type="date" />
          </label>
          <label>
            Organization playbook
            <select value={playbookId} disabled={playbooksLoading} onChange={(e) => setPlaybookId(e.target.value)}>
              {playbooksLoading && <option value="">Loading playbooks…</option>}
              {playbooks.map((p) => <option key={p.id} value={p.id}>{p.name} · v{p.published_version} · {p.published_snapshot?.stages?.length ?? 0} stages</option>)}
              <option value="">Blank draft · build manually</option>
            </select>
            <small>Published playbooks create real stages, tasks and milestones. This project keeps the exact version used at launch.</small>
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Plus size={16} />
              )}
              Create draft
            </button>
          </div>
        </form>
        <aside className="create-aside">
          <span className="icon-tint">
            <Layers3 size={23} />
          </span>
          <h2>A plan that stays connected.</h2>
          <p>
            Start with customer context. Then connect stages, owners,
            requirements and milestones into a shared source of truth.
          </p>
          <ol>
            <li>
              <strong>Define your scope</strong>
              <span>A clear name, customer and target date.</span>
            </li>
            <li>
              <strong>Build your delivery plan</strong>
              <span>Add stages and tasks with explicit ownership.</span>
            </li>
            <li>
              <strong>Keep the evidence close</strong>
              <span>Link decisions and requirements to their sources.</span>
            </li>
          </ol>
          <p className="provider-note">
            <ShieldCheck size={15} />
            Only members of your workspace can access this draft.
          </p>
        </aside>
      </div>
    </div>
  );
}
function Integrations() {
  return (
    <>
      <PageTitle
        eyebrow="YOUR CONNECTED SYSTEMS"
        title="Integrations"
        text="Bring implementation context together, with clear ownership and access."
      />
      <div className="info-banner">
        <Unplug size={18} />
        <span>
          <strong>No providers are connected.</strong> Connector authentication
          and background sync are scheduled for a later phase. No credentials
          are collected here.
        </span>
      </div>
      <div className="integration-grid">
        {[
          "Google Drive",
          "Slack",
          "Linear",
          "Notion",
          "Microsoft Teams",
          "Gmail",
          "Jira",
          "GitHub",
          "HubSpot",
        ].map((name) => (
          <div className="integration-item" key={name}>
            <span className="integration-letter">{name[0]}</span>
            <h3>{name}</h3>
            <p>Provider adapter not configured</p>
            <span className="badge not_started">
              <i />
              Planned
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
function WorkspaceSettings({
  workspace,
  context,
  members,
}: {
  workspace: RecordData;
  context: RecordData | null;
  members: RecordData[];
}) {
  const [section, setSection] = useState<"general" | "intelligence">("general");
  return (
    <>
      <PageTitle
        eyebrow="ORGANIZATION"
        title="Workspace settings"
        text="Manage access and teach the OS how your team delivers."
      />
      <div className="settings-section-tabs" role="tablist" aria-label="Workspace settings sections">
        <button role="tab" aria-selected={section === "general"} className={section === "general" ? "active" : ""} onClick={() => setSection("general")}><Building2 size={16} /> General & access</button>
        <button role="tab" aria-selected={section === "intelligence"} className={section === "intelligence" ? "active" : ""} onClick={() => setSection("intelligence")}><Layers3 size={16} /> Implementation intelligence</button>
      </div>
      {section === "intelligence" ? <IntelligenceLibrary canManage={["OWNER", "ADMIN"].includes(context?.role)} /> : <>
      <div className="settings-layout">
        <Panel title="Workspace identity" icon={Building2}>
          <dl className="definition-list">
            <div>
              <dt>Name</dt>
              <dd>{workspace.name}</dd>
            </div>
            <div>
              <dt>Workspace ID</dt>
              <dd>
                <code>{workspace.id}</code>
              </dd>
            </div>
            <div>
              <dt>Your role</dt>
              <dd>{label(context?.role)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <Badge value={workspace.status} />
              </dd>
            </div>
          </dl>
        </Panel>
        <Panel title="Access boundaries" icon={ShieldCheck}>
          <div className="security-copy">
            <h3>Workspace-scoped by design.</h3>
            <p>
              Membership and role checks are enforced by the API and PostgreSQL
              row-level security. A URL or workspace ID does not grant access.
            </p>
            <p>
              Team invitations and role-management workflows are not yet
              available in this foundation release.
            </p>
          </div>
        </Panel>
      </div>
      <Panel title="Workspace members" icon={Users}>
        <div className="records">
          {members.map((m) => (
            <div className="record" key={m.id}>
              <span className="avatar">{m.user_id.slice(-2)}</span>
              <span>
                <strong>{m.user_id}</strong>
                <small>Joined {formatDate(m.joined_at)}</small>
              </span>
              <Badge value={m.role} />
            </div>
          ))}
        </div>
      </Panel>
      </>}
    </>
  );
}
function Login({
  config,
  onReady,
}: {
  config: RecordData | null;
  onReady: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [signup, setSignup] = useState(false),
    [notice, setNotice] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      const email = String(f.get("email")),
        password = String(f.get("password"));
      if (signup) {
        await api("auth/signup", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        setNotice("Check your email to confirm your account, then sign in.");
        setSignup(false);
      } else {
        const { error } = await getAuth()!.auth.signInWithPassword({
          email,
          password,
        });
        if (error)
          throw new Error(
            "We could not sign you in. Check your credentials and email confirmation.",
          );
        onReady();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function signInWithWorkOS() {
    setBusy(true);
    setError("");
    try {
      const { error } = await getAuth()!.auth.signInWithOAuth({
        provider: "workos",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
    } catch {
      setError("WorkOS sign-in could not start. Please try again.");
      setBusy(false);
    }
  }
  const workos = config?.auth_provider === "workos";
  return (
    <main className="auth-page">
      <Logo />
      <div className="auth-content">
        <div>
          <div className="eyebrow">FROM KICKOFF TO CONFIDENCE</div>
          <h1>
            Great implementations
            <br />
            start with <span>clarity.</span>
          </h1>
          <p>
            One connected place for your plans, people and the decisions that
            move customers forward.
          </p>
          <div className="auth-trail">
            <MessageSquare />
            <span />
            <FileText />
            <span />
            <ListTodo />
            <span />
            <Flag />
          </div>
        </div>
        <form className="auth-card" onSubmit={submit}>
          <span className="icon-tint">
            <ShieldCheck size={23} />
          </span>
          <h2>{signup && !workos ? "Create your workspace" : "Welcome back"}</h2>
          <p>
            {config?.auth_configured
              ? workos
                ? "Sign in securely with WorkOS to continue to your workspace."
                : "Sign in securely with Supabase Auth."
              : "Connect a new Supabase project to enable account access. The isolated demo can be run locally in the meantime."}
          </p>
          {workos && config?.auth_configured && (
            <>
              {error && <div className="error" role="alert">{error}</div>}
              <button type="button" className="button primary full" disabled={busy} onClick={signInWithWorkOS}>
                {busy ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
                Continue with WorkOS
                <ArrowRight size={16} />
              </button>
            </>
          )}
          {!workos && config?.auth_configured && (
            <>
              <label>
                Email
                <input
                  required
                  type="email"
                  name="email"
                  autoComplete="email"
                />
              </label>
              <label>
                Password
                <input
                  required
                  type="password"
                  name="password"
                  minLength={signup ? 12 : 1}
                  autoComplete={signup ? "new-password" : "current-password"}
                />
              </label>
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              {notice && <p role="status">{notice}</p>}
              <button className="button primary full" disabled={busy}>
                {busy ? (
                  <Loader2 size={16} className="spin" />
                ) : signup ? (
                  "Create account"
                ) : (
                  "Sign in"
                )}
                <ArrowRight size={16} />
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setSignup(!signup)}
              >
                {signup
                  ? "Already have an account? Sign in"
                  : "New here? Create an account"}
              </button>
            </>
          )}
          <div className="provider-note">
            <ShieldCheck size={14} />
            Workspace access is verified on every request.
          </div>
        </form>
      </div>
    </main>
  );
}
function Onboarding({ onReady }: { onReady: () => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="onboarding">
      <Logo />
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const f = new FormData(e.currentTarget);
          try {
            await api("workspaces", {
              method: "POST",
              body: JSON.stringify({
                name: f.get("name"),
                slug: f.get("slug"),
              }),
            });
            onReady();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>Your first workspace</h1>
        <p>Give your team a place to deliver together.</p>
        <label>
          Workspace name
          <input name="name" minLength={2} maxLength={100} required />
        </label>
        <label>
          Workspace identifier
          <input
            name="slug"
            pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"
            minLength={3}
            required
            placeholder="your-company"
          />
          <small>
            3–64 lowercase letters, numbers or hyphens. This is not a website
            URL.
          </small>
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary" disabled={busy}>
          Create workspace <ArrowRight size={16} />
        </button>
      </form>
    </main>
  );
}
class AppBoundary extends React.Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="startup">
        <Logo />
        <Empty icon={CircleAlert} title="This view could not load">
          Your saved records are safe. Reload the workspace to try again.
        </Empty>
        <button className="button primary" onClick={() => location.reload()}>
          Reload workspace
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
