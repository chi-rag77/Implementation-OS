import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  openLocalDatabase,
  LocalRepository,
  DEMO_USER,
  DEMO_WORKSPACE,
} from "../packages/database/local.ts";
import { seedDemo, uid } from "../packages/database/seed.ts";
import { createApp } from "../apps/api/src/app.ts";
import {
  calculateImplementationHealth,
  can,
  normalizeCompanyWebsite,
} from "../packages/domain/index.ts";
import type { PGlite } from "@electric-sql/pglite";
import { localQueue } from "../packages/database/queue.ts";
import { processNextHealthJob } from "../packages/domain/worker.ts";
let db: PGlite,
  owner: LocalRepository,
  viewer: LocalRepository,
  outsider: LocalRepository;
const VIEWER = uid(9000),
  OUTSIDER = uid(9001),
  WORKSPACE_B = "WS_OTHERTEST0001";
before(async () => {
  process.env.NODE_ENV = "test";
  db = await openLocalDatabase();
  await seedDemo(db);
  owner = new LocalRepository(db, DEMO_USER);
  viewer = new LocalRepository(db, VIEWER);
  outsider = new LocalRepository(db, OUTSIDER);
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now()),($3,$4,now())",
    [VIEWER, "viewer@example.test", OUTSIDER, "outside@example.test"],
  );
  await db.query(
    "insert into workspace_members(workspace_id,user_id,role) values($1,$2,'VIEWER')",
    [DEMO_WORKSPACE, VIEWER],
  );
  await db.query(
    "insert into workspaces(id,name,slug,created_by) values($1,'Other workspace','other-workspace',$2)",
    [WORKSPACE_B, OUTSIDER],
  );
  await db.query(
    "insert into workspace_members(workspace_id,user_id,role) values($1,$2,'OWNER')",
    [WORKSPACE_B, OUTSIDER],
  );
});
after(async () => {
  await db?.close();
});
test("seed provides requested implementation graph counts and is idempotent", async () => {
  assert.equal(await seedDemo(db), false);
  const filter = { workspace_id: DEMO_WORKSPACE, implementation_id: uid(100) };
  for (const [table, n] of [
    ["tasks", 47],
    ["implementation_stages", 9],
    ["milestones", 8],
    ["task_dependencies", 14],
    ["stakeholders", 6],
    ["documents", 12],
  ] as const)
    assert.equal((await owner.list(table, filter)).length, n);
});
test("workspace B cannot read workspace A rows, even with a guessed entity ID", async () => {
  assert.equal((await outsider.list("tasks", { id: uid(1000) })).length, 0);
  assert.equal(
    (await outsider.list("companies", { workspace_id: DEMO_WORKSPACE })).length,
    0,
  );
});
test("workspace B cannot write workspace A or attach its company", async () => {
  await assert.rejects(
    outsider.insert("tasks", {
      workspace_id: DEMO_WORKSPACE,
      implementation_id: uid(100),
      title: "Intrusion",
    }),
  );
  await assert.rejects(
    outsider.insert("implementations", {
      workspace_id: WORKSPACE_B,
      company_id: uid(10),
      name: "Cross tenant",
    }),
  );
});
test("viewer can read but cannot write through PostgreSQL", async () => {
  assert.ok(
    (await viewer.list("tasks", { workspace_id: DEMO_WORKSPACE })).length,
  );
  const original = (await owner.list("tasks", { id: uid(1000) }))[0];
  assert.equal(
    await viewer.update("tasks", uid(1000), DEMO_WORKSPACE, { title: "No" }),
    null,
  );
  assert.equal(
    (await owner.list("tasks", { id: uid(1000) }))[0].title,
    original.title,
  );
  await assert.rejects(
    viewer.insert("tasks", {
      workspace_id: DEMO_WORKSPACE,
      implementation_id: uid(100),
      title: "No",
    }),
  );
});
test("same tenant cannot link a stage from another implementation", async () => {
  await assert.rejects(
    owner.insert("tasks", {
      workspace_id: DEMO_WORKSPACE,
      implementation_id: uid(101),
      stage_id: uid(200),
      title: "Invalid stage",
    }),
  );
});
test("cyclic and self dependencies are rejected", async () => {
  await assert.rejects(
    owner.insert("task_dependencies", {
      workspace_id: DEMO_WORKSPACE,
      implementation_id: uid(100),
      task_id: uid(1000),
      depends_on_task_id: uid(1001),
    }),
  );
  await assert.rejects(
    owner.insert("task_dependencies", {
      workspace_id: DEMO_WORKSPACE,
      implementation_id: uid(100),
      task_id: uid(1000),
      depends_on_task_id: uid(1000),
    }),
  );
});
test("task update creates immutable audit, activity and outbox atomically", async () => {
  await owner.update("tasks", uid(1031), DEMO_WORKSPACE, {
    status: "COMPLETED",
  });
  const audit = await owner.list("audit_logs", { entity_id: uid(1031) });
  assert.equal(audit[0].actor_id, DEMO_USER);
  assert.equal(audit[0].action, "TASK_COMPLETED");
  assert.ok(
    (await owner.list("activity_events", { entity_id: uid(1031) })).length,
  );
  assert.ok((await owner.list("jobs", { implementation_id: uid(100) })).length);
  await assert.rejects(
    owner.update("audit_logs", audit[0].id, DEMO_WORKSPACE, {
      action: "TAMPERED",
    }),
  );
});
test("record workspace and implementation identities cannot be moved", async () => {
  await assert.rejects(
    owner.update("tasks", uid(1000), DEMO_WORKSPACE, {
      implementation_id: uid(101),
    }),
  );
});
test("suspended tenant immediately loses data access", async () => {
  await db.query("update workspaces set status='SUSPENDED' where id=$1", [
    DEMO_WORKSPACE,
  ]);
  assert.equal(
    (await owner.list("tasks", { workspace_id: DEMO_WORKSPACE })).length,
    0,
  );
  await db.query("update workspaces set status='ACTIVE' where id=$1", [
    DEMO_WORKSPACE,
  ]);
});
test("provenance has graph foreign keys and cannot link tenants", async () => {
  const edges = await owner.list("evidence_links", {
    workspace_id: DEMO_WORKSPACE,
  });
  assert.equal(edges.length, 3);
  await assert.rejects(
    outsider.insert("evidence_links", {
      ...edges[0],
      id: crypto.randomUUID(),
      workspace_id: WORKSPACE_B,
    }),
  );
});
test("workspace bootstrap is retry-safe and assigns OWNER server-side", async () => {
  const w = await outsider.bootstrap("Other workspace", "other-workspace");
  assert.equal(w.id, WORKSPACE_B);
  assert.equal(
    (await outsider.list("workspace_members", { workspace_id: w.id }))[0].role,
    "OWNER",
  );
});
test("health with no evidence is unknown; no fake score or AI confidence", () => {
  const h = calculateImplementationHealth({
    tasks: [],
    milestones: [],
    requirements: [],
    risks: [],
    dependencies: [],
  });
  assert.equal(h.health_score, null);
  assert.equal(h.health_status, "UNKNOWN");
  assert.equal(h.confidence, 0);
});
test("health signals include source IDs and cancelled tasks are excluded", () => {
  const h = calculateImplementationHealth({
    tasks: [
      {
        id: "one",
        workspace_id: "w",
        status: "BLOCKED",
        due_date: "2020-01-01",
      },
      { id: "two", workspace_id: "w", status: "CANCELLED" },
    ],
    milestones: [],
    requirements: [],
    risks: [],
    dependencies: [],
  });
  assert.equal(h.total, 1);
  assert.deepEqual(h.signals[0].entity_ids, ["one"]);
  assert.ok(h.health_score! < 100);
});
test("RBAC and URL normalization reject unsafe values", () => {
  assert.equal(can("VIEWER", "work.write"), false);
  assert.equal(can("IMPLEMENTATION_MEMBER", "plan.manage"), false);
  assert.deepEqual(normalizeCompanyWebsite("https://www.aerchain.com/a"), {
    website: "https://www.aerchain.com",
    domain: "aerchain.com",
  });
  assert.throws(() => normalizeCompanyWebsite("http://127.0.0.1"));
});
test("health worker leases jobs and stale workers cannot complete them", async () => {
  const queue = localQueue(db),
    job = await queue.claim();
  assert.ok(job);
  assert.equal(job.status, "PROCESSING");
  assert.equal(
    await queue.complete(
      { ...job, lease_token: crypto.randomUUID() },
      100,
      "HEALTHY",
    ),
    false,
  );
  await queue.fail(job);
  assert.equal((await owner.list("jobs", { id: job.id }))[0].status, "QUEUED");
  assert.equal(await processNextHealthJob(queue), true);
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.exec("set local role authenticated");
      await tx.query("select * from public.claim_health_job()");
    }),
  );
});
test("API denies unauthenticated requests, invalid inputs, viewer writes and workspace spoofing", async () => {
  const app = createApp({
    demo: false,
    origin: "http://localhost",
    authenticate: async (token) =>
      token === "owner"
        ? { id: DEMO_USER, email: "owner@example.test", repo: owner }
        : token === "viewer"
          ? { id: VIEWER, email: "viewer@example.test", repo: viewer }
          : null,
  });
  assert.equal((await app.request("/api/v1/tasks")).status, 401);
  const headers = {
    Authorization: "Bearer owner",
    "X-Workspace-Id": WORKSPACE_B,
  };
  assert.equal((await app.request("/api/v1/tasks", { headers })).status, 403);
  const vh = {
    Authorization: "Bearer viewer",
    "X-Workspace-Id": DEMO_WORKSPACE,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await app.request("/api/v1/tasks", {
        method: "POST",
        headers: vh,
        body: JSON.stringify({ title: "Denied", implementation_id: uid(100) }),
      })
    ).status,
    403,
  );
  const oh = { ...vh, Authorization: "Bearer owner" };
  const bad = await app.request("/api/v1/tasks", {
    method: "POST",
    headers: oh,
    body: JSON.stringify({
      title: "Bad",
      implementation_id: uid(100),
      workspace_id: WORKSPACE_B,
    }),
  });
  assert.equal(bad.status, 422);
  const overview = await app.request(
    `/api/v1/implementations/${uid(100)}/overview`,
    { headers: oh },
  );
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).data.tasks.length, 47);
  assert.equal(
    (
      await app.request("/api/v1/ai/chat", {
        method: "POST",
        headers: oh,
        body: "{}",
      })
    ).status,
    503,
  );
  const search = await app.request("/api/v1/search?q=SAP", { headers: oh });
  assert.equal(search.status, 200);
  assert.ok((await search.json()).data.length);
});

test("organization intelligence publishes immutable versions and launches an atomic playbook snapshot", async () => {
  const app = createApp({
    demo: false,
    origin: "http://localhost",
    authenticate: async (token) => token === "owner"
      ? { id: DEMO_USER, email: "owner@example.test", repo: owner }
      : token === "viewer"
        ? { id: VIEWER, email: "viewer@example.test", repo: viewer }
        : token === "outsider"
          ? { id: OUTSIDER, email: "outside@example.test", repo: outsider }
          : null,
  });
  const headers = { Authorization: "Bearer owner", "X-Workspace-Id": DEMO_WORKSPACE, "Content-Type": "application/json" };
  const post = (path: string, body: unknown, h = headers) => app.request(`/api/v1/${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  const patch = (path: string, body: unknown) => app.request(`/api/v1/${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  const draftResponse = await post("intelligence/playbooks", { name: "Enterprise delivery", implementation_type: "ENTERPRISE" });
  assert.equal(draftResponse.status, 201);
  const draft = (await draftResponse.json()).data;
  assert.equal((await post(`intelligence/playbooks/${draft.id}/publish`, {})).status, 422);
  const snapshot = { stages: [{ key: "kickoff", name: "Kickoff", description: "Align scope", entry_criteria: "Sponsor identified", exit_criteria: "Plan accepted", duration_days: 5, approval_required: true, tasks: [{ title: "Confirm stakeholders", description: "Validate sponsor", priority: "HIGH" }], milestones: [{ name: "Kickoff approved", description: "Customer validates plan" }] }] };
  assert.equal((await patch(`intelligence/playbooks/${draft.id}`, { draft_snapshot: snapshot })).status, 200);
  const publication = await post(`intelligence/playbooks/${draft.id}/publish`, {});
  assert.equal(publication.status, 200);
  assert.equal((await publication.json()).data.published_version, 1);
  const versions = await app.request(`/api/v1/intelligence/playbooks/${draft.id}/versions`, { headers });
  assert.equal(versions.status, 200);
  const firstVersion = (await versions.json()).data[0];
  assert.equal(firstVersion.snapshot.stages[0].name, snapshot.stages[0].name);
  assert.equal(firstVersion.snapshot.implementation_type, "ENTERPRISE");
  assert.equal(firstVersion.snapshot.stages[0].tasks[0].title, snapshot.stages[0].tasks[0].title);
  await assert.rejects(owner.update("playbook_versions", firstVersion.id, DEMO_WORKSPACE, { version: 22 }));
  const launched = await post("implementations/from-playbook", { name: "Playbook launch test", company_id: uid(10), playbook_id: draft.id });
  assert.equal(launched.status, 201);
  const project = (await launched.json()).data;
  assert.equal(project.playbook_snapshot.version, 1);
  assert.equal(project.playbook_snapshot.stages[0].name, "Kickoff");
  const launchedStages = await owner.list("implementation_stages", { workspace_id: DEMO_WORKSPACE, implementation_id: project.id });
  assert.equal(launchedStages.length, 1);
  assert.equal(launchedStages[0].exit_criteria, "Plan accepted");
  assert.equal(launchedStages[0].approval_required, true);
  assert.equal((await owner.list("tasks", { workspace_id: DEMO_WORKSPACE, implementation_id: project.id })).length, 1);
  assert.equal((await owner.list("milestones", { workspace_id: DEMO_WORKSPACE, implementation_id: project.id })).length, 1);
  assert.equal((await patch(`intelligence/playbooks/${draft.id}`, { name: "Enterprise delivery revised", implementation_type: "MID_MARKET" })).status, 200);
  const availableBeforeRepublish = await app.request("/api/v1/intelligence/playbooks/available", { headers });
  assert.equal((await availableBeforeRepublish.json()).data[0].name, "Enterprise delivery");
  assert.equal((await post(`intelligence/playbooks/${draft.id}/publish`, {})).status, 200);
  const secondLaunch = await post("implementations/from-playbook", { name: "New version launch", company_id: uid(10), playbook_id: draft.id });
  const secondProject = (await secondLaunch.json()).data;
  assert.equal(secondProject.playbook_snapshot.version, 2);
  assert.equal(secondProject.implementation_type, "MID_MARKET");
  assert.equal((await owner.list("implementations", { id: project.id }))[0].playbook_snapshot.version, 1);
  assert.equal((await post("implementations/from-playbook", { name: "Cross tenant launch", company_id: uid(10), playbook_id: draft.id }, { ...headers, Authorization: "Bearer outsider", "X-Workspace-Id": WORKSPACE_B })).status, 409);
  assert.equal((await post("intelligence/assets", { kind: "STANDARD", name: "Delivery policy", content: "Customer sign-off is required before go-live." }, { ...headers, Authorization: "Bearer viewer" })).status, 403);
  const assetResponse = await post("intelligence/assets", { kind: "STANDARD", name: "Delivery policy", content: "Customer sign-off is required before go-live.", authority: "POLICY" });
  assert.equal(assetResponse.status, 201);
  const asset = (await assetResponse.json()).data;
  assert.equal((await post(`intelligence/assets/${asset.id}/publish`, {})).status, 200);
  const assetVersions = await app.request(`/api/v1/intelligence/assets/${asset.id}/versions`, { headers });
  assert.equal((await assetVersions.json()).data[0].snapshot.authority, "POLICY");
  assert.equal((await outsider.list("intelligence_assets", { workspace_id: DEMO_WORKSPACE })).length, 0);
  assert.ok((await owner.list("audit_logs", { entity_id: draft.id })).length >= 2);
});

test("document workflow supports draft revisions, review, approval, and viewer restrictions", async () => {
  const app = createApp({
    demo: false,
    origin: "http://localhost",
    authenticate: async (token) =>
      token === "owner"
        ? { id: DEMO_USER, email: "owner@example.test", repo: owner }
        : token === "viewer"
          ? { id: VIEWER, email: "viewer@example.test", repo: viewer }
          : null,
  });
  const implementationId = uid(100);
  const ownerHeaders = {
    Authorization: "Bearer owner",
    "X-Workspace-Id": DEMO_WORKSPACE,
    "Content-Type": "application/json",
  };
  const viewerHeaders = { ...ownerHeaders, Authorization: "Bearer viewer" };
  const created = await app.request("/api/v1/documents", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      implementation_id: implementationId,
      name: "Workflow test BRD",
      type: "BRD",
      content: "# Scope\n\nInitial draft with measurable acceptance criteria.",
      status: "DRAFT",
    }),
  });
  assert.equal(created.status, 201);
  const document = (await created.json()).data;
  assert.equal(document.version, 1);

  const viewerEdit = await app.request(`/api/v1/documents/${document.id}`, {
    method: "PATCH",
    headers: viewerHeaders,
    body: JSON.stringify({ content: "Viewer must not edit this document." }),
  });
  assert.equal(viewerEdit.status, 403);

  const edit = await app.request(`/api/v1/documents/${document.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({
      content:
        "# Scope\n\nRevised draft with measurable acceptance criteria and integration ownership.",
      change_summary: "Clarified scope and acceptance criteria",
    }),
  });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).data.version, 2);

  const versions = await app.request(
    `/api/v1/documents/${document.id}/versions?implementation_id=${implementationId}`,
    { headers: ownerHeaders },
  );
  assert.equal(versions.status, 200);
  assert.equal((await versions.json()).data.length, 2);

  const review = await app.request(`/api/v1/documents/${document.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ status: "IN_REVIEW" }),
  });
  assert.equal(review.status, 200);
  const approval = await app.request(`/api/v1/documents/${document.id}`, {
    method: "PATCH",
    headers: ownerHeaders,
    body: JSON.stringify({ status: "APPROVED" }),
  });
  assert.equal(approval.status, 200);

  const viewerApprovedEdit = await app.request(
    `/api/v1/documents/${document.id}`,
    {
      method: "PATCH",
      headers: viewerHeaders,
      body: JSON.stringify({
        content: "Viewer must not change an approved document.",
      }),
    },
  );
  assert.equal(viewerApprovedEdit.status, 403);

  const noAi = await app.request("/api/v1/documents/generate", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      implementation_id: implementationId,
      type: "BRD",
      notes: "The provider must be explicit before project data is sent.",
    }),
  });
  assert.equal(noAi.status, 503);
  assert.equal((await noAi.json()).error.code, "AI_NOT_CONFIGURED");
});

test("autopilot imports transcripts idempotently and preserves the workflow when AI is unavailable", async () => {
  const app = createApp({
    demo: false,
    origin: "http://localhost",
    authenticate: async (token) => token === "owner"
      ? { id: DEMO_USER, email: "owner@example.test", repo: owner }
      : token === "viewer" ? { id: VIEWER, email: "viewer@example.test", repo: viewer } : null,
  });
  const ownerHeaders = { Authorization: "Bearer owner", "X-Workspace-Id": DEMO_WORKSPACE, "Content-Type": "application/json" };
  const viewerHeaders = { ...ownerHeaders, Authorization: "Bearer viewer" };
  const implementationId = uid(100);
  const denied = await app.request("/api/v1/autopilot/runs", { method: "POST", headers: viewerHeaders, body: JSON.stringify({ implementation_id: implementationId }) });
  assert.equal(denied.status, 403);
  const started = await app.request("/api/v1/autopilot/runs", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ implementation_id: implementationId }) });
  assert.equal(started.status, 201);
  const run = (await started.json()).data;
  const transcript = "[00:00:12] Alex: We need the supplier onboarding process live in Europe by June.\n[00:00:30] Priya: I will confirm the country rollout and success measure.";
  const imported = await app.request(`/api/v1/autopilot/runs/${run.id}/transcripts`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ title: "Discovery call", content: transcript }) });
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).data.segment_count, 2);
  const duplicate = await app.request(`/api/v1/autopilot/runs/${run.id}/transcripts`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ title: "Duplicate", content: transcript }) });
  assert.equal(duplicate.status, 201);
  const dupData = (await duplicate.json()).data;
  assert.equal(dupData.duplicate, true);
  assert.equal((await owner.list("meeting_transcripts", { meeting_id: dupData.meeting.id, workspace_id: DEMO_WORKSPACE })).length, 2);
  const generation = await app.request(`/api/v1/autopilot/runs/${run.id}/generate`, { method: "POST", headers: ownerHeaders, body: "{}" });
  assert.equal(generation.status, 503);
  assert.equal((await generation.json()).error.code, "AI_NOT_CONFIGURED");
  const resumed = await app.request(`/api/v1/autopilot/runs/${run.id}`, { headers: ownerHeaders });
  const resumedRun = (await resumed.json()).data;
  assert.equal(resumedRun.status, "FAILED");
  assert.equal(resumedRun.last_error_code, "AI_NOT_CONFIGURED");
  assert.equal(resumedRun.source_meetings[0].segment_count, 2);
  const resumedResponse = await app.request(`/api/v1/autopilot/runs/${run.id}/resume`, { method: "POST", headers: ownerHeaders, body: "{}" });
  assert.equal(resumedResponse.status, 200);
  assert.equal((await resumedResponse.json()).data.status, "READY");
  const meetingJoin = await app.request(`/api/v1/autopilot/runs/${run.id}/meetings/join`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ meeting_url: "https://meet.google.com/abc-defg-hij" }) });
  assert.equal(meetingJoin.status, 503);
  assert.equal((await meetingJoin.json()).error.code, "MEETING_PROVIDER_NOT_CONFIGURED");
  const templates = await app.request(`/api/v1/autopilot/runs/${run.id}/prepare-templates`, { method: "POST", headers: ownerHeaders, body: "{}" });
  assert.equal(templates.status, 200);
  const templateRun = (await templates.json()).data;
  assert.equal(templateRun.status, "WAITING_APPROVAL");
  assert.equal(templateRun.storyboard.status, "DRAFT");
  assert.equal(templateRun.brd.status, "DRAFT");
  assert.match(templateRun.brd.content, /transcript excerpts \(verbatim; not AI-analyzed\)/);
  const cancelled = await app.request(`/api/v1/autopilot/runs/${run.id}/cancel`, { method: "POST", headers: ownerHeaders, body: "{}" });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).data.status, "CANCELLED");
  const cannotResumeClosed = await app.request(`/api/v1/autopilot/runs/${run.id}/resume`, { method: "POST", headers: ownerHeaders, body: "{}" });
  assert.equal(cannotResumeClosed.status, 409);
});

test("autopilot validates exact transcript evidence and writes delivery records only after manager approval", async () => {
  const implementationId = uid(100);
  const ownerHeaders = { Authorization: "Bearer owner", "X-Workspace-Id": DEMO_WORKSPACE, "Content-Type": "application/json" };
  const viewerHeaders = { ...ownerHeaders, Authorization: "Bearer viewer" };
  const base = {
    demo: false,
    origin: "http://localhost",
    authenticate: async (token: string | undefined) => token === "owner"
      ? { id: DEMO_USER, email: "owner@example.test", repo: owner }
      : token === "viewer" ? { id: VIEWER, email: "viewer@example.test", repo: viewer } : null,
  };
  const exactExcerpt = "We need the supplier onboarding process live in Europe by June.";
  let transcriptId = "";
  let calls = 0;
  const app = createApp({ ...base, generateDocument: async () => {
    calls++;
    return calls === 1
      ? { content: "# Kickoff storyboard\n\n## Outcomes\n\nConfirm the business measures before presenting.", source_notes: ["Implementation scope"], open_questions: ["Confirm measures"], proposals: [] }
      : { content: "# Business requirements\n\n## Scope\n\nRequirements remain a human-reviewed draft until approved.", source_notes: ["Imported discovery transcript"], open_questions: ["Confirm country rollout"], proposals: [{ kind: "REQUIREMENT", title: "Launch supplier onboarding in Europe by June", description: "Target rollout stated during discovery.", evidence: [{ transcript_id: transcriptId, excerpt: exactExcerpt }] }] };
  } });
  const created = await app.request("/api/v1/autopilot/runs", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ implementation_id: implementationId }) });
  const run = (await created.json()).data;
  const imported = await app.request(`/api/v1/autopilot/runs/${run.id}/transcripts`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ title: "Evidence review call", content: `[00:00:12] Alex: ${exactExcerpt}` }) });
  const meeting = (await imported.json()).data.meeting;
  transcriptId = (await owner.list("meeting_transcripts", { meeting_id: meeting.id, workspace_id: DEMO_WORKSPACE }))[0].id;
  const beforeCount = (await owner.list("requirements", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length;
  const beforeEvidenceCount = (await owner.list("evidence_links", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length;
  const generated = await app.request(`/api/v1/autopilot/runs/${run.id}/generate`, { method: "POST", headers: ownerHeaders, body: "{}" });
  assert.equal(generated.status, 200);
  const generatedRun = (await generated.json()).data;
  assert.equal(generatedRun.status, "WAITING_APPROVAL");
  assert.equal(generatedRun.storyboard.type, "KICKOFF_STORYBOARD");
  assert.equal(generatedRun.brd.type, "BRD");
  assert.equal(generatedRun.proposals[0].evidence[0].timestamp_ms, 12000);
  assert.match(generatedRun.brd.content, /Meeting evidence · pending human validation/);
  assert.match(generatedRun.brd.content, /Discovery|Evidence review call/);
  assert.match(generatedRun.brd.content, /We need the supplier onboarding process live in Europe by June/);
  assert.equal((await owner.list("requirements", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length, beforeCount);
  const viewerApproval = await app.request(`/api/v1/autopilot/proposals/${generatedRun.proposals[0].id}/decision`, { method: "POST", headers: viewerHeaders, body: JSON.stringify({ decision: "APPROVED" }) });
  assert.equal(viewerApproval.status, 403);
  const approved = await app.request(`/api/v1/autopilot/proposals/${generatedRun.proposals[0].id}/decision`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ decision: "APPROVED" }) });
  assert.equal(approved.status, 200);
  assert.equal((await owner.list("requirements", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length, beforeCount + 1);
  assert.equal((await owner.list("evidence_links", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length, beforeEvidenceCount + 1);
  for (const doc of [generatedRun.storyboard, generatedRun.brd]) {
    const blocked = await app.request(`/api/v1/documents/${doc.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "APPROVED" }) });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error.code, "OPEN_QUESTIONS_REMAIN");
    const review = await app.request(`/api/v1/documents/${doc.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "IN_REVIEW", open_questions: [], change_summary: "Open questions reviewed with project owner" }) });
    assert.equal(review.status, 200);
    const result = await app.request(`/api/v1/documents/${doc.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ status: "APPROVED" }) });
    assert.equal(result.status, 200);
  }
  const completed = await app.request(`/api/v1/autopilot/runs/${run.id}/complete`, { method: "POST", headers: ownerHeaders, body: "{}" });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).data.status, "COMPLETED");
});

test("autopilot rejects invented citations without publishing drafts or delivery records", async () => {
  const implementationId = uid(101);
  const headers = { Authorization: "Bearer owner", "X-Workspace-Id": DEMO_WORKSPACE, "Content-Type": "application/json" };
  const app = createApp({
    demo: false,
    origin: "http://localhost",
    authenticate: async () => ({ id: DEMO_USER, email: "owner@example.test", repo: owner }),
    generateDocument: async ({ type }) => type === "Kickoff storyboard"
      ? { content: "# Kickoff storyboard\n\n## Scope\n\nThe scope is still awaiting customer confirmation.", source_notes: [], open_questions: [], proposals: [] }
      : { content: "# Business Requirements Document\n\n## Scope\n\nCustomer scope requires confirmation before approval.", source_notes: [], open_questions: [], proposals: [{ kind: "REQUIREMENT" as const, title: "Invented requirement", description: "Not present in the transcript", evidence: [{ transcript_id: uid(99999), excerpt: "A statement the customer never made" }] }] },
  });
  const started = await app.request("/api/v1/autopilot/runs", { method: "POST", headers, body: JSON.stringify({ implementation_id: implementationId }) });
  const run = (await started.json()).data;
  const imported = await app.request(`/api/v1/autopilot/runs/${run.id}/transcripts`, { method: "POST", headers, body: JSON.stringify({ title: "Discovery", content: "[00:00:02] Customer: Please confirm the rollout date with our team." }) });
  assert.equal(imported.status, 201);
  const beforeDocs = (await owner.list("documents", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length;
  const beforeRequirements = (await owner.list("requirements", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length;
  const generated = await app.request(`/api/v1/autopilot/runs/${run.id}/generate`, { method: "POST", headers, body: "{}" });
  assert.equal(generated.status, 422);
  assert.equal((await generated.json()).error.code, "UNVERIFIED_EVIDENCE");
  assert.equal((await owner.list("documents", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length, beforeDocs);
  assert.equal((await owner.list("requirements", { implementation_id: implementationId, workspace_id: DEMO_WORKSPACE })).length, beforeRequirements);
});

test("autopilot keeps a completed draft when the other provider call fails and retries only the missing draft", async () => {
  const implementationId = uid(102);
  const headers = { Authorization: "Bearer owner", "X-Workspace-Id": DEMO_WORKSPACE, "Content-Type": "application/json" };
  let storyboardCalls = 0;
  let brdCalls = 0;
  const app = createApp({
    demo: false,
    origin: "http://localhost",
    authenticate: async () => ({ id: DEMO_USER, email: "owner@example.test", repo: owner }),
    generateDocument: async ({ type }) => {
      if (type === "Kickoff storyboard") {
        storyboardCalls++;
        return { content: "# Kickoff storyboard\n\n## Scope\n\nConfirm the project scope and customer outcomes during kickoff.", source_notes: [], open_questions: [], proposals: [] };
      }
      brdCalls++;
      if (brdCalls === 1) {
        const error = new Error("Provider did not finish in time");
        error.name = "AI_PROVIDER_TIMEOUT";
        throw error;
      }
      return { content: "# Business requirements\n\n## Scope\n\nThe confirmed scope remains open for human review before sign-off.", source_notes: [], open_questions: [], proposals: [] };
    },
  });
  const started = await app.request("/api/v1/autopilot/runs", { method: "POST", headers, body: JSON.stringify({ implementation_id: implementationId }) });
  const run = (await started.json()).data;
  const first = await app.request(`/api/v1/autopilot/runs/${run.id}/generate`, { method: "POST", headers, body: "{}" });
  assert.equal(first.status, 502);
  assert.equal((await first.json()).error.code, "AI_PROVIDER_TIMEOUT");
  const failed = (await (await app.request(`/api/v1/autopilot/runs/${run.id}`, { headers })).json()).data;
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.storyboard.status, "DRAFT");
  assert.equal(failed.brd, null);
  const storyboardId = failed.storyboard.id;
  const retried = await app.request(`/api/v1/autopilot/runs/${run.id}/generate`, { method: "POST", headers, body: "{}" });
  assert.equal(retried.status, 200);
  const finished = (await retried.json()).data;
  assert.equal(finished.status, "WAITING_APPROVAL");
  assert.equal(finished.storyboard.id, storyboardId);
  assert.equal(finished.brd.status, "DRAFT");
  assert.equal(storyboardCalls, 1);
  assert.equal(brdCalls, 2);
  const repeated = await app.request(`/api/v1/autopilot/runs/${run.id}/generate`, { method: "POST", headers, body: "{}" });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).data.status, "WAITING_APPROVAL");
  assert.equal(storyboardCalls, 1);
  assert.equal(brdCalls, 2);
});
