import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const sourceDir = resolve("supabase/migrations");
const outputDir = resolve("supabase/shared-nexus-migrations");
const files = (await readdir(sourceDir)).filter((file) => file.endsWith(".sql")).sort();

export function isolateMigration(sql: string, first: boolean) {
  const isolated = sql
    .replace("-- New-project migration. Never apply to the Nexus database.",
      "-- Isolated Implementation OS migration for the shared Nexus Supabase project.")
    .replaceAll("public.", "implementation_os.")
    .replaceAll("private.", "implementation_os_private.")
    .replaceAll("schema private", "schema implementation_os_private")
    .replaceAll("schema public", "schema implementation_os")
    .replaceAll("create schema if not exists private", "create schema if not exists implementation_os_private");

  return first
    ? `-- Implementation OS only. This schema does not alter Nexus tables.\n` +
        `create schema if not exists implementation_os;\n` +
        `revoke all on schema implementation_os from public;\n` +
        `grant usage on schema implementation_os to authenticated, service_role;\n` +
        isolated
    : isolated;
}

await mkdir(outputDir, { recursive: true });
for (const [index, file] of files.entries()) {
  const source = await readFile(resolve(sourceDir, file), "utf8");
  await writeFile(resolve(outputDir, file), isolateMigration(source, index === 0));
}
