-- Extend tenant-scoped milestones and meetings into a usable implementation scheduler.
-- Existing meetings remain intact; calendar-specific fields are additive.
alter table public.meetings
  add column meeting_type text not null default 'CUSTOMER_CHECK_IN'
    check (meeting_type in ('KICKOFF','DISCOVERY','WORKSHOP','STATUS_REVIEW','DESIGN_REVIEW','UAT','TRAINING','GO_LIVE','CUSTOMER_CHECK_IN','OTHER')),
  add column status text not null default 'SCHEDULED'
    check (status in ('SCHEDULED','COMPLETED','CANCELLED')),
  add column timezone text not null default 'UTC',
  add column location text,
  add column meeting_url text,
  add column attendees text[] not null default '{}',
  add column organizer_id uuid,
  add constraint meetings_time_order check (end_time is null or start_time is null or end_time > start_time),
  add constraint meetings_organizer_fk foreign key (workspace_id, organizer_id)
    references public.workspace_members(workspace_id, user_id);

create index meetings_schedule_idx
  on public.meetings(workspace_id, start_time)
  where status <> 'CANCELLED';

create index milestones_schedule_idx
  on public.milestones(workspace_id, target_date)
  where status <> 'CANCELLED';
