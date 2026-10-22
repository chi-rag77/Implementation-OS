// Separate production process; this server-side secret is never used by API requests.
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { userClient, SupabaseRepository } from "../apps/api/src/repository.ts";
import { all } from "../apps/api/src/app.ts";
import {
  processNextHealthJob,
  type HealthQueue,
} from "../packages/domain/worker.ts";
if (existsSync(".env")) loadEnvFile(".env");
const url = process.env.SUPABASE_URL,
  key = process.env.SUPABASE_WORKER_SECRET_KEY;
if (!url || !key)
  throw new Error(
    "Worker requires SUPABASE_URL and server-only SUPABASE_WORKER_SECRET_KEY.",
  );
const client = userClient(url, key),
  repo = new SupabaseRepository(client);
const rpc = async (name: string, args?: Record<string, unknown>) => {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error("WORKER_DATABASE_ERROR");
  return data;
};
const queue: HealthQueue = {
  claim: async () => (await rpc("claim_health_job"))[0] ?? null,
  records: (table, w, i) =>
    all(repo, table, { workspace_id: w, implementation_id: i }),
  complete: (job, score, health) =>
    rpc("complete_health_job", {
      job_id: job.id,
      token: job.lease_token,
      score,
      health,
    }),
  fail: async (job) => {
    await rpc("fail_health_job", { job_id: job.id, token: job.lease_token });
  },
};
let running = true;
process.once("SIGINT", () => {
  running = false;
});
process.once("SIGTERM", () => {
  running = false;
});
while (running) {
  try {
    if (await processNextHealthJob(queue)) continue;
  } catch {
    console.error(JSON.stringify({ code: "WORKER_UNAVAILABLE" }));
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
