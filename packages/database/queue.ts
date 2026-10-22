import type { PGlite } from "@electric-sql/pglite";
import type { HealthQueue } from "../domain/worker.ts";
import type { Row } from "../domain/index.ts";
export function localQueue(db: PGlite): HealthQueue {
  return {
    claim: async () =>
      (await db.query<Row>("select * from public.claim_health_job()"))
        .rows[0] ?? null,
    records: async (table, workspace, implementation) => {
      if (
        ![
          "tasks",
          "milestones",
          "requirements",
          "risks",
          "task_dependencies",
        ].includes(table)
      )
        throw new Error("Unsupported health input");
      return (
        await db.query<Row>(
          `select * from public.${table} where workspace_id=$1 and implementation_id=$2`,
          [workspace, implementation],
        )
      ).rows;
    },
    complete: async (job, score, health) =>
      (
        await db.query<{ ok: boolean }>(
          "select public.complete_health_job($1,$2,$3,$4) as ok",
          [job.id, job.lease_token, score, health],
        )
      ).rows[0].ok,
    fail: async (job) => {
      await db.query("select public.fail_health_job($1,$2)", [
        job.id,
        job.lease_token,
      ]);
    },
  };
}
