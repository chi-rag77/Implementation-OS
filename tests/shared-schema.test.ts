import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("shared Nexus migrations keep Implementation OS in its own schema", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      create table public.workspaces(id uuid primary key, name text not null);
      grant usage on schema public, auth to authenticated, service_role;
      grant execute on function auth.uid() to authenticated;
    `);
    const dir = resolve("supabase/shared-nexus-migrations");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files)
      await db.exec(await readFile(resolve(dir, file), "utf8"));

    const { rows } = await db.query<{ nexus_id: string; implementation_id: string; private_schema: string }>(`
      select pg_typeof(n.id)::text as nexus_id,
             pg_typeof(i.id)::text as implementation_id,
             nspname as private_schema
      from public.workspaces n
      right join implementation_os.workspaces i on false
      cross join pg_namespace
      where nspname='implementation_os_private'
      limit 1
    `);
    // The schema can be empty; inspect the catalog without inserting test users.
    const result = await db.query<{ nexus_type: string; implementation_type: string; private_exists: boolean }>(`
      select
        (select format_type(a.atttypid,a.atttypmod) from pg_attribute a
         where a.attrelid='public.workspaces'::regclass and a.attname='id') as nexus_type,
        (select format_type(a.atttypid,a.atttypmod) from pg_attribute a
         where a.attrelid='implementation_os.workspaces'::regclass and a.attname='id') as implementation_type,
        exists(select 1 from pg_namespace where nspname='implementation_os_private') as private_exists
    `);
    assert.equal(rows.length, 0);
    assert.deepEqual(result.rows[0], {
      nexus_type: "uuid",
      implementation_type: "text",
      private_exists: true,
    });
  } finally {
    await db.close();
  }
});
