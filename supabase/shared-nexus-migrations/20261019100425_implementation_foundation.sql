-- Implementation OS only. This schema does not alter Nexus tables.
create schema if not exists implementation_os;
revoke all on schema implementation_os from public;
grant usage on schema implementation_os to authenticated, service_role;
-- New-project migration. Never apply to the Nexus database.
create schema if not exists implementation_os_private;
revoke all on schema implementation_os_private from public;
grant usage on schema implementation_os_private to authenticated;

create table implementation_os.workspaces (
  id text primary key default ('WS_' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,16))),
  name text not null check (length(name) between 2 and 100),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  logo_url text, status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table implementation_os.workspace_members (
  id uuid primary key default gen_random_uuid(), workspace_id text not null references implementation_os.workspaces(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('OWNER','ADMIN','IMPLEMENTATION_MANAGER','IMPLEMENTATION_MEMBER','VIEWER')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE')),
  joined_at timestamptz not null default now(), unique(workspace_id,user_id)
);
create index workspace_members_user_idx on implementation_os.workspace_members(user_id,workspace_id);

-- Definer is intentionally restricted to a non-exposed schema to avoid recursive RLS.
-- No caller-supplied user identity: only the verified auth.uid() may be checked.
create function implementation_os_private.allowed(w text, capability text default 'read') returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from implementation_os.workspace_members m join implementation_os.workspaces ws on ws.id=m.workspace_id
    where m.workspace_id=w and m.user_id=auth.uid() and m.status='ACTIVE' and ws.status='ACTIVE'
    and case capability
      when 'read' then true
      when 'work.write' then m.role <> 'VIEWER'
      when 'plan.manage' then m.role in ('OWNER','ADMIN','IMPLEMENTATION_MANAGER')
      when 'audit.read' then m.role in ('OWNER','ADMIN','IMPLEMENTATION_MANAGER')
      when 'workspace.manage' then m.role in ('OWNER','ADMIN')
      else false end
  );
$$;
revoke all on function implementation_os_private.allowed(text,text) from public;
grant execute on function implementation_os_private.allowed(text,text) to authenticated;
alter table implementation_os.workspaces enable row level security;
alter table implementation_os.workspace_members enable row level security;
create policy workspace_read on implementation_os.workspaces for select to authenticated using (implementation_os_private.allowed(id));
create policy member_read on implementation_os.workspace_members for select to authenticated using (implementation_os_private.allowed(workspace_id));
revoke all on implementation_os.workspaces, implementation_os.workspace_members from anon,authenticated;
grant select on implementation_os.workspaces, implementation_os.workspace_members to authenticated;

create table implementation_os.companies (
  id uuid primary key default gen_random_uuid(), workspace_id text not null references implementation_os.workspaces(id),
  name text not null, domain text, website text, logo_url text, industry text, description text,
  employee_count integer check (employee_count>=0), country text, metadata jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table implementation_os.implementations (
  id uuid primary key default gen_random_uuid(), workspace_id text not null references implementation_os.workspaces(id),
  company_id uuid not null, name text not null, description text, implementation_type text not null default 'ENTERPRISE',
  status text not null default 'DRAFT' check (status in ('DRAFT','PLANNING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
  health_status text check (health_status in ('HEALTHY','WATCH','AT_RISK','BLOCKED')),
  health_score integer check (health_score between 0 and 100), ai_readiness_score integer check (ai_readiness_score between 0 and 100),
  ai_confidence_score integer check (ai_confidence_score between 0 and 100),
  owner_id uuid, start_date date, target_go_live_date date, actual_go_live_date date,
  playbook_snapshot jsonb, metadata jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id),
  foreign key(workspace_id,company_id) references implementation_os.companies(workspace_id,id),
  foreign key(workspace_id,owner_id) references implementation_os.workspace_members(workspace_id,user_id),
  check(target_go_live_date is null or start_date is null or target_go_live_date>=start_date)
);
create table implementation_os.implementation_stages (
  id uuid primary key default gen_random_uuid(), workspace_id text not null, implementation_id uuid not null,
  name text not null, key text not null, description text, sequence integer not null check(sequence>=0),
  status text not null default 'NOT_STARTED' check(status in ('NOT_STARTED','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED')),
  start_date date,end_date date,progress integer not null default 0 check(progress between 0 and 100),health text,
  created_by uuid,source_type text not null default 'HUMAN',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(workspace_id,implementation_id,id),unique(workspace_id,implementation_id,sequence),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id)
);
alter table implementation_os.implementations add column current_stage_id uuid;
alter table implementation_os.implementations add foreign key(workspace_id,id,current_stage_id) references implementation_os.implementation_stages(workspace_id,implementation_id,id);
create table implementation_os.tasks (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,stage_id uuid,
  title text not null,description text,status text not null default 'NOT_STARTED' check(status in ('NOT_STARTED','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED')),
  priority text not null default 'MEDIUM' check(priority in ('LOW','MEDIUM','HIGH','CRITICAL')),
  owner_id uuid,due_date date,completed_at timestamptz,source_type text not null default 'HUMAN',source_id uuid,
  ai_generated boolean not null default false,ai_confidence numeric check(ai_confidence between 0 and 1),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id),
  foreign key(workspace_id,implementation_id,stage_id) references implementation_os.implementation_stages(workspace_id,implementation_id,id),
  foreign key(workspace_id,owner_id) references implementation_os.workspace_members(workspace_id,user_id)
);
create table implementation_os.task_dependencies (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,
  task_id uuid not null,depends_on_task_id uuid not null,
  dependency_type text not null default 'BLOCKED_BY' check(dependency_type in ('BLOCKED_BY','BLOCKS','RELATED_TO')),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  check(task_id<>depends_on_task_id),unique(workspace_id,task_id,depends_on_task_id,dependency_type),
  foreign key(workspace_id,implementation_id,task_id) references implementation_os.tasks(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id,depends_on_task_id) references implementation_os.tasks(workspace_id,implementation_id,id)
);
create table implementation_os.milestones (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,
  name text not null,description text,target_date date,status text not null default 'NOT_STARTED' check(status in ('NOT_STARTED','IN_PROGRESS','BLOCKED','COMPLETED','CANCELLED')),
  health text,owner_id uuid,sequence integer not null default 0,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id),
  foreign key(workspace_id,owner_id) references implementation_os.workspace_members(workspace_id,user_id)
);
create table implementation_os.milestone_links (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,milestone_id uuid not null,task_id uuid,stage_id uuid,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check(num_nonnulls(task_id,stage_id)=1),
  foreign key(workspace_id,implementation_id,milestone_id) references implementation_os.milestones(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id,task_id) references implementation_os.tasks(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id,stage_id) references implementation_os.implementation_stages(workspace_id,implementation_id,id)
);
create table implementation_os.requirements (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,stage_id uuid,
  title text not null,description text,category text,priority text not null default 'MEDIUM' check(priority in ('LOW','MEDIUM','HIGH','CRITICAL')),
  status text not null default 'DISCOVERED' check(status in ('DISCOVERED','CONFIRMED','IN_PROGRESS','VALIDATED','CHANGED','REJECTED')),
  owner_id uuid,source_type text not null default 'HUMAN',source_id uuid,confidence numeric check(confidence between 0 and 1),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id),
  foreign key(workspace_id,implementation_id,stage_id) references implementation_os.implementation_stages(workspace_id,implementation_id,id),
  foreign key(workspace_id,owner_id) references implementation_os.workspace_members(workspace_id,user_id)
);
create table implementation_os.meetings (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,title text not null,
  start_time timestamptz,end_time timestamptz,provider text,external_id text,transcript_status text not null default 'NOT_UPLOADED',recording_url text,summary text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id)
);
create table implementation_os.meeting_transcripts (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,meeting_id uuid not null,
  speaker text not null,timestamp_ms integer not null check(timestamp_ms>=0),text text not null,metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id,meeting_id) references implementation_os.meetings(workspace_id,implementation_id,id)
);
create table implementation_os.documents (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,name text not null,
  type text not null default 'REFERENCE',mime_type text,storage_path text,version integer not null default 1 check(version>0),uploaded_by uuid,
  source text not null default 'UPLOAD',processing_status text not null default 'PENDING_UPLOAD' check(processing_status in ('PENDING_UPLOAD','QUEUED','PROCESSING','COMPLETED','FAILED')),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),unique(workspace_id,storage_path),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id)
);
create table implementation_os.stakeholders (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,name text not null,email text,
  company text,role text,type text not null default 'CUSTOMER',influence text,responsiveness_score numeric,owner_id uuid,metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id),
  foreign key(workspace_id,owner_id) references implementation_os.workspace_members(workspace_id,user_id)
);
create table implementation_os.risks (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,title text not null,description text,
  severity text not null default 'MEDIUM' check(severity in ('LOW','MEDIUM','HIGH','CRITICAL')),probability numeric check(probability between 0 and 1),impact text,
  status text not null default 'OPEN' check(status in ('OPEN','MONITORING','MITIGATED','RESOLVED','ACCEPTED')),owner_id uuid,
  source_type text not null default 'HUMAN',source_id uuid,ai_detected boolean not null default false,ai_confidence numeric check(ai_confidence between 0 and 1),predicted_impact text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id),
  foreign key(workspace_id,owner_id) references implementation_os.workspace_members(workspace_id,user_id)
);
-- Graph registry provides real, tenant-consistent references for evidence rather than unvalidated JSON IDs.
create table implementation_os.graph_entities (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,entity_type text not null,entity_id uuid not null,label text not null,
  created_at timestamptz not null default now(),unique(workspace_id,implementation_id,id),unique(workspace_id,entity_type,entity_id),
  foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id)
);
create table implementation_os.evidence_links (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,implementation_id uuid not null,source_entity_id uuid not null,target_entity_id uuid not null,
  relationship text not null,excerpt text,timestamp_ms integer check(timestamp_ms>=0),speaker text,page_number integer check(page_number>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check(source_entity_id<>target_entity_id),
  foreign key(workspace_id,implementation_id,source_entity_id) references implementation_os.graph_entities(workspace_id,implementation_id,id),
  foreign key(workspace_id,implementation_id,target_entity_id) references implementation_os.graph_entities(workspace_id,implementation_id,id)
);
create table implementation_os.playbooks (
  id uuid primary key default gen_random_uuid(),workspace_id text not null references implementation_os.workspaces(id),name text not null,description text,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create table implementation_os.playbook_versions (
  id uuid primary key default gen_random_uuid(),workspace_id text not null,playbook_id uuid not null,version integer not null check(version>0),snapshot jsonb not null,
  created_at timestamptz not null default now(),unique(workspace_id,playbook_id,version),
  foreign key(workspace_id,playbook_id) references implementation_os.playbooks(workspace_id,id)
);
create table implementation_os.activity_events (
  id uuid primary key default gen_random_uuid(),workspace_id text not null references implementation_os.workspaces(id),implementation_id uuid,
  actor_type text not null,actor_id uuid,event_type text not null,entity_type text not null,entity_id text not null,payload jsonb not null default '{}',request_id text,
  created_at timestamptz not null default now()
);
create table implementation_os.audit_logs (
  id uuid primary key default gen_random_uuid(),workspace_id text not null references implementation_os.workspaces(id),actor_id uuid,
  action text not null,entity_type text not null,entity_id text not null,before jsonb,after jsonb,request_id text,
  created_at timestamptz not null default now()
);
create table implementation_os.jobs (
  id uuid primary key default gen_random_uuid(),workspace_id text not null references implementation_os.workspaces(id),implementation_id uuid,
  kind text not null,payload jsonb not null default '{}',status text not null default 'QUEUED' check(status in ('QUEUED','PROCESSING','COMPLETED','FAILED')),
  attempts integer not null default 0,max_attempts integer not null default 5,available_at timestamptz not null default now(),leased_until timestamptz,lease_token uuid,error_code text,completed_at timestamptz,
  created_at timestamptz not null default now(),foreign key(workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id)
);
create index jobs_ready_idx on implementation_os.jobs(available_at) where status in ('QUEUED','PROCESSING');

create function implementation_os_private.immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'APPEND_ONLY' using errcode='42501'; end;
$$;
create trigger immutable_audit before update or delete on implementation_os.audit_logs for each row execute function implementation_os_private.immutable();
create trigger immutable_activity before update or delete on implementation_os.activity_events for each row execute function implementation_os_private.immutable();
create trigger immutable_playbook_version before update or delete on implementation_os.playbook_versions for each row execute function implementation_os_private.immutable();

-- Writes and their audit/activity/outbox are atomic. SECURITY DEFINER is trigger-only,
-- has an empty search_path, and cannot be invoked as an RPC.
create function implementation_os_private.record_change() returns trigger language plpgsql security definer set search_path='' as $$
declare row_data jsonb:=to_jsonb(new); old_data jsonb; impl uuid; event_name text;
begin
  if tg_op='UPDATE' then old_data:=to_jsonb(old); end if;
  if tg_op='DELETE' then row_data:=to_jsonb(old);old_data:=row_data;end if;
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
revoke all on all functions in schema implementation_os_private from public;
grant execute on function implementation_os_private.allowed(text,text) to authenticated;

create function implementation_os_private.prepare_change() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and (new.id<>old.id or new.workspace_id<>old.workspace_id) then raise exception 'IMMUTABLE_IDENTITY' using errcode='42501';end if;
  if tg_op='UPDATE' and to_jsonb(new)->>'implementation_id' is distinct from to_jsonb(old)->>'implementation_id' then raise exception 'IMMUTABLE_IMPLEMENTATION' using errcode='42501';end if;
  new.updated_at:=now();
  if tg_table_name='tasks' then
    if new.status='COMPLETED' and new.completed_at is null then new.completed_at:=now();end if;
    if new.status<>'COMPLETED' then new.completed_at:=null;end if;
  end if;
  return new;
end;
$$;

-- All workspace tables are denied by default, then granted explicit role capabilities.
do $$ declare t text; capability text; begin
  foreach t in array array['companies','implementations','implementation_stages','tasks','task_dependencies','milestones','milestone_links','requirements','meetings','meeting_transcripts','documents','stakeholders','risks','evidence_links','playbooks'] loop
    capability:=case when t in ('companies','implementations','implementation_stages','milestones','milestone_links','playbooks') then 'plan.manage' else 'work.write' end;
    execute format('alter table implementation_os.%I enable row level security',t);
    execute format('revoke all on implementation_os.%I from anon,authenticated',t);
    execute format('grant select,insert,update on implementation_os.%I to authenticated',t);
    execute format('create policy tenant_read on implementation_os.%I for select to authenticated using(implementation_os_private.allowed(workspace_id))',t);
    execute format('create policy tenant_insert on implementation_os.%I for insert to authenticated with check(implementation_os_private.allowed(workspace_id,%L))',t,capability);
    execute format('create policy tenant_update on implementation_os.%I for update to authenticated using(implementation_os_private.allowed(workspace_id,%L)) with check(implementation_os_private.allowed(workspace_id,%L))',t,capability,capability);
    execute format('create index %I on implementation_os.%I(workspace_id)',t||'_workspace_idx',t);
    execute format('create trigger prepare_change before insert or update on implementation_os.%I for each row execute function implementation_os_private.prepare_change()',t);
    execute format('create trigger record_change after insert or update on implementation_os.%I for each row execute function implementation_os_private.record_change()',t);
  end loop;
  foreach t in array array['graph_entities','activity_events','audit_logs','jobs','playbook_versions'] loop
    execute format('alter table implementation_os.%I enable row level security',t);
    execute format('revoke all on implementation_os.%I from anon,authenticated',t);
    execute format('grant select on implementation_os.%I to authenticated',t);
    execute format('create policy tenant_read on implementation_os.%I for select to authenticated using(implementation_os_private.allowed(workspace_id,%L))',t,case when t='audit_logs' then 'audit.read' else 'read' end);
    execute format('create index %I on implementation_os.%I(workspace_id)',t||'_workspace_idx',t);
  end loop;
end $$;
create index implementations_company_idx on implementation_os.implementations(workspace_id,company_id);
create index tasks_stage_idx on implementation_os.tasks(workspace_id,implementation_id,stage_id);
create index dependencies_target_idx on implementation_os.task_dependencies(workspace_id,implementation_id,depends_on_task_id);
create index requirements_stage_idx on implementation_os.requirements(workspace_id,implementation_id,stage_id);
create index transcripts_meeting_idx on implementation_os.meeting_transcripts(workspace_id,implementation_id,meeting_id);
create index evidence_source_idx on implementation_os.evidence_links(workspace_id,implementation_id,source_entity_id);
create index evidence_target_idx on implementation_os.evidence_links(workspace_id,implementation_id,target_entity_id);

-- Serialize graph changes on the parent implementation; concurrent edges cannot form a cycle.
create function implementation_os_private.guard_dependency() returns trigger language plpgsql set search_path='' as $$
declare cyclic boolean; source uuid; target uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id||new.implementation_id::text,0));
  if new.dependency_type='RELATED_TO' then return new;end if;
  source:=case when new.dependency_type='BLOCKS' then new.depends_on_task_id else new.task_id end;
  target:=case when new.dependency_type='BLOCKS' then new.task_id else new.depends_on_task_id end;
  with recursive edges as (
    select case when dependency_type='BLOCKS' then depends_on_task_id else task_id end as src,
           case when dependency_type='BLOCKS' then task_id else depends_on_task_id end as dst
    from implementation_os.task_dependencies where workspace_id=new.workspace_id and implementation_id=new.implementation_id and dependency_type<>'RELATED_TO' and id<>new.id
  ), reach(node) as (select target union select e.dst from edges e join reach r on e.src=r.node)
  select exists(select 1 from reach where node=source) into cyclic;
  if cyclic then raise exception 'DEPENDENCY_CYCLE' using errcode='23514';end if;
  return new;
end;
$$;
create trigger dependency_cycle before insert or update on implementation_os.task_dependencies for each row execute function implementation_os_private.guard_dependency();

-- Authenticated, serialized, retry-safe first-workspace provisioning.
create function implementation_os_private.bootstrap_workspace(workspace_name text,workspace_slug text) returns implementation_os.workspaces
language plpgsql security definer set search_path='' as $$
declare result implementation_os.workspaces; uid uuid:=auth.uid();begin
  if uid is null then raise exception 'AUTH_REQUIRED' using errcode='42501';end if;
  perform 1 from auth.users where id=uid and email_confirmed_at is not null for update;
  if not found then raise exception 'EMAIL_CONFIRMATION_REQUIRED' using errcode='42501';end if;
  select w.* into result from implementation_os.workspaces w where w.created_by=uid order by w.created_at limit 1;
  if found then return result;end if;
  insert into implementation_os.workspaces(name,slug,created_by) values(workspace_name,workspace_slug,uid) returning * into result;
  insert into implementation_os.workspace_members(workspace_id,user_id,role) values(result.id,uid,'OWNER');
  insert into implementation_os.audit_logs(workspace_id,actor_id,action,entity_type,entity_id,after) values(result.id,uid,'WORKSPACE_CREATED','workspaces',result.id,jsonb_build_object('name',result.name));
  return result;
end;
$$;
revoke all on function implementation_os_private.bootstrap_workspace(text,text) from public;
grant execute on function implementation_os_private.bootstrap_workspace(text,text) to authenticated;
create function implementation_os.create_first_workspace(workspace_name text,workspace_slug text) returns implementation_os.workspaces
language sql security invoker set search_path='' as $$ select implementation_os_private.bootstrap_workspace(workspace_name,workspace_slug); $$;
revoke all on function implementation_os.create_first_workspace(text,text) from public,anon;
grant execute on function implementation_os.create_first_workspace(text,text) to authenticated;
