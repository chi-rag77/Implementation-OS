-- Local-first, additive Evidence-to-Plan workflow. Never apply to Nexus.
-- Source text is snapshotted for review, while audit entries contain metadata only.
create table implementation_os.plan_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  implementation_id uuid not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','APPROVED','REJECTED')),
  source_snapshots jsonb not null default '[]' check (jsonb_typeof(source_snapshots) = 'array'),
  plan jsonb not null default '{"summary":"","stages":[],"open_questions":[]}' check (jsonb_typeof(plan) = 'object'),
  generation_mode text not null check (generation_mode in ('AI','MANUAL_OUTLINE')),
  provider_name text,
  edited_by_human boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  reviewer_note text not null default '',
  applied_entities jsonb not null default '{"stages":[],"tasks":[],"milestones":[],"dependencies":[]}',
  created_by uuid not null references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id,implementation_id,id),
  foreign key (workspace_id,implementation_id) references implementation_os.implementations(workspace_id,id)
);
create index plan_proposals_impl_idx on implementation_os.plan_proposals(workspace_id,implementation_id,created_at desc);
alter table implementation_os.plan_proposals enable row level security;
revoke all on implementation_os.plan_proposals from anon,authenticated;
grant select,insert,update on implementation_os.plan_proposals to authenticated;
create policy plan_proposals_read on implementation_os.plan_proposals for select to authenticated
  using (implementation_os_private.allowed(workspace_id));
create policy plan_proposals_insert on implementation_os.plan_proposals for insert to authenticated
  with check (implementation_os_private.allowed(workspace_id,'plan.manage') and created_by = (select auth.uid()) and status = 'DRAFT');
create policy plan_proposals_update on implementation_os.plan_proposals for update to authenticated
  using (implementation_os_private.allowed(workspace_id,'plan.manage'))
  with check (implementation_os_private.allowed(workspace_id,'plan.manage'));

create function implementation_os_private.guard_plan_proposal() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.workspace_id <> old.workspace_id or new.implementation_id <> old.implementation_id
      or new.created_by <> old.created_by or new.source_snapshots <> old.source_snapshots
      or new.generation_mode <> old.generation_mode or new.provider_name is distinct from old.provider_name then
      raise exception 'PLAN_SOURCE_IMMUTABLE' using errcode = '42501';
    end if;
    if old.status <> 'DRAFT' then
      raise exception 'PLAN_ALREADY_REVIEWED' using errcode = '23514';
    end if;
    if new.status = 'APPROVED' and current_setting('app.plan_apply_id',true) is distinct from new.id::text then
      raise exception 'PLAN_APPROVAL_REQUIRES_APPLY' using errcode = '42501';
    end if;
    if (new.applied_entities <> old.applied_entities or new.approved_by is distinct from old.approved_by
        or new.approved_at is distinct from old.approved_at)
      and current_setting('app.plan_apply_id',true) is distinct from new.id::text then
      raise exception 'PLAN_APPROVAL_METADATA_PROTECTED' using errcode = '42501';
    end if;
    if new.status = 'DRAFT' and (new.approved_by is not null or new.approved_at is not null) then
      raise exception 'INVALID_PLAN_REVIEW' using errcode = '23514';
    end if;
    if new.status <> 'APPROVED' then new.revision := old.revision + 1; end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function implementation_os_private.guard_plan_proposal() from public,anon,authenticated;
create trigger guard_plan_proposal before insert or update on implementation_os.plan_proposals
  for each row execute function implementation_os_private.guard_plan_proposal();

create function implementation_os_private.audit_plan_proposal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare event_name text;
begin
  event_name := case when tg_op = 'INSERT' then 'PLAN_PROPOSAL_CREATED'
    when new.status = 'APPROVED' then 'PLAN_PROPOSAL_APPROVED'
    when new.status = 'REJECTED' then 'PLAN_PROPOSAL_REJECTED'
    else 'PLAN_PROPOSAL_REVISED' end;
  insert into implementation_os.audit_logs(workspace_id,actor_id,action,entity_type,entity_id,before,after,request_id)
    values(new.workspace_id,auth.uid(),event_name,'plan_proposals',new.id::text,
      case when tg_op = 'UPDATE' then jsonb_build_object('status',old.status,'revision',old.revision) else null end,
      jsonb_build_object('status',new.status,'revision',new.revision,'generation_mode',new.generation_mode,
        'source_count',jsonb_array_length(new.source_snapshots)),current_setting('app.request_id',true));
  insert into implementation_os.activity_events(workspace_id,implementation_id,actor_type,actor_id,event_type,entity_type,entity_id,payload,request_id)
    values(new.workspace_id,new.implementation_id,'USER',auth.uid(),event_name,'plan_proposals',new.id::text,
      jsonb_build_object('status',new.status,'revision',new.revision),current_setting('app.request_id',true));
  return new;
end;
$$;
revoke all on function implementation_os_private.audit_plan_proposal() from public,anon,authenticated;
create trigger audit_plan_proposal after insert or update on implementation_os.plan_proposals
  for each row execute function implementation_os_private.audit_plan_proposal();

-- A single RPC is the approval boundary. Existing records are never overwritten:
-- matching stage keys/task titles/milestone names are reused, and missing items
-- are appended with source provenance. A failed insert rolls back the whole plan.
create function implementation_os.apply_plan_proposal(p_workspace_id text,p_proposal_id uuid,p_acknowledge_open_questions boolean default false)
returns implementation_os.plan_proposals language plpgsql security invoker set search_path = '' as $$
declare proposal implementation_os.plan_proposals; implementation implementation_os.implementations;
  stage_data jsonb; task_data jsonb; milestone_data jsonb; dependency_key text;
  stage_row implementation_os.implementation_stages; task_row implementation_os.tasks; milestone_row implementation_os.milestones;
  stage_position integer; milestone_position integer; task_map jsonb := '{}'::jsonb;
  applied jsonb := '{"stages":[],"tasks":[],"milestones":[],"dependencies":[]}'::jsonb;
  dep_id uuid; dep_row implementation_os.task_dependencies;
begin
  if not implementation_os_private.allowed(p_workspace_id,'plan.manage') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into implementation from implementation_os.implementations
    where workspace_id = p_workspace_id and id = (
      select implementation_id from implementation_os.plan_proposals where workspace_id = p_workspace_id and id = p_proposal_id
    ) for update;
  if not found then raise exception 'IMPLEMENTATION_NOT_FOUND' using errcode = '23514'; end if;
  select * into proposal from implementation_os.plan_proposals
    where workspace_id=p_workspace_id and implementation_id=implementation.id and id=p_proposal_id for update;
  if not found then raise exception 'PLAN_NOT_FOUND' using errcode = '23514'; end if;
  if proposal.status = 'APPROVED' then return proposal; end if;
  if proposal.status <> 'DRAFT' then raise exception 'PLAN_NOT_REVIEWABLE' using errcode = '23514'; end if;
  if proposal.edited_by_human and length(trim(proposal.reviewer_note)) < 3 then
    raise exception 'REVIEW_NOTE_REQUIRED' using errcode = '23514';
  end if;
  if jsonb_array_length(coalesce(proposal.plan->'open_questions','[]'::jsonb)) > 0 and not p_acknowledge_open_questions then
    raise exception 'OPEN_QUESTIONS_REQUIRE_ACKNOWLEDGEMENT' using errcode = '23514';
  end if;
  if jsonb_typeof(proposal.plan->'stages') <> 'array' or jsonb_array_length(proposal.plan->'stages') = 0
    or jsonb_array_length(proposal.plan->'stages') > 12 then
    raise exception 'INVALID_PLAN_STAGES' using errcode = '23514';
  end if;
  select coalesce(max(sequence),-1)+1 into stage_position from implementation_os.implementation_stages
    where workspace_id=p_workspace_id and implementation_id=implementation.id;
  select coalesce(max(sequence),-1)+1 into milestone_position from implementation_os.milestones
    where workspace_id=p_workspace_id and implementation_id=implementation.id;
  for stage_data in select value from jsonb_array_elements(proposal.plan->'stages') loop
    select * into stage_row from implementation_os.implementation_stages
      where workspace_id=p_workspace_id and implementation_id=implementation.id and key=stage_data->>'key';
    if not found then
      insert into implementation_os.implementation_stages(workspace_id,implementation_id,name,key,description,sequence,source_type,created_by,
        entry_criteria,exit_criteria,duration_days,approval_required)
      values(p_workspace_id,implementation.id,stage_data->>'name',stage_data->>'key',stage_data->>'description',stage_position,
        'PLAN_PROPOSAL',auth.uid(),stage_data->>'entry_criteria',stage_data->>'exit_criteria',
        nullif(stage_data->>'duration_days','')::integer,coalesce((stage_data->>'approval_required')::boolean,false))
      returning * into stage_row;
      applied := jsonb_set(applied,'{stages}',applied->'stages'||jsonb_build_array(stage_row.id));
      stage_position := stage_position + 1;
    end if;
    if implementation.current_stage_id is null then
      update implementation_os.implementations set current_stage_id=stage_row.id where id=implementation.id and workspace_id=p_workspace_id;
      implementation.current_stage_id := stage_row.id;
    end if;
    for task_data in select value from jsonb_array_elements(coalesce(stage_data->'tasks','[]'::jsonb)) loop
      select * into task_row from implementation_os.tasks where workspace_id=p_workspace_id and implementation_id=implementation.id
        and stage_id=stage_row.id and lower(title)=lower(task_data->>'title') order by created_at limit 1;
      if not found then
        insert into implementation_os.tasks(workspace_id,implementation_id,stage_id,title,description,priority,source_type,source_id)
        values(p_workspace_id,implementation.id,stage_row.id,task_data->>'title',task_data->>'description',
          task_data->>'priority','PLAN_PROPOSAL',proposal.id) returning * into task_row;
        applied := jsonb_set(applied,'{tasks}',applied->'tasks'||jsonb_build_array(task_row.id));
      end if;
      task_map := task_map || jsonb_build_object(task_data->>'key',task_row.id);
    end loop;
    for milestone_data in select value from jsonb_array_elements(coalesce(stage_data->'milestones','[]'::jsonb)) loop
      select * into milestone_row from implementation_os.milestones where workspace_id=p_workspace_id and implementation_id=implementation.id
        and lower(name)=lower(milestone_data->>'name') order by created_at limit 1;
      if not found then
        insert into implementation_os.milestones(workspace_id,implementation_id,name,description,sequence)
        values(p_workspace_id,implementation.id,milestone_data->>'name',milestone_data->>'description',milestone_position)
        returning * into milestone_row;
        applied := jsonb_set(applied,'{milestones}',applied->'milestones'||jsonb_build_array(milestone_row.id));
        milestone_position := milestone_position + 1;
      end if;
    end loop;
  end loop;
  for stage_data in select value from jsonb_array_elements(proposal.plan->'stages') loop
    for task_data in select value from jsonb_array_elements(coalesce(stage_data->'tasks','[]'::jsonb)) loop
      for dependency_key in select value #>> '{}' from jsonb_array_elements(coalesce(task_data->'depends_on','[]'::jsonb)) loop
        dep_id := nullif(task_map->>dependency_key,'')::uuid;
        if dep_id is null then raise exception 'PLAN_DEPENDENCY_MISSING' using errcode = '23514'; end if;
        insert into implementation_os.task_dependencies(workspace_id,implementation_id,task_id,depends_on_task_id,dependency_type)
          values(p_workspace_id,implementation.id,(task_map->>(task_data->>'key'))::uuid,dep_id,'BLOCKED_BY')
          on conflict(workspace_id,task_id,depends_on_task_id,dependency_type) do nothing
          returning * into dep_row;
        if dep_row.id is not null then
          applied := jsonb_set(applied,'{dependencies}',applied->'dependencies'||jsonb_build_array(dep_row.id));
        end if;
        dep_row := null;
      end loop;
    end loop;
  end loop;
  perform set_config('app.plan_apply_id',proposal.id::text,true);
  update implementation_os.plan_proposals set status='APPROVED',approved_by=auth.uid(),approved_at=now(),applied_entities=applied
    where workspace_id=p_workspace_id and id=proposal.id returning * into proposal;
  return proposal;
end;
$$;
revoke all on function implementation_os.apply_plan_proposal(text,uuid,boolean) from public,anon;
grant execute on function implementation_os.apply_plan_proposal(text,uuid,boolean) to authenticated;
