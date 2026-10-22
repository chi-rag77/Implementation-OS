import { rename, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { openLocalDatabase } from "../packages/database/local.ts";
import { seedDemo } from "../packages/database/seed.ts";
const path = resolve(".demo/database");
if (process.env.NODE_ENV === "production")
  throw new Error("Demo commands are disabled in production.");
if (process.argv[2] === "reset") {
  await mkdir(resolve(".demo/backups"), { recursive: true });
  try {
    await access(path);
    await rename(path, resolve(".demo/backups", `database-${Date.now()}`));
    console.info(
      "Previous local demo preserved in .demo/backups. Stop the demo server before restarting.",
    );
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}
const db = await openLocalDatabase(path);
console.info(
  (await seedDemo(db))
    ? "Seeded Aerchain demo: 5 implementations; Danone has 9 stages, 47 tasks, 8 milestones, 14 dependencies, 6 stakeholders and 12 document metadata records."
    : "Demo already seeded; no records changed.",
);
await db.close();
