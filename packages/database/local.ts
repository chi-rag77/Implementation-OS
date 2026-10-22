// Local-only PostgreSQL adapter. Never imported by a deployed Supabase request path.
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DataError,
  type Repository,
  type Query,
} from "../../apps/api/src/repository.ts";
import { readableTables, type Row } from "../domain/index.ts";

export const DEMO_USER = "00000000-0000-4000-8000-000000000001";
export const DEMO_WORKSPACE = "WS_AERCHAINDEMO01";
export async function openLocalDatabase(path?: string) {
  if (path) await mkdir(resolve(path), { recursive: true });
  const db = new PGlite(path);
  await db.waitReady;
  const exists = await db.query<{ exists: boolean }>(
    "select exists(select 1 from pg_namespace where nspname='auth')",
  );
  if (!exists.rows[0].exists) {
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema public,auth to authenticated; grant execute on function auth.uid() to authenticated;
    `);
  }
  await db.exec(
    "do $$ begin if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls;end if;end $$; grant usage on schema public to service_role; create table if not exists auth.local_migrations(name text primary key)",
  );
  const files = (await readdir(resolve("supabase/migrations")))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  // Upgrade the first local demo created before the migration ledger existed.
  if (
    exists.rows[0].exists &&
    (
      await db.query<{ name: string | null }>(
        "select to_regclass('public.tasks') as name",
      )
    ).rows[0]?.name
  ) {
    await db.query(
      "insert into auth.local_migrations(name) values($1) on conflict do nothing",
      [files[0]],
    );
  }
  for (const file of files) {
    if (
      (
        await db.query("select name from auth.local_migrations where name=$1", [
          file,
        ])
      ).rows.length
    )
      continue;
    const sql = await readFile(resolve("supabase/migrations", file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into auth.local_migrations(name) values($1)", [
        file,
      ]);
    });
  }
  return db;
}
const safeName = (value: string) => {
  if (!/^[a-z_]+$/.test(value)) throw new Error("Invalid identifier");
  return `"${value}"`;
};
export class LocalRepository implements Repository {
  constructor(
    public db: PGlite,
    private userId: string,
    private requestId = "local-demo",
  ) {}
  private async query(sql: string, values: unknown[] = []) {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.query(
          "select set_config('request.jwt.claim.sub',$1,true),set_config('app.request_id',$2,true)",
          [this.userId, this.requestId],
        );
        await tx.exec("set local role authenticated");
        // Match the JSON dates delivered by PostgREST; PGlite emits Date objects.
        return JSON.parse(
          JSON.stringify((await tx.query<Row>(sql, values)).rows),
        ) as Row[];
      });
    } catch (e: any) {
      throw new DataError(e.code ?? "DATABASE_ERROR");
    }
  }
  private table(name: string) {
    if (!(readableTables as readonly string[]).includes(name))
      throw new Error("Unknown table");
    return `public.${safeName(name)}`;
  }
  async list(table: string, filters: Query = {}, limit = 100, offset = 0) {
    const entries = Object.entries(filters),
      clauses = entries.map(([key], i) => `${safeName(key)}=$${i + 1}`);
    return this.query(
      `select * from ${this.table(table)} ${clauses.length ? "where " + clauses.join(" and ") : ""} order by ${table === "workspace_members" ? "joined_at" : "created_at"} desc,id limit $${entries.length + 1} offset $${entries.length + 2}`,
      [...entries.map(([, v]) => v), limit, offset],
    );
  }
  async insert(table: string, row: Record<string, unknown>) {
    const entries = Object.entries(row);
    return (
      await this.query(
        `insert into ${this.table(table)} (${entries.map(([k]) => safeName(k)).join(",")}) values (${entries.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
        entries.map(([, v]) => v),
      )
    )[0];
  }
  async update(
    table: string,
    id: string,
    workspace: string,
    row: Record<string, unknown>,
  ) {
    const entries = Object.entries(row);
    return (
      (
        await this.query(
          `update ${this.table(table)} set ${entries.map(([k], i) => `${safeName(k)}=$${i + 1}`).join(",")} where id=$${entries.length + 1} and workspace_id=$${entries.length + 2} returning *`,
          [...entries.map(([, v]) => v), id, workspace],
        )
      )[0] ?? null
    );
  }
  async bootstrap(name: string, slug: string) {
    return (
      await this.query("select * from public.create_first_workspace($1,$2)", [
        name,
        slug,
      ])
    )[0];
  }
  async createFromPlaybook(input: {
    workspace_id: string; company_id: string; playbook_id: string; name: string;
    description?: string; target_go_live_date?: string | null;
  }) {
    return (await this.query(
      "select * from public.create_implementation_from_playbook($1,$2,$3,$4,$5,$6)",
      [input.workspace_id,input.company_id,input.playbook_id,input.name,
        input.description ?? null,input.target_go_live_date ?? null],
    ))[0];
  }
  async applyPlanProposal(workspaceId: string, proposalId: string, acknowledgeOpenQuestions: boolean) {
    return (await this.query("select * from public.apply_plan_proposal($1,$2,$3)", [
      workspaceId, proposalId, acknowledgeOpenQuestions,
    ]))[0];
  }
  async revisePlanProposal(workspaceId: string, proposalId: string, expectedRevision: number, values: Record<string, unknown>) {
    const entries = Object.entries(values);
    return (await this.query(
      `update public.plan_proposals set ${entries.map(([key], i) => `${safeName(key)}=$${i + 1}`).join(",")}
       where workspace_id=$${entries.length + 1} and id=$${entries.length + 2}
         and revision=$${entries.length + 3} and status='DRAFT' returning *`,
      [...entries.map(([, value]) => value), workspaceId, proposalId, expectedRevision],
    ))[0] ?? null;
  }
}
