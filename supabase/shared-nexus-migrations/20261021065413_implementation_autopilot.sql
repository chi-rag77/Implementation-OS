-- Implementation Autopilot. Additive, tenant-scoped workflow state.
create table implementation_os.autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  implementation_id uuid not null,
  kind text not null default 'KICKOFF_TO_BRD' check (kind = 'KICKOFF_TO_BRD'),
  status text not null default 'READY' check (status in ('READY','IN_PROGRESS','WAITING_APPROVAL','COMPLETED','FAILED','CANCELLED')),
  current_step text not null default 'PROJECT_CONTEXT' check (current_step in ('PROJECT_CONTEXT','MEETING_CAPTURE','DRAFTING','HUMAN_REVIEW','DELIVERY_RECORDS','COMPLETE')),
  provider_status text not null default 'GOOGLE_MEET_NOT_CONNECTED' check (provider_status in ('GOOGLE_MEET_NOT_CONNECTED','CONNECTED','ERROR')),
  source_meeting_ids uuid[] not null default '{}',
  storyboard_document_id uuid,
  brd_document_id uuid,
  last_error_code text,
  created_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, implementation_id, id),
  foreign key (workspace_id, implementation_id) references implementation_os.implementations(workspace_id,id),
  foreign key (workspace_id, implementation_id, storyboard_document_id) references implementation_os.documents(workspace_id,implementation_id,id),
  foreign key (workspace_id, implementation_id, brd_document_id) references implementation_os.documents(workspace_id,implementation_id,id)
);

create table implementation_os.autopilot_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  implementation_id uuid not null,
  run_id uuid not null,
  proposal_type text not null check (proposal_type in ('REQUIREMENT','ACTION','RISK','DECISION','OPEN_QUESTION')),
  title text not null check (length(title) between 2 and 300),
  description text not null default '',
  evidence_refs jsonb not null default '[]' check (jsonb_typeof(evidence_refs) = 'array'),
  status text not null default 'PROPOSED' check (status in ('PROPOSED','APPROVED','REJECTED')),
  target_entity_id uuid,
  created_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, implementation_id, id),
  foreign key (workspace_id, implementation_id, run_id) references implementation_os.autopilot_runs(workspace_id,implementation_id,id)
);

create index autopilot_runs_impl_idx on implementation_os.autopilot_runs(workspace_id,implementation_id,created_at desc);
create index autopilot_proposals_run_idx on implementation_os.autopilot_proposals(workspace_id,implementation_id,run_id,status);
create unique index meetings_external_id_idx on implementation_os.meetings(workspace_id,implementation_id,external_id) where external_id is not null;

alter table implementation_os.autopilot_runs enable row level security;
alter table implementation_os.autopilot_proposals enable row level security;
revoke all on implementation_os.autopilot_runs, implementation_os.autopilot_proposals from anon, authenticated;
grant select, insert, update on implementation_os.autopilot_runs to authenticated;
grant select, insert, update on implementation_os.autopilot_proposals to authenticated;
create policy autopilot_run_read on implementation_os.autopilot_runs for select to authenticated using (implementation_os_private.allowed(workspace_id));
create policy autopilot_run_insert on implementation_os.autopilot_runs for insert to authenticated with check (implementation_os_private.allowed(workspace_id,'work.write'));
create policy autopilot_run_update on implementation_os.autopilot_runs for update to authenticated using (implementation_os_private.allowed(workspace_id,'work.write')) with check (implementation_os_private.allowed(workspace_id,'work.write'));
create policy autopilot_proposal_read on implementation_os.autopilot_proposals for select to authenticated using (implementation_os_private.allowed(workspace_id));
create policy autopilot_proposal_insert on implementation_os.autopilot_proposals for insert to authenticated with check (implementation_os_private.allowed(workspace_id,'work.write'));
create policy autopilot_proposal_update on implementation_os.autopilot_proposals for update to authenticated using (implementation_os_private.allowed(workspace_id,'plan.manage')) with check (implementation_os_private.allowed(workspace_id,'plan.manage'));

create trigger autopilot_runs_prepare before insert or update on implementation_os.autopilot_runs for each row execute function implementation_os_private.prepare_change();
create trigger autopilot_proposals_prepare before insert or update on implementation_os.autopilot_proposals for each row execute function implementation_os_private.prepare_change();

-- Record workflow/proposal state transitions without putting transcript excerpts or
-- generated document bodies into the general audit log.
create function implementation_os_private.record_autopilot_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare r jsonb := to_jsonb(new); old_r jsonb; entity text; event_name text; impl uuid;
begin
  if tg_op='UPDATE' then old_r:=to_jsonb(old); end if;
  entity:=tg_table_name;
  impl:=nullif(r->>'implementation_id','')::uuid;
  event_name:=upper(entity)||case when tg_op='INSERT' then '_CREATED' else '_UPDATED' end;
  insert into implementation_os.audit_logs(workspace_id,actor_id,action,entity_type,entity_id,before,after,request_id)
  values(r->>'workspace_id',auth.uid(),event_name,entity,r->>'id',
    case when tg_op='UPDATE' then jsonb_build_object('status',old_r->>'status','current_step',old_r->>'current_step') else null end,
    jsonb_build_object('status',r->>'status','current_step',r->>'current_step','proposal_type',r->>'proposal_type'),current_setting('app.request_id',true));
  insert into implementation_os.activity_events(workspace_id,implementation_id,actor_type,actor_id,event_type,entity_type,entity_id,payload,request_id)
  values(r->>'workspace_id',impl,case when auth.uid() is null then 'SYSTEM' else 'USER' end,auth.uid(),event_name,entity,r->>'id',jsonb_build_object('status',r->>'status','current_step',r->>'current_step','title',r->>'title'),current_setting('app.request_id',true));
  return new;
end;
$$;
revoke all on function implementation_os_private.record_autopilot_change() from public, authenticated;
create trigger autopilot_runs_audit after insert or update on implementation_os.autopilot_runs for each row execute function implementation_os_private.record_autopilot_change();
create trigger autopilot_proposals_audit after insert or update on implementation_os.autopilot_proposals for each row execute function implementation_os_private.record_autopilot_change();

grant select on implementation_os.autopilot_runs, implementation_os.autopilot_proposals to authenticated;
create index autopilot_runs_workspace_idx on implementation_os.autopilot_runs(workspace_id);
create index autopilot_proposals_workspace_idx on implementation_os.autopilot_proposals(workspace_id);
