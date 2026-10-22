-- Organization-scoped implementation intelligence. This migration is for the
-- separate Implementation OS project, never the Nexus production database.
alter table implementation_os.playbooks
  add column implementation_type text not null default 'ENTERPRISE',
  add column status text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','ARCHIVED')),
  add column draft_snapshot jsonb not null default '{"stages":[]}'::jsonb,
  add column published_version integer not null default 0 check (published_version >= 0),
  add column published_at timestamptz,
  add constraint playbook_published_has_version check (status <> 'PUBLISHED' or published_version > 0),
  add constraint playbook_snapshot_shape check (jsonb_typeof(draft_snapshot) = 'object' and jsonb_typeof(draft_snapshot->'stages') = 'array');

alter table implementation_os.playbook_versions add column published_by uuid references auth.users(id);
create index playbook_versions_lookup_idx on implementation_os.playbook_versions(workspace_id,playbook_id,version desc);
alter table implementation_os.implementation_stages
  add column entry_criteria text,
  add column exit_criteria text,
  add column duration_days integer check(duration_days between 1 and 365),
  add column approval_required boolean not null default false;

create function implementation_os_private.publish_playbook_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'PUBLISHED' and old.status = 'ARCHIVED' and new.published_version = old.published_version then
    raise exception 'ARCHIVED_PLAYBOOK_CANNOT_REOPEN' using errcode = '23514';
  end if;
  if new.published_version <> old.published_version then
    if new.published_version <> old.published_version + 1 or new.status <> 'PUBLISHED'
      or jsonb_array_length(new.draft_snapshot->'stages') = 0 then
      raise exception 'INVALID_PLAYBOOK_PUBLICATION' using errcode = '23514';
    end if;
    insert into implementation_os.playbook_versions(workspace_id,playbook_id,version,snapshot,published_by)
      values(new.workspace_id,new.id,new.published_version,
        new.draft_snapshot || jsonb_build_object('name',new.name,'description',new.description,
          'implementation_type',new.implementation_type),auth.uid());
    new.published_at := now();
  end if;
  return new;
end;
$$;
create trigger publish_playbook_version before update on implementation_os.playbooks
  for each row execute function implementation_os_private.publish_playbook_version();

create table implementation_os.intelligence_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references implementation_os.workspaces(id),
  kind text not null check (kind in ('TEMPLATE','DOCUMENT','STANDARD','AI_INSTRUCTION','KNOWLEDGE_SOURCE')),
  name text not null check (length(name) between 2 and 160),
  description text not null default '',
  content text not null default '' check (length(content) <= 200000),
  document_type text,
  source_url text,
  authority text not null default 'REFERENCE' check (authority in ('POLICY','APPROVED','REFERENCE')),
  status text not null default 'DRAFT' check (status in ('DRAFT','PUBLISHED','ARCHIVED')),
  published_version integer not null default 0 check (published_version >= 0),
  published_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,id),
  check(status <> 'PUBLISHED' or published_version > 0)
);
create table implementation_os.intelligence_asset_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  asset_id uuid not null,
  version integer not null check (version > 0),
  snapshot jsonb not null,
  published_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(workspace_id,asset_id,version),
  foreign key(workspace_id,asset_id) references implementation_os.intelligence_assets(workspace_id,id)
);
create index intelligence_assets_workspace_kind_idx on implementation_os.intelligence_assets(workspace_id,kind,created_at desc);
create index intelligence_asset_versions_lookup_idx on implementation_os.intelligence_asset_versions(workspace_id,asset_id,version desc);

create function implementation_os_private.publish_intelligence_asset() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'PUBLISHED' and old.status = 'ARCHIVED' and new.published_version = old.published_version then
    raise exception 'ARCHIVED_ASSET_CANNOT_REOPEN' using errcode = '23514';
  end if;
  if new.published_version <> old.published_version then
    if new.published_version <> old.published_version + 1 or new.status <> 'PUBLISHED'
      or length(trim(new.content)) < 10 then
      raise exception 'INVALID_ASSET_PUBLICATION' using errcode = '23514';
    end if;
    insert into implementation_os.intelligence_asset_versions(workspace_id,asset_id,version,snapshot,published_by)
      values(new.workspace_id,new.id,new.published_version,
        jsonb_build_object('name',new.name,'description',new.description,'content',new.content,
          'kind',new.kind,'document_type',new.document_type,'source_url',new.source_url,'authority',new.authority),auth.uid());
    new.published_at := now();
  end if;
  return new;
end;
$$;
create trigger publish_intelligence_asset before update on implementation_os.intelligence_assets
  for each row execute function implementation_os_private.publish_intelligence_asset();
create trigger immutable_intelligence_asset_version before update or delete on implementation_os.intelligence_asset_versions
  for each row execute function implementation_os_private.immutable();

alter table implementation_os.intelligence_assets enable row level security;
alter table implementation_os.intelligence_asset_versions enable row level security;
revoke all on implementation_os.intelligence_assets,implementation_os.intelligence_asset_versions from anon,authenticated;
grant select,insert,update on implementation_os.intelligence_assets to authenticated;
grant select on implementation_os.intelligence_asset_versions to authenticated;
create policy intelligence_assets_read on implementation_os.intelligence_assets for select to authenticated
  using(implementation_os_private.allowed(workspace_id));
create policy intelligence_assets_insert on implementation_os.intelligence_assets for insert to authenticated
  with check(implementation_os_private.allowed(workspace_id,'workspace.manage'));
create policy intelligence_assets_update on implementation_os.intelligence_assets for update to authenticated
  using(implementation_os_private.allowed(workspace_id,'workspace.manage'))
  with check(implementation_os_private.allowed(workspace_id,'workspace.manage'));
create policy intelligence_asset_versions_read on implementation_os.intelligence_asset_versions for select to authenticated
  using(implementation_os_private.allowed(workspace_id));
create trigger prepare_intelligence_asset before insert or update on implementation_os.intelligence_assets
  for each row execute function implementation_os_private.prepare_change();
create trigger record_intelligence_asset after insert or update on implementation_os.intelligence_assets
  for each row execute function implementation_os_private.record_change();

-- A publication is immutable; projects retain the exact version they launched with.
-- The function is SECURITY INVOKER: existing RLS and role policies apply to each write.
create function implementation_os.create_implementation_from_playbook(
  p_workspace_id text,p_company_id uuid,p_playbook_id uuid,p_name text,
  p_description text default null,p_target_go_live_date date default null)
returns implementation_os.implementations language plpgsql security invoker set search_path = '' as $$
declare p implementation_os.playbooks; v implementation_os.playbook_versions; result implementation_os.implementations;
  stage_data jsonb; task_data jsonb; milestone_data jsonb; stage_row implementation_os.implementation_stages;
  position integer := 0; milestone_position integer;
begin
  if not implementation_os_private.allowed(p_workspace_id,'plan.manage') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into p from implementation_os.playbooks where id=p_playbook_id and workspace_id=p_workspace_id and status='PUBLISHED';
  if not found then raise exception 'PLAYBOOK_NOT_PUBLISHED' using errcode = '23514'; end if;
  select * into v from implementation_os.playbook_versions
    where workspace_id=p_workspace_id and playbook_id=p.id and version=p.published_version;
  if not found then raise exception 'PLAYBOOK_VERSION_MISSING' using errcode = '23514'; end if;
  if jsonb_typeof(v.snapshot->'stages') <> 'array' or jsonb_array_length(v.snapshot->'stages') = 0 then
    raise exception 'INVALID_PLAYBOOK_SNAPSHOT' using errcode = '23514';
  end if;
  insert into implementation_os.implementations(workspace_id,company_id,name,description,implementation_type,
    target_go_live_date,playbook_snapshot)
    values(p_workspace_id,p_company_id,p_name,p_description,v.snapshot->>'implementation_type',
      p_target_go_live_date,v.snapshot || jsonb_build_object('playbook_id',p.id,'version',v.version))
    returning * into result;
  for stage_data in select value from jsonb_array_elements(v.snapshot->'stages') loop
    insert into implementation_os.implementation_stages(workspace_id,implementation_id,name,key,description,sequence,source_type,created_by,
      entry_criteria,exit_criteria,duration_days,approval_required)
      values(p_workspace_id,result.id,stage_data->>'name',stage_data->>'key',stage_data->>'description',position,'PLAYBOOK',auth.uid(),
        stage_data->>'entry_criteria',stage_data->>'exit_criteria',nullif(stage_data->>'duration_days','')::integer,
        coalesce((stage_data->>'approval_required')::boolean,false))
      returning * into stage_row;
    if position = 0 then
      update implementation_os.implementations set current_stage_id=stage_row.id where id=result.id returning * into result;
    end if;
    for task_data in select value from jsonb_array_elements(coalesce(stage_data->'tasks','[]'::jsonb)) loop
      insert into implementation_os.tasks(workspace_id,implementation_id,stage_id,title,description,priority,source_type,source_id)
        values(p_workspace_id,result.id,stage_row.id,task_data->>'title',task_data->>'description',
          coalesce(task_data->>'priority','MEDIUM'),'PLAYBOOK',p.id);
    end loop;
    milestone_position := 0;
    for milestone_data in select value from jsonb_array_elements(coalesce(stage_data->'milestones','[]'::jsonb)) loop
      insert into implementation_os.milestones(workspace_id,implementation_id,name,description,sequence)
        values(p_workspace_id,result.id,milestone_data->>'name',milestone_data->>'description',position * 100 + milestone_position);
      milestone_position := milestone_position + 1;
    end loop;
    position := position + 1;
  end loop;
  return result;
end;
$$;
revoke all on function implementation_os.create_implementation_from_playbook(text,uuid,uuid,text,text,date) from public,anon;
grant execute on function implementation_os.create_implementation_from_playbook(text,uuid,uuid,text,text,date) to authenticated;
