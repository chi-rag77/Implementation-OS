// Manual live-provider check. Uses an isolated temporary local database and the
// server-side key from .env; it never changes the running demo or production.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { createApp } from "../apps/api/src/app.ts";
import { createAiConfig } from "../apps/api/src/ai-provider.ts";
import { openLocalDatabase, LocalRepository, DEMO_USER, DEMO_WORKSPACE } from "../packages/database/local.ts";
import { seedDemo, uid } from "../packages/database/seed.ts";

loadEnvFile(".env");
const ai = createAiConfig(process.env, async (url, init) => {
  const response = await fetch(url, init);
  const payload = await response.clone().json().catch(() => ({}));
  const content = payload.choices?.[0]?.message?.content;
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(String(content).trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { /* Report shape, not private draft content. */ }
  console.log(JSON.stringify({ provider_http_status: response.status, finish_reason: payload.choices?.[0]?.finish_reason ?? null, content_length: content?.length ?? null, valid_json: !!parsed, keys: parsed ? Object.keys(parsed) : [], document_length: typeof parsed?.content === "string" ? parsed.content.length : null, proposals_count: Array.isArray(parsed?.proposals) ? parsed.proposals.length : null, error_title: payload.title ?? null, error_code: payload.error?.code ?? null }));
  return response;
});
assert.ok(ai.generateDocument, "A server-side AI provider must be configured.");
const temp = await mkdtemp(join(tmpdir(), "implementation-os-live-ai-"));
const db = await openLocalDatabase(join(temp, "database"));
const implementationId = uid(104);
const repo = new LocalRepository(db, DEMO_USER);
const app = createApp({
  demo: true,
  ...ai,
  origin: "http://127.0.0.1:5182",
  authenticate: async () => ({ id: DEMO_USER, email: "demo@implementation.local", repo }),
});
const headers = { Authorization: "Bearer local-e2e", "X-Workspace-Id": DEMO_WORKSPACE, "Content-Type": "application/json", Origin: "http://127.0.0.1:5182" };
const request = async (path: string, body: unknown) => {
  const response = await app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json();
  return { status: response.status, data: payload.data, error: payload.error };
};

try {
  await seedDemo(db);
  const before = await repo.list("requirements", { implementation_id: implementationId }, 100);
  const started = await request("/api/v1/autopilot/runs", { implementation_id: implementationId });
  assert.equal(started.status, 201);
  const runId = started.data.id as string;
  const imported = await request(`/api/v1/autopilot/runs/${runId}/transcripts`, {
    title: "Synthetic discovery call",
    content: "[00:00:12] Customer: We need supplier onboarding live in Europe by June.\n[00:00:27] Delivery lead: The deployment date and integration scope still need confirmation.",
  });
  assert.equal(imported.status, 201);
  const generated = await request(`/api/v1/autopilot/runs/${runId}/generate`, {});
  if (generated.status !== 200) {
    const saved = await app.request(`/api/v1/autopilot/runs/${runId}`, { headers });
    const savedData = (await saved.json()).data;
    console.log(JSON.stringify({ success: false, step: "generate", status: generated.status, error_code: generated.error?.code, run_status: savedData?.status, transcript_saved: savedData?.source_meeting_ids?.length > 0 }));
    process.exitCode = 1;
  } else {
    const run = generated.data;
    assert.equal(run.status, "WAITING_APPROVAL");
    assert.equal(run.storyboard.status, "DRAFT");
    assert.equal(run.brd.status, "DRAFT");
    assert.ok(run.storyboard.content.length >= 50);
    assert.ok(run.brd.content.length >= 50);
    const after = await repo.list("requirements", { implementation_id: implementationId }, 100);
    assert.equal(after.length, before.length, "AI must not write delivery requirements before approval.");
    console.log(JSON.stringify({ success: true, provider: ai.aiProvider, model: ai.aiModel, run_status: run.status, storyboard_length: run.storyboard.content.length, brd_length: run.brd.content.length, proposals: run.proposals.length, requirements_unchanged: true }));
  }
} finally {
  await db.close();
  await rm(temp, { recursive: true, force: true });
}
