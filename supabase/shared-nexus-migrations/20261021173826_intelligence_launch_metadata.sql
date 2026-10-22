-- Forward migration for demos that applied the initial library migration
-- before the published metadata and stage criteria fields were introduced.
alter table implementation_os.implementation_stages
  add column if not exists entry_criteria text,
  add column if not exists exit_criteria text,
  add column if not exists duration_days integer check(duration_days between 1 and 365),
  add column if not exists approval_required boolean not null default false;

create or replace function implementation_os_private.publish_playbook_version() returns trigger
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

create or replace function implementation_os.create_implementation_from_playbook(
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
    values(p_workspace_id,p_company_id,p_name,p_description,coalesce(v.snapshot->>'implementation_type',p.implementation_type),
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
