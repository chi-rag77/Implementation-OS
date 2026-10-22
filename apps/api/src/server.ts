import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createApp, type Config } from "./app.ts";
import { createAiConfig } from "./ai-provider.ts";
import { createHostedConfig } from "./hosted.ts";
if (existsSync(".env")) loadEnvFile(".env");
const demo = process.env.IMPLEMENTATION_OS_DEMO === "1";
if (demo && process.env.NODE_ENV === "production")
  throw new Error("Local demo cannot run in production.");
let config: Config;
const aiConfig: Pick<Config, "aiProvider" | "aiModel" | "aiPlanModel" | "generateDocument" | "generatePlan"> = createAiConfig();
if (demo) {
  const { openLocalDatabase, LocalRepository, DEMO_USER } =
    await import("../../../packages/database/local.ts");
  const { seedDemo } = await import("../../../packages/database/seed.ts");
  const db = await openLocalDatabase(".demo/database");
  await seedDemo(db);
  const { localQueue } = await import("../../../packages/database/queue.ts");
  const { processNextHealthJob } =
    await import("../../../packages/domain/worker.ts");
  let workerBusy = false;
  const timer = setInterval(async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      for (let i = 0; i < 20; i++)
        if (!(await processNextHealthJob(localQueue(db)))) break;
    } catch {
      console.error(JSON.stringify({ code: "LOCAL_WORKER_FAILED" }));
    } finally {
      workerBusy = false;
    }
  }, 1000);
  config = {
    demo: true,
    ...aiConfig,
    origin: process.env.APP_ORIGIN ?? "http://127.0.0.1:5180",
    authenticate: async () => ({
      id: DEMO_USER,
      email: "demo@implementation.local",
      repo: new LocalRepository(db, DEMO_USER),
    }),
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, async () => {
      clearInterval(timer);
      await db.close();
      process.exit(0);
    });
} else {
  config = createHostedConfig();
}
serve(
  {
    fetch: createApp(config).fetch,
    hostname: "127.0.0.1",
    port: Number(process.env.PORT ?? 4100),
  },
  (info) =>
    console.info(
      `Implementation OS API: http://127.0.0.1:${info.port} (${demo ? "isolated local demo" : "Supabase"})`,
    ),
);
