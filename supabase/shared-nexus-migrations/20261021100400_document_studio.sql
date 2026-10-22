-- Persist editable implementation documents and append-only review history.
alter table implementation_os.documents
  add column content text not null default '',
  add column status text not null default 'DRAFT'
    check (status in ('DRAFT','IN_REVIEW','APPROVED','ARCHIVED')),
  add column template_id text,
  add column change_summary text not null default 'Document created',
  add column generation_notes jsonb not null default '[]',
  add column open_questions text[] not null default '{}';

-- Keep full document bodies in version history, not duplicated into the general
-- audit log's before/after JSON payloads.
create or replace function implementation_os_private.record_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare row_data jsonb:=to_jsonb(new); old_data jsonb; impl uuid; event_name text;
begin
  if tg_op='UPDATE' then old_data:=to_jsonb(old); end if;
  if tg_op='DELETE' then row_data:=to_jsonb(old);old_data:=row_data;end if;
  if tg_table_name='documents' then
    row_data:=row_data-'content';
    old_data:=old_data-'content';
  end if;
  impl:=nullif(row_data->>'implementation_id','')::uuid;
  if tg_table_name='implementations' then impl:=(row_data->>'id')::uuid;end if;
  event_name:=upper(tg_table_name)||'_'||case when tg_op='INSERT' then 'CREATED' when tg_op='UPDATE' then 'UPDATED' else 'DELETED' end;
  if tg_table_name='tasks' and tg_op='UPDATE' and row_data->>'status' is distinct from old_data->>'status' then event_name:='TASK_'||(row_data->>'status');end if;
  insert into implementation_os.audit_logs(workspace_id,actor_id,action,entity_type,entity_id,before,after,request_id)
    values(row_data->>'workspace_id',auth.uid(),event_name,tg_table_name,row_data->>'id',old_data,case when tg_op='DELETE' then null else row_data end,current_setting('app.request_id',true));
  insert into implementation_os.activity_events(workspace_id,implementation_id,actor_type,actor_id,event_type,entity_type,entity_id,payload,request_id)
    values(row_data->>'workspace_id',impl,case when auth.uid() is null then 'SYSTEM' else 'USER' end,auth.uid(),event_name,tg_table_name,row_data->>'id',jsonb_build_object('label',coalesce(row_data->>'title',row_data->>'name'), 'status',row_data->>'status'),current_setting('app.request_id',true));
  if impl is not null and tg_table_name in ('tasks','milestones','requirements','risks','task_dependencies') then
    insert into implementation_os.jobs(workspace_id,implementation_id,kind,payload) values(row_data->>'workspace_id',impl,'RECALCULATE_HEALTH',jsonb_build_object('entity_id',row_data->>'id'));
  end if;
  if impl is not null and tg_table_name in ('tasks','requirements','meetings','meeting_transcripts','documents','stakeholders','risks','milestones','implementation_stages') and tg_op<>'DELETE' then
    insert into implementation_os.graph_entities(workspace_id,implementation_id,entity_type,entity_id,label)
      values(row_data->>'workspace_id',impl,tg_table_name,(row_data->>'id')::uuid,coalesce(row_data->>'title',row_data->>'name',row_data->>'speaker',tg_table_name))
      on conflict(workspace_id,entity_type,entity_id) do update set label=excluded.label;
  end if;
  return coalesce(new,old);
end;
$$;

create table implementation_os.document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  implementation_id uuid not null,
  document_id uuid not null,
  version integer not null check (version > 0),
  name text not null,
  type text not null,
  status text not null check (status in ('DRAFT','IN_REVIEW','APPROVED','ARCHIVED')),
  content text not null,
  change_summary text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, document_id, version),
  foreign key (workspace_id, implementation_id, document_id)
    references implementation_os.documents(workspace_id, implementation_id, id)
);

create index document_versions_timeline_idx
  on implementation_os.document_versions(workspace_id, implementation_id, document_id, version desc);

-- Revisions are written only by this table trigger; callers can read history but
-- cannot rewrite it through the exposed Data API.
alter table implementation_os.document_versions enable row level security;
revoke all on implementation_os.document_versions from anon, authenticated;
grant select on implementation_os.document_versions to authenticated;
create policy document_versions_read on implementation_os.document_versions
  for select to authenticated using (implementation_os_private.allowed(workspace_id));
create trigger immutable_document_version
  before update or delete on implementation_os.document_versions
  for each row execute function implementation_os_private.immutable();

create function implementation_os_private.prepare_document_version() returns trigger
language plpgsql set search_path = '' as $$
declare actor_role text;
begin
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    if old.status in ('APPROVED','ARCHIVED')
       or new.status in ('APPROVED','ARCHIVED') then
      select m.role into actor_role
      from implementation_os.workspace_members m
      where m.workspace_id = new.workspace_id
        and m.user_id = auth.uid()
        and m.status = 'ACTIVE';
      if actor_role is null or actor_role not in ('OWNER','ADMIN','IMPLEMENTATION_MANAGER') then
        raise exception 'DOCUMENT_REVIEW_ROLE_REQUIRED'
          using errcode = '42501';
      end if;
    end if;
    if new.name is not distinct from old.name
       and new.type is not distinct from old.type
       and new.status is not distinct from old.status
       and new.content is not distinct from old.content then
      new.version := old.version;
      return new;
    end if;
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;
create trigger prepare_document_revision
  before insert or update on implementation_os.documents
  for each row execute function implementation_os_private.prepare_document_version();

create function implementation_os_private.snapshot_document_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.version = old.version then return new; end if;
  insert into implementation_os.document_versions(
    workspace_id, implementation_id, document_id, version,
    name, type, status, content, change_summary, created_by
  ) values (
    new.workspace_id, new.implementation_id, new.id, new.version,
    new.name, new.type, new.status, new.content,
    coalesce(nullif(btrim(new.change_summary), ''), 'Document updated'),
    auth.uid()
  );
  return new;
end;
$$;
revoke all on function implementation_os_private.snapshot_document_version() from public;
revoke all on function implementation_os_private.prepare_document_version() from public, authenticated;
create trigger snapshot_document_revision
  after insert or update on implementation_os.documents
  for each row execute function implementation_os_private.snapshot_document_version();

-- Seed a baseline snapshot for documents that existed before editable content.
insert into implementation_os.document_versions(
  workspace_id, implementation_id, document_id, version,
  name, type, status, content, change_summary, created_by
)
select workspace_id, implementation_id, id, version,
       name, type, status, content, 'Existing document baseline', uploaded_by
from implementation_os.documents
on conflict (workspace_id, document_id, version) do nothing;
