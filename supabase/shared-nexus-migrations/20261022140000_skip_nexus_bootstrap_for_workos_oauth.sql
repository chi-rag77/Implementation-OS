-- AI Implementation OS uses WorkOS through Supabase Auth. Keep the shared
-- project's legacy Nexus signup hooks from provisioning unrelated Nexus rows.
-- Existing Nexus signup behavior remains unchanged for every other provider.
create or replace function public.create_default_workspace()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare new_workspace_id uuid;
begin
  if new.raw_user_meta_data->>'nexus_managed_workspace' = 'true'
     or new.raw_app_meta_data->>'provider' = 'workos'
     or coalesce(new.raw_app_meta_data->'providers', '[]'::jsonb) ? 'workos' then
    return new;
  end if;
  insert into public.workspaces(name, created_by)
  values (coalesce(nullif(new.raw_user_meta_data->>'workspace_name', ''), 'My workspace'), new.id)
  returning id into new_workspace_id;
  insert into public.workspace_members(workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');
  return new;
end;
$function$;

create or replace function nexus_private.register_legacy_principal()
returns trigger language plpgsql security definer set search_path to '' as $function$
begin
  if new.raw_app_meta_data->>'provider' = 'workos'
     or coalesce(new.raw_app_meta_data->'providers', '[]'::jsonb) ? 'workos' then
    return new;
  end if;
  insert into public.nexus_principals(id,provider,issuer,subject,legacy_auth_id,email)
  values(new.id,'supabase','supabase',new.id::text,new.id,new.email)
  on conflict(id) do update set email=excluded.email;
  return new;
end;
$function$;
