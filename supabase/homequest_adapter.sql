-- Connecting the calendar to HomeQuest.
--
-- Out of the box, confirmed events that someone adds to HomeQuest are written to
-- family.homequest_outbox, and free/busy is empty. Once HomeQuest's schema is settled, edit this file
-- to match it and run it in the SQL editor. Nothing else in Family Network needs to change: every
-- HomeQuest read and write goes through the three functions below.
--
-- Everything marked REPLACE is a guess at HomeQuest's tables. The first line stops the file until
-- you've edited it, so it can't be run by accident.
--
-- Safety built in:
--  * The functions run as `family_bridge`, a role that can write HomeQuest events and read their
--    times, and nothing else: no care logs, school data or to-dos, even by mistake.
--  * Each function works only on the HomeQuest household it is given (households.homequest_household_id
--    on the one linked family household), never "whichever comes first".
--  * If any of them fails, family.homequest_sync logs the error in family.homequest_outbox and the
--    calendar carries on (migration 0005).
do $$ begin raise exception 'Edit supabase/homequest_adapter.sql for HomeQuest''s real tables first.'; end $$;

-- ---------------------------------------------------------------------------------------------
-- 0. Which HomeQuest household is ours. Set it once (find the id in HomeQuest's households table).
-- ---------------------------------------------------------------------------------------------
update family.households set homequest_household_id = 'REPLACE-HOMEQUEST-HOUSEHOLD-ID' where homequest_linked;

-- ---------------------------------------------------------------------------------------------
-- 1. The bridge role: only what the spec allows (write events, read busy times).
-- ---------------------------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'family_bridge') then create role family_bridge nologin; end if;
end $$;
grant usage on schema homequest to family_bridge;                                            -- REPLACE schema
grant select (id, household_id, starts_at, ends_at, source, source_id) on homequest.events to family_bridge;   -- REPLACE
grant insert, update, delete on homequest.events to family_bridge;                           -- REPLACE
grant usage on schema family to family_bridge;
grant insert on family.homequest_outbox to family_bridge;
-- Lets postgres hand ownership of the functions to the bridge below.
grant family_bridge to postgres;

-- ---------------------------------------------------------------------------------------------
-- 2. Create or update our copy of an event. Returns HomeQuest's id for it (kept on family.events).
-- p_event = { event_id, household_id, homequest_household_id, title, starts_at, ends_at, place,
--             place_url, attendees: [{ id, name }] }
-- ---------------------------------------------------------------------------------------------
create or replace function family.homequest_upsert_event(p_existing text, p_event jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  id_ text;
  hq  text := p_event ->> 'homequest_household_id';
begin
  if hq is null then raise exception 'set households.homequest_household_id first'; end if;
  if p_existing is not null and p_existing not like 'queued-%' then
    update homequest.events                                                                  -- REPLACE
    set title     = p_event ->> 'title',
        starts_at = (p_event ->> 'starts_at')::timestamptz,
        ends_at   = (p_event ->> 'ends_at')::timestamptz,
        location  = p_event ->> 'place',
        attendees = (select array_agg(a ->> 'name') from jsonb_array_elements(p_event -> 'attendees') a)
    where id::text = p_existing and household_id::text = hq and source = 'family-network'
    returning id::text into id_;
  end if;
  if id_ is null then
    insert into homequest.events (household_id, title, starts_at, ends_at, location, attendees, source, source_id)   -- REPLACE
    values (
      hq::uuid,                                                                               -- REPLACE type if not uuid
      p_event ->> 'title', (p_event ->> 'starts_at')::timestamptz, (p_event ->> 'ends_at')::timestamptz,
      p_event ->> 'place',
      (select array_agg(a ->> 'name') from jsonb_array_elements(p_event -> 'attendees') a),
      'family-network', p_event ->> 'event_id'
    )
    returning id::text into id_;
  end if;
  insert into family.homequest_outbox (action, event_id, homequest_event_id, payload, processed_at)
  values ('upsert', (p_event ->> 'event_id')::uuid, id_, p_event, now());
  return id_;
end $$;

create or replace function family.homequest_delete_event(p_id text, p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_id not like 'queued-%' then
    -- Only ever our own copies.
    delete from homequest.events where id::text = p_id and source = 'family-network';        -- REPLACE
  end if;
  insert into family.homequest_outbox (action, event_id, homequest_event_id, processed_at) values ('delete', p_event, p_id, now());
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Busy times for one household only (never titles or details), for the voting grid.
-- p_household is the family household; its HomeQuest id is looked up, never guessed.
-- ---------------------------------------------------------------------------------------------
create or replace function family.homequest_busy(p_household uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.starts_at, e.ends_at
  from homequest.events e                                                                    -- REPLACE
  where e.household_id::text = (select h.homequest_household_id from family.households h where h.id = p_household and h.homequest_linked)
    and e.ends_at > p_from and e.starts_at < p_to
    and coalesce(e.source, '') <> 'family-network';   -- don't show our own plans as clashes
$$;
grant select (id, homequest_linked, homequest_household_id) on family.households to family_bridge;

-- ---------------------------------------------------------------------------------------------
-- 4. Run them as the bridge, and keep them away from everyone else.
-- ---------------------------------------------------------------------------------------------
alter function family.homequest_upsert_event(text, jsonb) owner to family_bridge;
alter function family.homequest_delete_event(text, uuid) owner to family_bridge;
alter function family.homequest_busy(uuid, timestamptz, timestamptz) owner to family_bridge;
revoke all on function family.homequest_upsert_event(text, jsonb), family.homequest_delete_event(text, uuid),
  family.homequest_busy(uuid, timestamptz, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. Check, then send across anything queued before the adapter was connected
-- ---------------------------------------------------------------------------------------------
-- Busy times for our household over the next month (should be times only):
--   select * from family.homequest_busy((select id from family.households where homequest_linked), now(), now() + interval '30 days');
-- Re-sync queued events (homequest_sync passes 'queued-…' ids back in; the functions treat them as new):
--   select family.homequest_sync(post_id) from family.events where homequest_event_id like 'queued-%';
-- Anything that failed:
--   select created_at, action, event_id, error from family.homequest_outbox where error is not null order by id desc;
