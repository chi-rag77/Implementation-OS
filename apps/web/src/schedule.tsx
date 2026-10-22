import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ExternalLink,
  Flag,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Users,
  Video,
  X,
} from "lucide-react";
import { api } from "./api";

type Row = Record<string, any>;
type Scope = "week" | "month" | "quarter";
type Kind = "meeting" | "milestone";
type EventRow = Row & { kind: Kind; eventDate: Date; eventEnd: Date; projectName: string };
const today = () => new Date(new Date().toDateString());
const key = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDay = (value?: string) => value ? new Date(`${value.slice(0, 10)}T12:00:00`) : null;
const monday = (date: Date) => { const d = new Date(date); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); d.setHours(0, 0, 0, 0); return d; };
const localInput = (date?: string) => {
  if (!date) return "";
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const localIso = (value: string) => new Date(value).toISOString();
const niceDate = (date: Date, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) => date.toLocaleDateString(undefined, options);
const typeLabels: Record<string, string> = { KICKOFF: "Kickoff", DISCOVERY: "Discovery", WORKSHOP: "Workshop", STATUS_REVIEW: "Status review", DESIGN_REVIEW: "Design review", UAT: "UAT", TRAINING: "Training", GO_LIVE: "Go-live", CUSTOMER_CHECK_IN: "Client check-in", OTHER: "Other" };
const typeOptions = Object.entries(typeLabels);

function getWindow(date: Date, scope: Scope) {
  if (scope === "week") {
    const start = monday(date);
    return Array.from({ length: 7 }, (_, i) => { const day = new Date(start); day.setDate(start.getDate() + i); return day; });
  }
  if (scope === "month") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return Array.from({ length: end.getDate() }, (_, i) => new Date(start.getFullYear(), start.getMonth(), i + 1));
  }
  const start = monday(new Date(date.getFullYear(), date.getMonth(), 1));
  return Array.from({ length: 13 }, (_, i) => { const day = new Date(start); day.setDate(start.getDate() + i * 7); return day; });
}

export function Schedule({ canWrite, canManage, onOpenImplementation, implementationId }: { canWrite: boolean; canManage: boolean; onOpenImplementation: (id: string) => void; implementationId?: string }) {
  const [implementations, setImplementations] = useState<Row[]>([]);
  const [meetings, setMeetings] = useState<Row[]>([]);
  const [milestones, setMilestones] = useState<Row[]>([]);
  const [members, setMembers] = useState<Row[]>([]);
  const [scope, setScope] = useState<Scope>("week");
  const [cursor, setCursor] = useState(today());
  const [implementationFilter, setImplementationFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<EventRow | null>(null);
  const [composer, setComposer] = useState(false);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<Kind>("meeting");
  const [draft, setDraft] = useState({ implementation_id: "", title: "", meeting_type: "CUSTOMER_CHECK_IN", date: key(today()), start: "10:00", end: "10:30", target_date: key(today()), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", location: "", meeting_url: "", attendees: "", organizer_id: "", summary: "" });

  async function refresh() {
    setBusy(true); setError("");
    try {
      const [projects, meetingRows, milestoneRows, memberRows] = await Promise.all([
        api<Row[]>("implementations?limit=100"), api<Row[]>("meetings?limit=100"), api<Row[]>("milestones?limit=100"), api<Row[]>("members?limit=100").catch(() => []),
      ]);
      setImplementations(projects); setMeetings(meetingRows); setMilestones(milestoneRows); setMembers(memberRows);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);

  const range = useMemo(() => getWindow(cursor, scope), [cursor, scope]);
  const events = useMemo<EventRow[]>(() => {
    const names = new Map(implementations.map((p) => [p.id, p.name]));
    const meetingEvents = meetings.filter((m) => m.start_time).map((m) => {
      const start = new Date(m.start_time); return { ...m, kind: "meeting" as const, eventDate: start, eventEnd: m.end_time ? new Date(m.end_time) : start, projectName: names.get(m.implementation_id) ?? "Implementation" };
    });
    const milestoneEvents = milestones.filter((m) => m.target_date).map((m) => {
      const day = parseDay(m.target_date)!; return { ...m, kind: "milestone" as const, eventDate: day, eventEnd: day, projectName: names.get(m.implementation_id) ?? "Implementation", title: m.name };
    });
    return [...meetingEvents, ...milestoneEvents].sort((a, b) => a.eventDate.getTime() - b.eventDate.getTime());
  }, [implementations, meetings, milestones]);
  const rangeStart = range[0];
  const rangeEnd = new Date(range[range.length - 1]); rangeEnd.setHours(23, 59, 59, 999);
  const scopedEvents = implementationId ? events.filter((event) => event.implementation_id === implementationId) : events;
  const visible = scopedEvents.filter((event) => {
    const projectMatch = implementationId ? event.implementation_id === implementationId : implementationFilter === "all" || event.implementation_id === implementationFilter;
    const kindMatch = kindFilter === "all" || event.kind === kindFilter;
    const queryMatch = `${event.title} ${event.projectName} ${event.summary ?? ""}`.toLowerCase().includes(query.toLowerCase());
    const inRange = event.eventDate <= rangeEnd && event.eventEnd >= rangeStart;
    return projectMatch && kindMatch && queryMatch && inRange;
  });
  const rangeStartKey = key(rangeStart), rangeEndKey = key(rangeEnd);
  const soon = scopedEvents.filter((e) => e.eventDate >= today() && e.eventDate < new Date(today().getTime() + 7 * 86400000));
  const nextMilestone = scopedEvents.find((e) => e.kind === "milestone" && e.eventDate >= today() && e.status !== "COMPLETED" && e.status !== "CANCELLED");
  const scopedProject = implementations.find((project) => project.id === implementationId);
  const titleRange = scope === "week" ? `${niceDate(range[0])} – ${niceDate(range[range.length - 1], { day: "numeric", month: "long", year: "numeric" })}` : scope === "month" ? cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : `${niceDate(range[0], { month: "short", year: "numeric" })} – ${niceDate(range.at(-1)!, { month: "short", year: "numeric" })}`;
  const interval = scope === "quarter" ? 7 : 1;
  const indexAt = (date: Date) => Math.max(0, Math.min(range.length - 1, Math.floor((monday(date).getTime() - monday(rangeStart).getTime()) / (86400000 * interval))));

  function moveWindow(direction: number) {
    const next = new Date(cursor);
    if (scope === "week") next.setDate(next.getDate() + direction * 7);
    else if (scope === "month") next.setMonth(next.getMonth() + direction);
    else next.setMonth(next.getMonth() + direction * 3);
    setCursor(next);
  }
  function beginCreate(nextKind: Kind) {
    const date = key(today());
    setKind(nextKind); setSelected(null); setEditing(true); setComposer(true); setError("");
    setDraft((old) => ({ ...old, implementation_id: implementationId ?? (implementationFilter === "all" ? implementations[0]?.id ?? "" : implementationFilter), title: "", meeting_type: nextKind === "milestone" ? "GO_LIVE" : "CUSTOMER_CHECK_IN", date, start: "10:00", end: "10:30", target_date: date, location: "", meeting_url: "", attendees: "", organizer_id: "", summary: "" }));
  }
  function beginEdit(event: EventRow) {
    setKind(event.kind); setSelected(event); setComposer(true); setEditing(true); setError("");
    const start = event.kind === "meeting" ? new Date(event.start_time) : event.eventDate;
    const end = event.kind === "meeting" && event.end_time ? new Date(event.end_time) : start;
    setDraft({ implementation_id: event.implementation_id, title: event.title, meeting_type: event.meeting_type ?? "CUSTOMER_CHECK_IN", date: key(start), start: `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`, end: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`, target_date: key(event.eventDate), timezone: event.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC", location: event.location ?? "", meeting_url: event.meeting_url ?? "", attendees: (event.attendees ?? []).join("\n"), organizer_id: event.organizer_id ?? "", summary: event.summary ?? event.description ?? "" });
  }
  async function save(e: FormEvent) {
    e.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      if (kind === "meeting") {
        const payload = { implementation_id: draft.implementation_id, title: draft.title.trim(), meeting_type: draft.meeting_type, start_time: localIso(`${draft.date}T${draft.start}`), end_time: localIso(`${draft.date}T${draft.end}`), timezone: draft.timezone, location: draft.location.trim(), meeting_url: draft.meeting_url.trim(), attendees: draft.attendees.split(/\n|,/).map((x) => x.trim()).filter(Boolean), organizer_id: draft.organizer_id || null, summary: draft.summary.trim() };
        if (selected) {
          const patch = Object.fromEntries(Object.entries(payload).filter(([field]) => field !== "implementation_id"));
          await api(`meetings/${selected.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        } else await api("meetings", { method: "POST", body: JSON.stringify(payload) });
      } else {
        const payload = { implementation_id: draft.implementation_id, name: draft.title.trim(), description: draft.summary.trim(), target_date: draft.target_date, status: "NOT_STARTED", sequence: milestones.filter((m) => m.implementation_id === draft.implementation_id).length };
        if (selected) {
          const patch = Object.fromEntries(Object.entries(payload).filter(([field]) => !["implementation_id", "status", "sequence"].includes(field)));
          await api(`milestones/${selected.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        } else await api("milestones", { method: "POST", body: JSON.stringify(payload) });
      }
      setNotice(selected ? "Schedule item updated." : `${kind === "meeting" ? "Client meeting" : "Milestone"} added to the implementation schedule.`);
      setComposer(false); setSelected(null); setEditing(false); await refresh();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }
  async function updateStatus(event: EventRow, status: string) {
    setSaving(true); setError("");
    try {
      const path = event.kind === "meeting" ? `meetings/${event.id}` : `milestones/${event.id}`;
      await api(path, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice(status === "CANCELLED" ? "Meeting cancelled. Its history remains on the schedule." : "Schedule status updated.");
      setSelected(null); await refresh();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }
  function eventPosition(event: EventRow) {
    const start = indexAt(event.eventDate);
    const end = indexAt(event.eventEnd);
    return { gridColumn: `${start + 2} / span ${Math.max(1, end - start + 1)}` };
  }

  return <div className="schedule-page">
    <header className="schedule-heading"><div><div className="eyebrow">{implementationId ? "IMPLEMENTATION TIMELINE" : "DELIVERY CALENDAR"}</div><h1>{implementationId ? scopedProject?.name ?? "Project schedule" : "Schedule"}</h1><p>{implementationId ? "Project milestones and every customer meeting, arranged around the path to go-live." : "Keep customer conversations, delivery milestones and go-live dates in one shared plan."}</p></div><div className="schedule-heading-actions"><button className="button" onClick={() => void refresh()} disabled={busy}><RefreshCw size={15} className={busy ? "spin" : ""} />Refresh</button>{canWrite && <button className="button" onClick={() => beginCreate("meeting")}><Plus size={15} />Schedule meeting</button>}{canManage && <button className="button primary" onClick={() => beginCreate("milestone")}><Flag size={15} />Add milestone</button>}</div></header>
    {notice && <div className="schedule-notice" role="status"><CheckCircle2 size={16} />{notice}<button aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></div>}
    {error && <div className="schedule-error" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>Try again</button></div>}
    <section className="schedule-summary" aria-label="Schedule overview">
      <div><span className="schedule-summary-icon violet"><CalendarDays size={16} /></span><span><small>Next 7 days</small><strong>{soon.length} <em>scheduled</em></strong></span></div>
      <div><span className="schedule-summary-icon cyan"><Video size={16} /></span><span><small>Client meetings</small><strong>{soon.filter((e) => e.kind === "meeting").length} <em>this week</em></strong></span></div>
      <div><span className="schedule-summary-icon amber"><Flag size={16} /></span><span><small>Next milestone</small><strong>{nextMilestone ? niceDate(nextMilestone.eventDate, { day: "numeric", month: "short" }) : "Not set"}</strong></span></div>
      <div><span className="schedule-summary-icon green"><Check size={16} /></span><span><small>On this timeline</small><strong>{visible.length} <em>items</em></strong></span></div>
    </section>

    <section className="schedule-board">
      <header className="schedule-toolbar">
        <div className="schedule-date-nav"><button aria-label="Previous period" className="icon-button" onClick={() => moveWindow(-1)}><ChevronLeft size={17} /></button><strong>{titleRange}</strong><button aria-label="Next period" className="icon-button" onClick={() => moveWindow(1)}><ChevronRight size={17} /></button><button className="button schedule-today" onClick={() => setCursor(today())}>Today</button></div>
        <div className="schedule-filters">{!implementationId && <label className="schedule-select"><span className="sr-only">Filter by customer implementation</span><select value={implementationFilter} onChange={(e) => setImplementationFilter(e.target.value)}><option value="all">All customers</option>{implementations.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}<label className="schedule-search"><Search size={14} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a meeting or milestone" /></label><div className="schedule-scope" role="tablist" aria-label="Timeline range">{([["week", "Week"], ["month", "Month"], ["quarter", "Quarter"]] as [Scope, string][]).map(([value, label]) => <button key={value} role="tab" aria-selected={scope === value} className={scope === value ? "active" : ""} onClick={() => setScope(value)}>{label}</button>)}</div></div>
      </header>
      <div className="schedule-type-filters"><button className={kindFilter === "all" ? "active" : ""} onClick={() => setKindFilter("all")}>All activity <span>{scopedEvents.length}</span></button><button className={kindFilter === "meeting" ? "active" : ""} onClick={() => setKindFilter("meeting")}><Video size={13} />Meetings</button><button className={kindFilter === "milestone" ? "active" : ""} onClick={() => setKindFilter("milestone")}><Flag size={13} />Milestones</button><span className="schedule-legend"><i className="meeting" />Customer meeting <i className="milestone" />Milestone</span></div>
      <div className={`schedule-scroll ${scope}`}>
        <div className="schedule-grid" style={{ gridTemplateColumns: `minmax(230px, 1.8fr) repeat(${range.length}, ${scope === "week" ? "minmax(88px, 1fr)" : scope === "month" ? "64px" : "minmax(94px, 1fr)"})` }}>
          <div className="schedule-grid-head schedule-sticky-cell">Customer / activity</div>
          {range.map((day) => <div className={`schedule-grid-head schedule-day-head ${key(day) === key(today()) ? "today" : ""}`} key={key(day)}><span>{scope === "quarter" ? `W${Math.ceil((day.getDate() + new Date(day.getFullYear(), day.getMonth(), 1).getDay()) / 7)}` : day.toLocaleDateString(undefined, { weekday: "short" })}</span><strong>{scope === "quarter" ? niceDate(day, { day: "numeric", month: "short" }) : day.getDate()}</strong></div>)}
          {busy ? <div className="schedule-loading" style={{ gridColumn: `1 / span ${range.length + 1}` }}>Loading customer schedules…</div> : visible.length ? visible.map((event) => <div className="schedule-event-row" key={`${event.kind}-${event.id}`} style={{ gridTemplateColumns: `minmax(230px, 1.8fr) repeat(${range.length}, ${scope === "week" ? "minmax(88px, 1fr)" : scope === "month" ? "64px" : "minmax(94px, 1fr)"})` }}>
            <button className="schedule-event-label schedule-sticky-cell" onClick={() => { setSelected(event); setComposer(false); setEditing(false); }}><span className={`schedule-event-type ${event.kind}`} aria-hidden="true">{event.kind === "meeting" ? <Video size={14} /> : <Flag size={14} />}</span><span><strong>{event.title}</strong><small>{event.projectName} · {event.kind === "meeting" ? typeLabels[event.meeting_type] ?? "Client meeting" : "Milestone"}</small></span><ChevronRight size={14} /></button>
            {range.map((day) => <span className={`schedule-cell ${key(day) === key(today()) ? "today" : ""}`} key={`${event.id}-${key(day)}`} />)}
            <button className={`schedule-event-bar ${event.kind} ${String(event.status ?? "SCHEDULED").toLowerCase()}`} style={{ ...eventPosition(event), gridRow: 1 }} onClick={() => { setSelected(event); setComposer(false); setEditing(false); }} title={`${event.projectName} · ${event.title} · ${niceDate(event.eventDate)}`}><span className="event-bar-pin" />{event.kind === "meeting" ? `${event.eventDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ${event.title}` : event.title}</button>
          </div>) : <div className="schedule-empty" style={{ gridColumn: `1 / span ${range.length + 1}` }}><span><CalendarDays size={23} /></span><h3>{busy ? "Loading schedule" : "A clear plan starts here"}</h3><p>{busy ? "Gathering milestones and customer meetings." : "Add the first customer meeting or delivery milestone. Each item stays connected to its implementation."}</p>{!busy && (canWrite || canManage) && <div>{canWrite && <button className="button" onClick={() => beginCreate("meeting")}><Plus size={14} />Schedule a meeting</button>}{canManage && <button className="button primary" onClick={() => beginCreate("milestone")}><Flag size={14} />Add a milestone</button>}</div>}</div>}
        </div>
      </div>
      <footer className="schedule-board-foot"><span><i className="today-dot" />Today · {niceDate(today(), { day: "numeric", month: "long" })}</span><span>Times are shown in your local timezone</span></footer>
    </section>
    <p className="schedule-note"><CheckCircle2 size={14} />This schedule updates the implementation workspace directly. Calendar invitations and Google/Outlook sync are not connected yet.</p>

    {(selected || composer) && <div className="schedule-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) { setSelected(null); setComposer(false); setEditing(false); } }}>
      <aside className="schedule-drawer" role="dialog" aria-modal="true" aria-label={composer ? `${editing && selected ? "Edit" : "Schedule"} ${kind}` : "Schedule item details"}>
        <header className="schedule-drawer-head"><div><span className={`schedule-event-type ${composer ? kind : selected?.kind}`}><>{composer ? kind === "meeting" ? <Video size={15} /> : <Flag size={15} /> : selected?.kind === "meeting" ? <Video size={15} /> : <Flag size={15} />}</></span><div><div className="eyebrow">{composer ? editing && selected ? "UPDATE SCHEDULE" : "ADD TO IMPLEMENTATION" : selected?.kind === "meeting" ? "CUSTOMER MEETING" : "DELIVERY MILESTONE"}</div><h2>{composer ? editing && selected ? "Edit schedule item" : kind === "meeting" ? "Schedule a meeting" : "Add a milestone" : selected?.title}</h2></div></div><button className="icon-button" aria-label="Close" onClick={() => { setSelected(null); setComposer(false); setEditing(false); }}><X size={17} /></button></header>
        {composer ? <form className="schedule-form" onSubmit={save}>
          {!implementationId && <label>Implementation<select value={draft.implementation_id} onChange={(e) => setDraft({ ...draft, implementation_id: e.target.value })} required>{implementations.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>}
          <label>{kind === "meeting" ? "Meeting name" : "Milestone name"}<input required minLength={2} maxLength={160} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={kind === "meeting" ? "e.g. Weekly delivery review" : "e.g. UAT sign-off"} /></label>
          {kind === "meeting" ? <>
            <label>Meeting type<select value={draft.meeting_type} onChange={(e) => setDraft({ ...draft, meeting_type: e.target.value })}>{typeOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <div className="schedule-form-row"><label>Date<input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} required /></label><label>Timezone<input value={draft.timezone} readOnly aria-label="Local timezone" /></label></div>
            <div className="schedule-form-row"><label>Starts<input type="time" value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} required /></label><label>Ends<input type="time" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} required /></label></div>
            <label>Organizer<select value={draft.organizer_id} onChange={(e) => setDraft({ ...draft, organizer_id: e.target.value })}><option value="">Not assigned</option>{members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email ?? m.user_id}</option>)}</select></label>
            <label>Attendees <small>Names or email addresses, one per line</small><textarea rows={3} value={draft.attendees} onChange={(e) => setDraft({ ...draft, attendees: e.target.value })} placeholder="Customer lead&#10;Implementation manager" /></label>
            <div className="schedule-form-row"><label>Location<input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} maxLength={250} placeholder="Conference room / online" /></label><label>Meeting link<input type="url" value={draft.meeting_url} onChange={(e) => setDraft({ ...draft, meeting_url: e.target.value })} placeholder="https://…" /></label></div>
          </> : <label>Target date<input type="date" value={draft.target_date} onChange={(e) => setDraft({ ...draft, target_date: e.target.value })} required /></label>}
          <label>{kind === "meeting" ? "Agenda and expected outcome" : "Description"}<textarea rows={4} maxLength={10000} value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} placeholder={kind === "meeting" ? "What should the team align on? What decisions or next steps should come out of the meeting?" : "What needs to be true to consider this milestone complete?"} /></label>
          {error && <div className="schedule-error" role="alert">{error}</div>}
          <footer><button type="button" className="button" onClick={() => { setComposer(false); setSelected(null); setEditing(false); }}>Cancel</button><button className="button primary" type="submit" disabled={saving}>{saving ? "Saving…" : editing && selected ? "Save changes" : kind === "meeting" ? "Schedule meeting" : "Add milestone"}</button></footer>
        </form> : selected && <div className="schedule-detail">
          <span className={`schedule-detail-status ${String(selected.status ?? "SCHEDULED").toLowerCase()}`}>{String(selected.status ?? "SCHEDULED").replaceAll("_", " ")}</span>
          <div className="schedule-detail-project"><span className="avatar small">{selected.projectName.slice(0, 1)}</span><span><small>IMPLEMENTATION</small><strong>{selected.projectName}</strong></span><button className="text-button" onClick={() => onOpenImplementation(selected.implementation_id)}>Open project <ArrowRight size={13} /></button></div>
          <div className="schedule-detail-facts"><div><CalendarDays size={16} /><span><small>{selected.kind === "meeting" ? "DATE & TIME" : "TARGET DATE"}</small><strong>{niceDate(selected.eventDate, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}{selected.kind === "meeting" ? ` · ${selected.eventDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}${selected.end_time ? `–${new Date(selected.end_time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : ""}` : ""}</strong></span></div>
            {selected.kind === "meeting" && <><div><Clock3 size={16} /><span><small>MEETING TYPE</small><strong>{typeLabels[selected.meeting_type] ?? "Client meeting"} · {selected.timezone ?? "Local timezone"}</strong></span></div>{selected.attendees?.length > 0 && <div><Users size={16} /><span><small>ATTENDEES</small><strong>{selected.attendees.join(", ")}</strong></span></div>}{(selected.location || selected.meeting_url) && <div>{selected.meeting_url ? <Video size={16} /> : <MapPin size={16} />}<span><small>LOCATION</small><strong>{selected.location || "Online meeting"}</strong></span>{selected.meeting_url && <a href={selected.meeting_url} target="_blank" rel="noreferrer" aria-label="Open meeting link"><ExternalLink size={14} /></a>}</div>}</>}
          </div>
          {(selected.summary || selected.description) && <section className="schedule-detail-agenda"><span>{selected.kind === "meeting" ? "AGENDA & OUTCOME" : "MILESTONE DETAILS"}</span><p>{selected.summary ?? selected.description}</p></section>}
          <footer><button className="button" onClick={() => beginEdit(selected)} disabled={selected.kind === "meeting" ? !canWrite : !canManage}><Pencil size={14} />Edit</button>{selected.status !== "COMPLETED" && selected.status !== "CANCELLED" && <button className="button primary" disabled={saving || (selected.kind === "milestone" && !canManage)} onClick={() => void updateStatus(selected, "COMPLETED")}><Check size={14} />Mark complete</button>}{selected.kind === "meeting" && selected.status === "SCHEDULED" && <button className="text-button danger" disabled={saving || !canWrite} onClick={() => void updateStatus(selected, "CANCELLED")}>Cancel meeting</button>}</footer>
        </div>}
      </aside>
    </div>}
  </div>;
}
