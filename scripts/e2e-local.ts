// Isolated browser-test server. This is never used by the product or production.
// It exercises the real API and local PostgreSQL, with a deterministic AI stand-in
// unless AI_E2E_LIVE=1 is explicitly set for a server-side provider check.
import { mkdtemp, rm } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../apps/api/src/app.ts";
import { createAiConfig } from "../apps/api/src/ai-provider.ts";
import { openLocalDatabase, LocalRepository, DEMO_USER } from "../packages/database/local.ts";
import { seedDemo } from "../packages/database/seed.ts";

const temp = process.env.E2E_DATABASE_PATH ? null : await mkdtemp(join(tmpdir(), "implementation-os-e2e-"));
const db = await openLocalDatabase(process.env.E2E_DATABASE_PATH ?? join(temp!, "database"));
await seedDemo(db);
if (process.env.AI_E2E_LIVE === "1") loadEnvFile(".env");
const liveAi = process.env.AI_E2E_LIVE === "1" ? createAiConfig() : null;
if (process.env.AI_E2E_LIVE === "1" && !liveAi?.generateDocument)
  throw new Error("A server-side AI provider is required for the live E2E browser check.");
const app = createApp({
  demo: true,
  origin: process.env.E2E_APP_ORIGIN ?? "http://127.0.0.1:5185",
  aiProvider: "Local E2E provider",
  aiModel: "deterministic-test",
  authenticate: async () => ({ id: DEMO_USER, email: "demo@implementation.local", repo: new LocalRepository(db, DEMO_USER) }),
  generateDocument: async ({ type, implementation, context }) => {
    const segments = context.meeting_transcript_segments as Array<{ transcript_id: string; text: string }>;
    const segment = segments.find((item) => /onboarding/i.test(item.text)) ?? segments[0];
    const evidence = segment ? [{ transcript_id: segment.transcript_id, excerpt: segment.text.slice(0, 100) }] : [];
    return type === "Kickoff storyboard"
      ? { content: `# Kickoff storyboard\n\n## Project context\n\n${implementation.name} is ready for kickoff review.\n\n## Scope to validate\n\n[CONFIRM: business outcomes and success measures]`, source_notes: ["Project context", ...(segment ? ["Imported transcript"] : [])], open_questions: ["Confirm success measures"], proposals: [] }
      : { content: `# Business Requirements Document\n\n## 1. Executive summary\n\n${implementation.name} is in discovery.\n\n## 3. Scope\n\n[CONFIRM: scope and approvals]\n\n## 7. Functional requirements\n\nThe imported customer statement needs human approval before entering the delivery plan.`, source_notes: ["Project context", ...(segment ? ["Imported transcript"] : [])], open_questions: ["Confirm scope and approval owner"], proposals: evidence.length ? [{ kind: "REQUIREMENT" as const, title: "Customer-requested onboarding capability", description: "Review the customer statement before adding this to delivery scope.", evidence }] : [] };
  },
  ...liveAi,
});
const port = Number(process.env.E2E_API_PORT ?? 4105);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`Isolated E2E API ready at http://127.0.0.1:${port}`);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  if (closing) return;
  closing = true;
  server.close();
  await db.close();
  if (temp) await rm(temp, { recursive: true, force: true });
  process.exit(0);
});
