-- Keep local databases that already applied the first plan migration in sync.
create or replace function private.guard_plan_proposal() returns trigger
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
