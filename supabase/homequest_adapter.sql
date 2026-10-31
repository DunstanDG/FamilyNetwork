-- Connecting the calendar to HomeQuest.
--
-- Out of the box, confirmed events that someone adds to HomeQuest are written to
-- family.homequest_outbox, and free/busy is empty. Once HomeQuest's schema is settled, edit the
-- three functions below to match it and run this file in the SQL editor. Nothing else in Family
-- Network needs to change: every HomeQuest read and write goes through these three.
--
-- Everything marked REPLACE is a guess at HomeQuest's tables. The file stops at the first line
-- until you've edited it, so it can't be run by accident.
do $$ begin raise exception 'Edit supabase/homequest_adapter.sql for HomeQuest''s real tables first.'; end $$;

-- ---------------------------------------------------------------------------------------------
-- Optional but recommended: a role that can touch only what the spec allows (write events, read
-- busy times), so these functions can't reach care logs, school data or to-dos even by mistake.
-- ---------------------------------------------------------------------------------------------
-- create role family_bridge nologin;
-- grant usage on schema homequest to family_bridge;                                   -- REPLACE schema
-- grant select, insert, update, delete on homequest.events to family_bridge;          -- REPLACE table
-- grant select (household_id, starts_at, ends_at) on homequest.events to family_bridge;
-- grant usage on schema family to family_bridge;
-- grant insert on family.homequest_outbox to family_bridge;
-- ...then after the functions are created:
-- alter function family.homequest_upsert_event(text, jsonb) owner to family_bridge;
-- alter function family.homequest_delete_event(text, uuid) owner to family_bridge;
-- alter function family.homequest_busy(uuid, timestamptz, timestamptz) owner to family_bridge;

-- ---------------------------------------------------------------------------------------------
-- Create or update the household's copy. Returns HomeQuest's id for it (kept on family.events).
-- p_event = { event_id, title, starts_at, ends_at, place, place_url, attendees: [{ id, name }] }
-- ---------------------------------------------------------------------------------------------
create or replace function family.homequest_upsert_event(p_existing text, p_event jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare id_ text;
  hh uuid := (select id from family.households where homequest_linked limit 1);
begin
  if p_existing is not null and p_existing not like 'queued-%' then
    update homequest.events                                                            -- REPLACE
    set title     = p_event ->> 'title',
        starts_at = (p_event ->> 'starts_at')::timestamptz,
        ends_at   = (p_event ->> 'ends_at')::timestamptz,
        location  = p_event ->> 'place',
        attendees = (select array_agg(a ->> 'name') from jsonb_array_elements(p_event -> 'attendees') a)
    where id::text = p_existing
    returning id::text into id_;
  end if;
  if id_ is null then
    insert into homequest.events (household_id, title, starts_at, ends_at, location, attendees, source)   -- REPLACE
    values (
      hh,                                                                             -- REPLACE: HomeQuest's household id
      p_event ->> 'title', (p_event ->> 'starts_at')::timestamptz, (p_event ->> 'ends_at')::timestamptz,
      p_event ->> 'place',
      (select array_agg(a ->> 'name') from jsonb_array_elements(p_event -> 'attendees') a),
      'family-network'
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
    delete from homequest.events where id::text = p_id;                                -- REPLACE
  end if;
  insert into family.homequest_outbox (action, event_id, homequest_event_id, processed_at) values ('delete', p_event, p_id, now());
end $$;

-- Busy times only (never titles or details), for the voting grid.
create or replace function family.homequest_busy(p_household uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select e.starts_at, e.ends_at
  from homequest.events e                                                              -- REPLACE
  where e.ends_at > p_from and e.starts_at < p_to
    and coalesce(e.source, '') <> 'family-network';   -- don't show our own plans as clashes
$$;

revoke all on function family.homequest_upsert_event(text, jsonb), family.homequest_delete_event(text, uuid),
  family.homequest_busy(uuid, timestamptz, timestamptz) from public;

-- Events added before the adapter was connected are queued with ids starting 'queued-'. To send
-- them across now, re-sync each confirmed event that has one:
-- select family.homequest_sync(post_id) from family.events where homequest_event_id like 'queued-%';
-- (homequest_sync passes the queued id back in; the functions above treat it as "not there yet".)
