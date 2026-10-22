import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Circle,
  CircleAlert,
  FileText,
  Flag,
  GitBranch,
  Layers3,
  ListTodo,
  Loader2,
  Plus,
  Radar,
  Sparkles,
  Unplug,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import { api } from "./api";

type Item = Record<string, any>;
const name = (item: Item) => item.company?.name ?? item.name;
const label = (value?: string) =>
  value
    ? value.toLowerCase().replaceAll("_", " ").replace(/^./, (part) => part.toUpperCase())
    : "Workspace";
const risk = (item: Item) =>
  ["WATCH", "AT_RISK", "BLOCKED"].includes(item.health.health_status);
const tone = (item: Item) =>
  item.health.health_status === "BLOCKED" ||
  item.health.health_status === "AT_RISK"
    ? "danger"
    : item.health.health_status === "WATCH"
      ? "warning"
      : item.health.health_status === "HEALTHY"
        ? "success"
        : "neutral";
const briefTone = (item: Item) =>
  item.health.signals.length && !risk(item) ? "warning" : tone(item);
const healthLabel = (item: Item) =>
  ({
    HEALTHY: "On track",
    WATCH: "Needs attention",
    AT_RISK: "At risk",
    BLOCKED: "Blocked",
    UNKNOWN: "Not assessed",
  })[item.health.health_status as string] ?? "Not assessed";
const date = (value?: string) =>
  value
    ? new Date(value.slice(0, 10) + "T12:00:00").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
      })
    : "Not set";
const rank = (item: Item) =>
  ({ BLOCKED: 0, AT_RISK: 1, WATCH: 2, HEALTHY: 3, UNKNOWN: 4 })[
    item.health.health_status as string
  ] ?? 4;
const dateOnly = (value?: string) => value ? new Date(`${value.slice(0, 10)}T12:00:00`) : null;
const daysUntil = (value?: string) => {
  const target = dateOnly(value);
  if (!target) return null;
  const today = dateOnly(new Date().toISOString());
  return Math.ceil((target.getTime() - today!.getTime()) / 86400000);
};
const relativeTime = (value?: string) => {
  if (!value) return "Recently";
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return "Recently";
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : date(value);
};
const stages = ["Planning", "Discovery", "Requirements", "Design", "Configuration", "UAT", "Go-live"];
const stageIndex = (item: Item) => {
  const stage = String(item.current_stage ?? "").toLowerCase();
  if (/go.live|handoff|hypercare/.test(stage)) return 6;
  if (/uat|training|testing/.test(stage)) return 5;
  if (/config|integration|build/.test(stage)) return 4;
  if (/design/.test(stage)) return 3;
  if (/requirement|brd/.test(stage)) return 2;
  if (/discovery/.test(stage)) return 1;
  return 0;
};
const goLive = (item: Item) => {
  const days = daysUntil(item.target_go_live_date);
  return days === null ? "Not scheduled" : days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `${days} days`;
};

export function CommandCenter({
  data,
  canManage,
  onOpen,
  onCreate,
  onPortfolio,
  onTasks,
  onKnowledge,
  onIntegrations,
  aiConnected,
}: {
  data: { items: Item[]; summary: Item };
  canManage: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onPortfolio: () => void;
  onTasks: () => void;
  onKnowledge: () => void;
  onIntegrations: () => void;
  aiConnected: boolean;
}) {
  const items = data.items;
  const ordered = [...items].sort(
    (a, b) =>
      rank(a) - rank(b) || b.health.signals.length - a.health.signals.length,
  );
  const [selected, setSelected] = useState<string | null>(
    ordered[0]?.id ?? null,
  );
  const [radarFilter, setRadarFilter] = useState("All");
  const [taskFilter, setTaskFilter] = useState("Today");
  const [tasks, setTasks] = useState<Item[] | null>(null);
  const [taskError, setTaskError] = useState("");
  const [activity, setActivity] = useState<Item[] | null>(null);
  const [activityError, setActivityError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api("tasks?limit=100", { signal: controller.signal })
      .then(setTasks)
      .catch((e) => {
        if (e.name !== "AbortError") setTaskError(e.message);
      });
    api<Item[]>("activity?limit=100", { signal: controller.signal })
      .then((events) => setActivity(events.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))))
      .catch((e) => {
        if (e.name !== "AbortError") setActivityError(e.message);
      });
    return () => controller.abort();
  }, []);
  const assessed = items.filter(
    (i) =>
      i.health.health_score !== null && i.health.health_status !== "UNKNOWN",
  );
  const plotted = ordered.filter((item) => {
    if (radarFilter === "All") return true;
    if (radarFilter === "At risk") return risk(item);
    if (radarFilter === "Blocked") return item.health.health_status === "BLOCKED";
    const days = daysUntil(item.target_go_live_date);
    return days !== null && days >= 0 && days <= 30;
  });
  const radarItems = plotted.slice(0, 5);
  const active = radarItems.find((item) => item.id === selected) ?? radarItems[0];
  const signals = ordered
    .flatMap((i) =>
      i.health.signals.map((s: Item) => ({ ...s, implementation: i })),
    )
    .slice(0, 4);
  const openTasks = (tasks ?? []).filter(
    (t) => !["COMPLETED", "CANCELLED"].includes(t.status),
  );
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayWorkCount = openTasks.filter((t) => t.due_date && t.due_date.slice(0, 10) <= todayKey && t.status !== "BLOCKED").length;
  const upcomingWorkCount = openTasks.filter((t) => (!t.due_date || t.due_date.slice(0, 10) > todayKey) && t.status !== "BLOCKED").length;
  const waitingOnCount = openTasks.filter((t) => t.status === "BLOCKED").length;
  const work = openTasks
    .filter((t) => taskFilter === "Today"
      ? Boolean(t.due_date && t.due_date.slice(0, 10) <= todayKey && t.status !== "BLOCKED")
      : taskFilter === "Upcoming"
        ? Boolean((!t.due_date || t.due_date.slice(0, 10) > todayKey) && t.status !== "BLOCKED")
        : t.status === "BLOCKED")
    .sort((a, b) => (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"))
    .slice(0, 5);
  const recentActivity = (activity ?? []).slice(0, 5);
  const nextGoLiveDays = items.filter((item) => item.status === "ACTIVE").map((item) => daysUntil(item.target_go_live_date)).filter((days): days is number => days !== null && days >= 0).sort((a, b) => a - b)[0];
  const onTrackCount = items.filter((item) => item.health.health_status === "HEALTHY").length;
  const atRiskCount = items.filter((item) => ["WATCH", "AT_RISK"].includes(item.health.health_status)).length;
  const blockedCount = items.filter((item) => item.health.health_status === "BLOCKED").length;
  return (
    <div className="command-center command-v2" data-design-version="stage-command-center-v2">
      <div className="command-heading">
        <div>
          <span className="command-eyebrow">COMMAND CENTER</span>
          <h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 17 ? "afternoon" : "evening"}, team.</h1>
          <p>
            {items.length} implementations <span>·</span> {data.summary.attention} {data.summary.attention === 1 ? "needs" : "need"} attention <span>·</span> {data.summary.open_tasks} open tasks{nextGoLiveDays === undefined ? "" : <> <span>·</span> Next go-live in {nextGoLiveDays} {nextGoLiveDays === 1 ? "day" : "days"}</>}
          </p>
        </div>
        <div className="heading-actions">
          <div className="today-label">
            <CalendarDays size={17} />
            <span>
              {new Date().toLocaleDateString("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
              })}
              <small>Your workspace, in focus</small>
            </span>
          </div>
          {canManage && (
            <button className="button primary" onClick={onCreate}>
              <Plus size={16} />
              New implementation
            </button>
          )}
        </div>
      </div>

      <section className="brief-panel" aria-labelledby="brief-title">
        <header className="brief-header">
          <span className="section-symbol">
            <Sparkles size={20} />
          </span>
          <div>
            <h2 id="brief-title">
              Your implementation brief{" "}
              <span className="subtle-tag">RULE-BASED SIGNALS</span>
            </h2>
            <p>
              The customer projects and delivery signals most likely to need a decision next.
            </p>
          </div>
          <button className="button" onClick={onPortfolio}>
            View portfolio <ArrowRight size={14} />
          </button>
        </header>
        {items.length ? (
          <div className="brief-grid">
            {ordered.slice(0, 3).map((item, index) => (
              <article
                className={`brief-card ${briefTone(item)}`}
                key={item.id}
              >
                <div className="brief-kicker">
                  <span>0{index + 1}</span>
                  <span className={`signal-tag ${briefTone(item)}`}>
                    {item.health.signals.length && !risk(item)
                      ? "Review signals"
                      : healthLabel(item)}
                  </span>
                  {briefTone(item) === "danger" ? (
                    <TrendingDown size={16} aria-hidden="true" />
                  ) : briefTone(item) === "success" ? (
                    <TrendingUp size={16} aria-hidden="true" />
                  ) : (
                    <Activity size={16} aria-hidden="true" />
                  )}
                </div>
                <p className="brief-company">
                  {name(item)} <span>·</span> {item.current_stage}
                </p>
                <h3>
                  {item.health.signals[0]?.title ??
                    (item.health.total
                      ? `${item.health.completed} of ${item.health.total} tasks complete.`
                      : "A clear plan starts here.")}
                </h3>
                <p className="brief-description">
                  {item.health.signals.length
                    ? `${item.health.signals.length} delivery signals to review. Check the linked records and agree on the next step.`
                    : item.health.total
                      ? "No delivery warnings in the current records. Keep the remaining work and milestones moving."
                      : "Add stages, assign delivery work and connect source material to start tracking progress."}
                </p>
                <footer>
                  <button
                    className="brief-action"
                    onClick={() => onOpen(item.id)}
                  >
                    {item.health.signals.length
                      ? "Review signals"
                      : item.health.total
                        ? "View progress"
                        : "Build the plan"}
                    <ArrowRight size={14} />
                  </button>
                  <span>
                    <CalendarDays size={13} />
                    {goLive(item)}
                  </span>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty">
            <Layers3 size={28} />
            <h3>Start your first implementation</h3>
            <p>
              Your brief will surface delivery signals as your plan takes shape.
            </p>
            {canManage && (
              <button className="button primary" onClick={onCreate}>
                <Plus size={16} />
                Create implementation
              </button>
            )}
          </div>
        )}
      </section>

      <div className="command-grid">
        <section className="command-panel portfolio-pulse">
          <header className="command-panel-heading">
            <div>
              <h2>Implementation pulse</h2>
              <p>Live trajectory across your implementation portfolio.</p>
            </div>
            <div className="pulse-summary" aria-label="Implementation health counts">
              <span><strong>{items.length}</strong><small>Projects</small></span>
              <span className="healthy"><strong>{onTrackCount}</strong><small>On track</small></span>
              <span className="warning"><strong>{atRiskCount}</strong><small>At risk</small></span>
              <span className="danger"><strong>{blockedCount}</strong><small>Blocked</small></span>
            </div>
          </header>
          <div className="stage-pulse-scroll">
            <div className="stage-pulse-head"><span>Project</span><div>{stages.map(stage => <span key={stage}>{stage}</span>)}</div><span>Go-live</span></div>
            <div className="stage-pulse-rows">
              {ordered.slice(0, 5).map((item) => <button className={`stage-pulse-row ${tone(item)}`} key={item.id} onClick={() => onOpen(item.id)} aria-label={`${name(item)}, ${item.current_stage}, ${item.health.progress}% of tasks complete, go-live ${goLive(item)}`}>
                <span className="stage-project"><span className="project-monogram">{name(item).split(" ").map((s: string) => s[0]).slice(0, 2).join("")}</span><strong>{name(item)}</strong></span>
                <span className="stage-track"><span className="stage-track-line" /><span className="stage-position-line" style={{ width: `${stageIndex(item) / 6 * 100}%` }} />{stages.map((stage, index) => <span key={stage} style={{ left: `${index / 6 * 100}%` }} className={`stage-marker ${index === stageIndex(item) ? "current" : ""}`} />)}<span className="stage-progress-label" style={{ left: `${Math.min(83, stageIndex(item) / 6 * 100)}%` }}>{item.health.progress}% tasks</span></span>
                <span className="stage-due"><CalendarDays size={12} />{goLive(item)}</span>
              </button>)}
            </div>
          </div>
          {!items.length && (
            <p className="panel-empty">No implementations yet.</p>
          )}
          <footer className="panel-footer">
            <span className="pulse-key"><i className="key-success" />On track <i className="key-warning" />At risk <i className="key-danger" />Blocked <i className="key-neutral" />Not assessed</span>
            <button className="text-button" onClick={onPortfolio}>
              View all <ArrowRight size={14} />
            </button>
          </footer>
        </section>

        <section className="command-panel radar-panel">
          <header className="command-panel-heading">
            <div>
              <h2>
                Implementation radar <Radar size={17} />
              </h2>
              <p>Where projects stand. Select one to inspect.</p>
            </div>
            <div className="segmented-control" aria-label="Radar filter">
              {["All", "At risk", "Blocked", "Go-lives < 30d"].map((f) => (
                <button
                  key={f}
                  aria-pressed={radarFilter === f}
                  onClick={() => setRadarFilter(f)}
                >
                  {f}
                </button>
              ))}
            </div>
          </header>
          <div className="stage-radar-layout">
            <div className="stage-radar-scroll">
              <div className="stage-radar-canvas" role="group" aria-label="Projects by implementation stage; vertical position separates projects only" style={{ height: `${Math.max(160, radarItems.length * 32)}px` }}>
                <div className="stage-radar-guides">{stages.map(stage => <i key={stage} />)}</div>
                {radarItems.map((item, index) => <button key={item.id} className={`stage-radar-node ${tone(item)} ${active?.id === item.id ? "selected" : ""}`} style={{ left: `calc(${stageIndex(item) / 6 * 100}% - ${stageIndex(item) / 6 * 90}px + 4px)`, top: `${6 + index * 31}px` }} onClick={() => setSelected(item.id)} aria-pressed={active?.id === item.id} aria-label={`${name(item)}, ${item.current_stage}, ${healthLabel(item)}, ${item.health.progress}% tasks complete`}>
                  <i /><span><strong>{name(item)}</strong><small>{item.health.progress}% tasks</small></span>
                </button>)}
                {!plotted.length && <p className="stage-radar-empty">No implementations match this filter.</p>}
              </div>
              <div className="stage-radar-axis">{stages.map(stage => <span key={stage}>{stage}</span>)}</div>
            </div>
            {active && <aside className="stage-inspector" aria-label="Selected implementation">
              <div className="stage-inspector-title"><span className="project-monogram">{name(active).slice(0, 1)}</span><div><strong>{name(active)}</strong><small>{active.current_stage} · {active.health.progress}% tasks</small></div></div>
              <span className={`signal-tag ${tone(active)}`}>{healthLabel(active)}</span>
              <p><CalendarDays size={14} /><span>Go-live: <strong>{goLive(active)}</strong></span></p>
              <p><CircleAlert size={14} /><span><strong>{active.health.signals.length}</strong> delivery signals</span></p>
              <p><Activity size={14} /><span>Health: <strong>{active.health.health_score ?? "Not assessed"}</strong></span></p>
              <button className="button primary" onClick={() => onOpen(active.id)}>Open project <ArrowRight size={13} /></button>
            </aside>}
          </div>
          <div className="radar-note"><span>Current stage · Rule-based health</span><button className="text-button" onClick={onPortfolio}>View all {items.length} projects <ArrowRight size={12} /></button></div>
        </section>

      </div>
      <div className="command-bottom-grid">
        <section className="command-panel attention-engine">
          <header className="command-panel-heading">
            <div>
              <h2>
                <Flag size={17} />
                Attention engine
              </h2>
              <p>The issues that deserve a conversation.</p>
            </div>
            <span className="count">{signals.length}</span>
          </header>
          {signals.map((signal, index) => (
            <button
              className="attention-item"
              key={`${signal.implementation.id}-${signal.type}`}
              onClick={() => onOpen(signal.implementation.id)}
            >
              <span className="attention-number">0{index + 1}</span>
              <span>
                <span className="attention-meta">
                  <span
                    className={`signal-tag ${signal.severity === "HIGH" ? "danger" : "warning"}`}
                  >
                    {signal.severity}
                  </span>
                  {name(signal.implementation)} ·{" "}
                  {signal.implementation.current_stage}
                </span>
                <strong>{signal.title}</strong>
                <small>
                  {signal.count} linked records · Review source evidence{" "}
                  <ArrowRight size={12} />
                </small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
          {!signals.length && (
            <div className="empty">
              <CheckCircle2 size={24} />
              <h3>No delivery warnings</h3>
              <p>Signals will appear here as your implementations evolve.</p>
            </div>
          )}
        </section>

        <section className="command-panel workspace-work">
          <header className="command-panel-heading">
            <div>
              <h2>
                <ListTodo size={18} />
                My work
              </h2>
              <p>Delivery tasks due soon and work waiting on a dependency.</p>
            </div>
            <button className="text-button" onClick={onTasks}>
              View all <ArrowRight size={14} />
            </button>
          </header>
          <div className="work-filter">
            {["Today", "Upcoming", "Waiting on"].map((f) => (
              <button
                key={f}
                aria-pressed={taskFilter === f}
                onClick={() => setTaskFilter(f)}
              >
                {f}
                <span>
                  {f === "Today" ? todayWorkCount : f === "Upcoming" ? upcomingWorkCount : waitingOnCount}
                </span>
              </button>
            ))}
            <span>Prioritized by due date</span>
          </div>
          {taskError ? (
            <p className="panel-empty" role="alert">
              Could not load tasks. Open Tasks to retry.
            </p>
          ) : !tasks ? (
            <div className="panel-empty" role="status">
              <Loader2 className="spin" size={18} />
              Loading work…
            </div>
          ) : work.length ? (
            work.map((task) => (
              <button
                className="work-preview"
                key={task.id}
                onClick={() => onOpen(task.implementation_id)}
              >
                <span
                  className={
                    task.status === "BLOCKED" ? "blocked-work" : "work-circle"
                  }
                >
                  {task.status === "BLOCKED" ? (
                    <CircleAlert size={17} />
                  ) : (
                    <Circle size={17} />
                  )}
                </span>
                <span>
                  <strong>{task.title}</strong>
                  <small>
                    {items.find((i) => i.id === task.implementation_id)?.company
                      ?.name ?? "Implementation"}{" "}
                    · {task.priority.toLowerCase()} priority
                  </small>
                </span>
                <time>{date(task.due_date)}</time>
                <ArrowUpRight size={14} />
              </button>
            ))
          ) : (
            <div className="empty">
              <CheckCircle2 size={24} />
              <h3>
                {taskFilter === "Waiting on"
                  ? "No blocked tasks"
                  : "All clear for now"}
              </h3>
              <p>New delivery work will appear here.</p>
            </div>
          )}
        </section>

        <section className="command-panel recent-activity">
          <header className="command-panel-heading">
            <div>
              <h2><Activity size={17} />Recent changes</h2>
              <p>Latest recorded workspace updates.</p>
            </div>
            <span className="count">{activity ? recentActivity.length : "—"}</span>
          </header>
          {activityError ? <p className="panel-empty" role="alert">Could not load recent activity.</p> : !activity ? <div className="panel-empty" role="status"><Loader2 className="spin" size={17} />Loading updates…</div> : recentActivity.length ? <div className="recent-activity-list">{recentActivity.map((event) => {
            const project = items.find((item) => item.id === event.implementation_id);
            const title = event.payload?.label ?? event.payload?.change_summary ?? label(event.event_type);
            return <button className="recent-activity-item" key={event.id} onClick={() => event.implementation_id && onOpen(event.implementation_id)} disabled={!event.implementation_id}>
              <span className={`recent-activity-icon ${String(event.entity_type ?? "").toLowerCase()}`}><Activity size={14} /></span>
              <span className="recent-activity-copy"><strong>{title}</strong><small>{project ? name(project) : label(event.entity_type ?? "Workspace")} · {label(event.event_type)}</small></span>
              <time>{relativeTime(event.created_at)}</time>
            </button>;
          })}</div> : <div className="recent-activity-empty"><span><Activity size={17} /></span><strong>No recent changes</strong><small>Workspace updates will appear here as work progresses.</small></div>}
        </section>

        <section className="command-panel ai-opportunities">
          <header className="command-panel-heading">
            <div>
              <h2><Sparkles size={17} />AI opportunities</h2>
              <p>{aiConnected ? "Prepare evidence-led work from your delivery context." : "Connect AI to prepare work from project evidence."}</p>
            </div>
            <span className={`ai-connection-state ${aiConnected ? "connected" : "disconnected"}`}><i />{aiConnected ? "Connected" : "Not connected"}</span>
          </header>
          <div className="ai-opportunity-list">
            <div className="ai-opportunity-item"><span><FileText size={15} /></span><div><strong>Kickoff storyboard</strong><small>Turn project context into a reviewable session plan.</small></div></div>
            <div className="ai-opportunity-item"><span><GitBranch size={15} /></span><div><strong>Discovery → BRD</strong><small>Draft requirements with source evidence and open questions.</small></div></div>
          </div>
          <div className="ai-opportunity-actions">
            <button className="button primary" onClick={() => aiConnected && ordered[0] ? onOpen(ordered[0].id) : onIntegrations()}>{aiConnected ? ordered.length ? "Open an implementation" : "Create implementation" : "Connect AI provider"}<ArrowRight size={14} /></button>
            <button className="text-button" onClick={onKnowledge}>Browse evidence</button>
          </div>
          {!aiConnected && <p className="ai-opportunity-footnote"><Unplug size={13} />These AI actions become available after you connect a provider.</p>}
        </section>
      </div>
    </div>
  );
}
