-- Service-only queue RPCs. Invoker privileges, no SECURITY DEFINER bypass.
grant select on all tables in schema public to service_role;
grant update on public.jobs,public.implementations to service_role;
create function public.claim_health_job() returns setof public.jobs
language plpgsql security invoker set search_path='' as $$ begin
  update public.jobs set status='FAILED',error_code='RETRY_EXHAUSTED'
    where status in ('QUEUED','PROCESSING') and attempts>=max_attempts and (leased_until is null or leased_until<now());
  return query with candidate as (
    select j.id from public.jobs j join public.workspaces w on w.id=j.workspace_id
    where j.kind='RECALCULATE_HEALTH' and w.status='ACTIVE' and j.attempts<j.max_attempts
      and ((j.status='QUEUED' and j.available_at<=now()) or (j.status='PROCESSING' and j.leased_until<now()))
    order by j.available_at for update of j skip locked limit 1
  ) update public.jobs j set status='PROCESSING',attempts=j.attempts+1,leased_until=now()+interval '60 seconds',lease_token=gen_random_uuid()
    from candidate c where j.id=c.id returning j.*;
end $$;
create function public.complete_health_job(job_id uuid,token uuid,score integer,health text) returns boolean
language plpgsql security invoker set search_path='' as $$ declare job public.jobs; begin
  select * into job from public.jobs where id=job_id and lease_token=token and status='PROCESSING' and leased_until>now() for update;
  if not found then return false;end if;
  if health not in ('UNKNOWN','HEALTHY','WATCH','AT_RISK','BLOCKED') or (score is not null and (score<0 or score>100)) then raise exception 'INVALID_HEALTH';end if;
  if not exists(select 1 from public.workspaces where id=job.workspace_id and status='ACTIVE') then
    update public.jobs set status='FAILED',error_code='WORKSPACE_INACTIVE',leased_until=null where id=job_id;return false;
  end if;
  update public.implementations set health_score=score,health_status=case when health='UNKNOWN' then null else health end
    where workspace_id=job.workspace_id and id=job.implementation_id
      and (health_score is distinct from score or health_status is distinct from (case when health='UNKNOWN' then null else health end));
  update public.jobs set status='COMPLETED',completed_at=now(),leased_until=null,error_code=null where id=job_id;
  return true;
end $$;
create function public.fail_health_job(job_id uuid,token uuid) returns boolean
language sql security invoker set search_path='' as $$
  with changed as (update public.jobs set status=case when attempts>=max_attempts then 'FAILED' else 'QUEUED' end,
    available_at=now()+(least(300,power(2,attempts)::integer)*interval '1 second'),leased_until=null,error_code='HEALTH_PROCESSING_FAILED'
    where id=job_id and lease_token=token and status='PROCESSING' and leased_until>now() returning id)
  select exists(select 1 from changed);
$$;
revoke all on function public.claim_health_job(),public.complete_health_job(uuid,uuid,integer,text),public.fail_health_job(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_health_job(),public.complete_health_job(uuid,uuid,integer,text),public.fail_health_job(uuid,uuid) to service_role;
