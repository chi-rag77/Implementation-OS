import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Row } from "../../../packages/domain/index.ts";
export type Query = Record<string, string>;
export interface Repository {
  list(
    table: string,
    filters?: Query,
    limit?: number,
    offset?: number,
  ): Promise<Row[]>;
  insert(table: string, row: Record<string, unknown>): Promise<Row>;
  update(
    table: string,
    id: string,
    workspace: string,
    row: Record<string, unknown>,
  ): Promise<Row | null>;
  bootstrap(name: string, slug: string): Promise<Row>;
  createFromPlaybook(input: {
    workspace_id: string;
    company_id: string;
    playbook_id: string;
    name: string;
    description?: string;
    target_go_live_date?: string | null;
  }): Promise<Row>;
  applyPlanProposal(workspaceId: string, proposalId: string, acknowledgeOpenQuestions: boolean): Promise<Row>;
  revisePlanProposal(workspaceId: string, proposalId: string, expectedRevision: number, values: Record<string, unknown>): Promise<Row | null>;
}
export class DataError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
function unwrap<T>(result: { data: T; error: any }): T {
  if (result.error) throw new DataError(result.error.code ?? "DATABASE_ERROR");
  return result.data;
}
export class SupabaseRepository implements Repository {
  constructor(private client: SupabaseClient, private schema = "public") {}
  private get db() { return this.client.schema(this.schema); }
  async list(table: string, filters: Query = {}, limit = 100, offset = 0) {
    let q = this.db.from(table).select("*");
    for (const [key, value] of Object.entries(filters)) q = q.eq(key, value);
    return (
      unwrap(
        await q
          .order(table === "workspace_members" ? "joined_at" : "created_at", {
            ascending: false,
          })
          .range(offset, offset + limit - 1),
      ) ?? []
    );
  }
  async insert(table: string, row: Record<string, unknown>) {
    return unwrap(await this.db.from(table).insert(row).select().single());
  }
  async update(
    table: string,
    id: string,
    workspace: string,
    row: Record<string, unknown>,
  ) {
    return unwrap(
      await this.db
        .from(table)
        .update(row)
        .eq("id", id)
        .eq("workspace_id", workspace)
        .select()
        .maybeSingle(),
    );
  }
  async bootstrap(name: string, slug: string) {
    return unwrap(
      await this.db.rpc("create_first_workspace", {
        workspace_name: name,
        workspace_slug: slug,
      }),
    );
  }
  async createFromPlaybook(input: {
    workspace_id: string; company_id: string; playbook_id: string; name: string;
    description?: string; target_go_live_date?: string | null;
  }) {
    return unwrap(await this.db.rpc("create_implementation_from_playbook", {
      p_workspace_id: input.workspace_id,
      p_company_id: input.company_id,
      p_playbook_id: input.playbook_id,
      p_name: input.name,
      p_description: input.description ?? null,
      p_target_go_live_date: input.target_go_live_date ?? null,
    }));
  }
  async applyPlanProposal(workspaceId: string, proposalId: string, acknowledgeOpenQuestions: boolean) {
    return unwrap(await this.db.rpc("apply_plan_proposal", {
      p_workspace_id: workspaceId,
      p_proposal_id: proposalId,
      p_acknowledge_open_questions: acknowledgeOpenQuestions,
    }));
  }
  async revisePlanProposal(workspaceId: string, proposalId: string, expectedRevision: number, values: Record<string, unknown>) {
    return unwrap(await this.db.from("plan_proposals").update(values)
      .eq("workspace_id", workspaceId).eq("id", proposalId).eq("revision", expectedRevision)
      .eq("status", "DRAFT").select().maybeSingle());
  }
}
export function userClient(url: string, key: string, token?: string) {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
}
