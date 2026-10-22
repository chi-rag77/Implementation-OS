# AI Implementation OS

An implementation workspace for project plans, schedules, documents, evidence, and human-reviewed AI drafts. This repository contains the current product, a local demo, and a Vercel-ready web/API entry point. The local demo data and API keys are not committed.

## Run locally

```bash
npm ci
npm run demo
```

Open the web address printed by Vite (normally `http://127.0.0.1:5180`). The demo stores its sample data only in `.demo/` on this computer. Do not deploy demo mode.

## Deploy on Vercel

Import `chi-rag77/Implementation-OS` as one Vercel project with the repository root as the Root Directory. `vercel.json` builds the Vite app into `dist/web` and serves the Hono API from `/api`. Use Node.js 22 or later.

Set these server-side environment variables in Vercel:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | The API URL of the existing Nexus Supabase project |
| `SUPABASE_PUBLISHABLE_KEY` | That project's **publishable** key; never a secret/service-role key |
| `IMPLEMENTATION_OS_DB_SCHEMA` | `implementation_os` |
| `APP_ORIGIN` | The exact public URL of this Vercel app, with `https://` and no trailing slash |
| `AI_PROVIDER` | `NVIDIA` if using the current NVIDIA integration |
| `AI_BASE_URL` | `https://integrate.api.nvidia.com/v1` for NVIDIA |
| `AI_API_KEY` | Your NVIDIA API key, server-side only |
| `AI_MODEL` | `nvidia/nemotron-3.5-lightning-30b-a3b` for the current tested draft model |
| `AI_PLAN_MODEL` | `nvidia/nemotron-3.5-lightning-30b-a3b` for the current tested plan model |

AI variables are optional for a basic workspace, but AI draft and plan generation remain unavailable without them. Never put API keys in variables prefixed `VITE_`, in GitHub, or in client code. `IMPLEMENTATION_OS_DEMO` must be unset or `0` on Vercel.

### Shared Supabase project setup

The original `supabase/migrations/` target an **empty, dedicated project** and must **not** be applied to Nexus. The shared Nexus project uses only `supabase/shared-nexus-migrations/`, which creates separate `implementation_os` and `implementation_os_private` schemas. It does not replace Nexus's `public.workspaces`, `public.workspace_members`, or other product tables. Regenerate this isolated set after changing source migrations with `npm run build:shared-schema`.

The isolated migrations have been applied to the existing Supabase project. The `implementation_os` schema is exposed in **Data API → Settings → Exposed schemas**. Existing schemas and table permissions were retained. This is required for `.schema('implementation_os')` queries and RPC calls to resolve.

In **Authentication → URL Configuration**, add the final Vercel app URL to the allowed redirect URLs. Confirmation emails sent by Implementation OS use `APP_ORIGIN`; without this allowlist entry, new-user sign-in may return to Nexus instead. The shared project's existing Nexus user-created trigger is skipped for Implementation OS signups, so a new Implementation OS user does not get an unrelated Nexus workspace.

After deployment, verify `/api/health`, sign-up/confirmation, workspace creation, a document edit, and an AI draft with a test account before inviting customer users. Do not copy `.demo/` into Supabase: it is synthetic local review data.

### Current hosting limits

The hosted API runs as a Vercel Function. The local health-job worker in `scripts/worker.ts` is **not** started by Vercel; automatic health recalculation needs a separately scheduled worker before relying on live health scores. Google Meet capture also remains an unconnected pilot. These limits do not affect local demo or manual project/document workflows.

## Verification

```bash
npm run build:shared-schema
npm run build
npm test
```

The test suite includes an isolated-schema check that creates a mock Nexus `public.workspaces` table, applies all Implementation OS shared-project migrations, and confirms that the Nexus UUID workspace model remains unchanged.
