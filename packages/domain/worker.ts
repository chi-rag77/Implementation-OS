import { calculateImplementationHealth, type Row } from "./index.ts";
export interface HealthQueue {
  claim(): Promise<Row | null>;
  records(
    table: string,
    workspace: string,
    implementation: string,
  ): Promise<Row[]>;
  complete(job: Row, score: number | null, health: string): Promise<boolean>;
  fail(job: Row): Promise<void>;
}
export async function processNextHealthJob(queue: HealthQueue) {
  const job = await queue.claim();
  if (!job) return false;
  try {
    const [tasks, milestones, requirements, risks, dependencies] =
      await Promise.all(
        [
          "tasks",
          "milestones",
          "requirements",
          "risks",
          "task_dependencies",
        ].map((t) => queue.records(t, job.workspace_id, job.implementation_id)),
      );
    const h = calculateImplementationHealth({
      tasks,
      milestones,
      requirements,
      risks,
      dependencies,
    });
    if (!(await queue.complete(job, h.health_score, h.health_status)))
      console.warn(
        JSON.stringify({
          job_id: job.id,
          code: "LEASE_LOST_OR_WORKSPACE_INACTIVE",
        }),
      );
  } catch {
    await queue.fail(job);
  }
  return true;
}
