-- Family Network, hardening after the pre-launch review.
--
-- 1. Function permissions: Supabase can grant EXECUTE on new functions straight to anon and
--    authenticated, which "revoke ... from public" doesn't undo. Revoke everything here and grant
--    back exactly what the app, the gateway and the Edge Functions call.
-- 2. HomeQuest: exactly one family household can be linked, mapped to HomeQuest's own household id,
--    and a HomeQuest failure is logged and skipped instead of stopping voting, closing or RSVPs.
-- 3. Calendar: place ranks can't exceed the number of places; an event nobody voted on is handed back
--    to its organiser instead of being confirmed on its earliest date; no "tomorrow" reminder right
--    after a same-day confirmation.

-- ---------------------------------------------------------------------------------------------
-- HomeQuest link
-- ---------------------------------------------------------------------------------------------

alter table family.households add column if not exists homequest_household_id text
  check (homequest_household_id is null or char_length(homequest_household_id) <= 100);
-- The spec links one household (the home one) to HomeQuest. Enforce it, so nothing has to guess which.
create unique index if not exists households_one_homequest_link on family.households ((true)) where homequest_linked;

alter table family.homequest_outbox add column if not exists error text;

create or replace function family.homequest_sync(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ev        family.events;
  hh        family.households;
  slot      family.event_options;
  place     family.event_options;
  attendees jsonb;
  new_id    text;
begin
  select * into ev from family.events where post_id = p_event;
  if not found then return; end if;
  select * into hh from family.households where homequest_linked;

  select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.display_name) order by pr.display_name), '[]'::jsonb)
  into attendees
  from family.event_rsvps r
  join family.profiles pr on pr.id = r.user_id
  where r.event_id = p_event and r.add_to_homequest and r.answer <> 'not_going' and pr.household_id = hh.id;

  -- Whatever HomeQuest does, voting, closing and RSVPs carry on: failures are logged and skipped.
  begin
    if ev.status = 'confirmed' and hh.id is not null and jsonb_array_length(attendees) > 0 then
      select * into slot from family.event_options where id = ev.chosen_option_id;
      select * into place from family.event_options where id = ev.chosen_place_id;
      new_id := family.homequest_upsert_event(ev.homequest_event_id, jsonb_build_object(
        'event_id', ev.post_id, 'household_id', hh.id, 'homequest_household_id', hh.homequest_household_id,
        'title', ev.title, 'starts_at', slot.starts_at,
        'ends_at', coalesce(slot.ends_at, slot.starts_at + interval '2 hours'),
        'place', place.place_name, 'place_url', place.place_url, 'attendees', attendees));
      update family.events set homequest_event_id = new_id where post_id = p_event and homequest_event_id is distinct from new_id;
    elsif ev.homequest_event_id is not null then
      perform family.homequest_delete_event(ev.homequest_event_id, p_event);
      update family.events set homequest_event_id = null where post_id = p_event;
    end if;
  exception when others then
    insert into family.homequest_outbox (action, event_id, homequest_event_id, error)
    values (case when ev.status = 'confirmed' then 'upsert' else 'delete' end, p_event, ev.homequest_event_id, left(sqlerrm, 500));
  end;
end $$;

-- Busy times for your household: passes the household through, so an adapter can (and must) filter.
create or replace function family.household_busy(p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare hh uuid;
begin
  select pr.household_id into hh from family.profiles pr join family.households h on h.id = pr.household_id
  where pr.id = auth.uid() and h.homequest_linked;
  if hh is null or p_to <= p_from or p_to - p_from > interval '120 days' then return; end if;
  begin
    return query select b.starts_at, b.ends_at from family.homequest_busy(hh, p_from, p_to) b;
  exception when others then
    return; -- no busy marks is better than a broken voting grid
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Calendar fixes
-- ---------------------------------------------------------------------------------------------

alter table family.events add column if not exists nudged_at timestamptz;   -- organiser told nobody voted

create or replace function family.best_options(p_event uuid) returns table (slot_id uuid, place_id uuid)
language sql stable security definer set search_path = '' as $$
  with ev as (select e.post_id, p.author_id as organiser from family.events e join family.posts p on p.id = e.post_id where e.post_id = p_event),
  nplaces as (select count(*)::int as n from family.event_options where event_id = p_event and kind = 'place'),
  slots as (
    select o.id, o.starts_at, o.position,
           coalesce(sum(case v.answer when 'yes' then 2 when 'if_needed' then 1 else 0 end), 0) as score,
           max(case when v.user_id = (select organiser from ev) then case v.answer when 'yes' then 2 when 'if_needed' then 1 else 0 end end) as mine
    from family.event_options o left join family.event_votes v on v.option_id = o.id
    where o.event_id = p_event and o.kind = 'slot' group by o.id
  ),
  places as (
    select o.id, o.position,
           coalesce(sum(greatest(0, (select n from nplaces) - v.rank + 1)), 0) as score,
           min(case when v.user_id = (select organiser from ev) then v.rank end) as mine
    from family.event_options o left join family.event_votes v on v.option_id = o.id
    where o.event_id = p_event and o.kind = 'place' group by o.id
  )
  select (select id from slots order by score desc, mine desc nulls last, starts_at, position limit 1),
         (select id from places order by score desc, mine asc nulls last, position limit 1);
$$;

create or replace function family.cast_votes(p_event uuid, p_votes jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  ev      family.events;
  me      uuid := auth.uid();
  best    record;
  nplaces int;
begin
  if not family.is_member() then raise exception 'not a member'; end if;
  select * into ev from family.events where post_id = p_event for update;
  if not found then raise exception 'no such event'; end if;
  if ev.status <> 'voting' or ev.deadline <= now() then raise exception 'voting has closed'; end if;
  select count(*) into nplaces from family.event_options where event_id = p_event and kind = 'place';

  if exists (
    select 1 from jsonb_to_recordset(p_votes) as x(option_id uuid, answer text, rank int)
    left join family.event_options o on o.id = x.option_id and o.event_id = p_event
    where o.id is null
       or (o.kind = 'slot' and (x.answer is null or x.rank is not null))
       or (o.kind = 'place' and (x.rank is null or x.answer is not null or x.rank < 1 or x.rank > nplaces))
  ) then raise exception 'those votes don''t match this event'; end if;
  if (select count(x.rank) <> count(distinct x.rank) from jsonb_to_recordset(p_votes) as x(option_id uuid, rank int)) then
    raise exception 'give each place a different rank';
  end if;

  delete from family.event_votes v using family.event_options o
  where v.option_id = o.id and o.event_id = p_event and v.user_id = me;
  insert into family.event_votes (option_id, user_id, answer, rank)
  select x.option_id, me, x.answer, x.rank from jsonb_to_recordset(p_votes) as x(option_id uuid, answer text, rank int);

  if family.everyone_voted(p_event) then
    select * into best from family.best_options(p_event);
    perform family.confirm_choice(p_event, best.slot_id, best.place_id, null);
    return 'confirmed';
  end if;
  return 'voting';
end $$;

-- Deadlines that have passed: confirm the best date and place, unless nobody voted at all. Then the
-- organiser is told (once) and decides: pick a date, or cancel.
create or replace function family.close_due_events(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare e record; best record; n int := 0;
begin
  for e in
    select ev.post_id, ev.title, ev.nudged_at, p.author_id
    from family.events ev join family.posts p on p.id = ev.post_id
    where ev.status = 'voting' and ev.deadline <= p_now
  loop
    if not exists (select 1 from family.event_votes v join family.event_options o on o.id = v.option_id where o.event_id = e.post_id) then
      if e.nudged_at is null then
        insert into family.notifications (user_id, kind, module, post_id, snippet)
        select e.author_id, 'vote', 'event', e.post_id, left(format('Nobody voted on %s. Pick a date or cancel it.', e.title), 140)
        where e.author_id is not null;
        update family.events set nudged_at = p_now where post_id = e.post_id;
      end if;
      continue;
    end if;
    select * into best from family.best_options(e.post_id);
    perform family.confirm_choice(e.post_id, best.slot_id, best.place_id, null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- From 9am the day before, remind everyone who hasn't said they can't come. If the event was only
-- confirmed after that point, the confirmation already told everyone, so it is just marked as done.
create or replace function family.send_event_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare e record; n int := 0;
  local_now timestamp := p_now at time zone 'Europe/London';
begin
  if extract(hour from local_now) < 9 then return 0; end if;
  for e in
    select ev.post_id, ev.title, ev.confirmed_at, o.starts_at, pl.place_name,
           (((o.starts_at at time zone 'Europe/London')::date - 1) + time '09:00') at time zone 'Europe/London' as window_opens
    from family.events ev
    join family.event_options o on o.id = ev.chosen_option_id
    left join family.event_options pl on pl.id = ev.chosen_place_id
    where ev.status = 'confirmed'
      and (o.starts_at at time zone 'Europe/London')::date = local_now::date + 1
      and ev.reminded_for is distinct from o.starts_at
  loop
    if e.confirmed_at is null or e.confirmed_at < e.window_opens then
      insert into family.notifications (user_id, kind, module, post_id, snippet)
      select pr.id, 'event', 'event', e.post_id,
             left(format('Tomorrow: %s at %s, %s', e.title, to_char(e.starts_at at time zone 'Europe/London', 'HH24:MI'), e.place_name), 140)
      from family.profiles pr
      where not exists (select 1 from family.event_rsvps r where r.event_id = e.post_id and r.user_id = pr.id and r.answer = 'not_going');
      n := n + 1;
    end if;
    update family.events set reminded_for = e.starts_at where post_id = e.post_id;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Function permissions: nothing by default, then exactly what is called from outside
-- ---------------------------------------------------------------------------------------------

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'family'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end $$;
alter default privileges in schema family revoke execute on functions from public;
alter default privileges in schema family revoke execute on functions from anon, authenticated;

-- Used inside row-level security policies, so the signed-in person must be able to run them.
grant execute on function family.is_member(), family.my_role(), family.is_admin() to authenticated;
-- Before sign-in: "is this invite still good?"
grant execute on function family.peek_invite(text) to anon, authenticated;
-- What the app calls.
grant execute on function
  family.redeem_invite(text, text),
  family.admin_update_member(uuid, text, uuid),
  family.admin_remove_member(uuid),
  family.register_push(text, jsonb, text),
  family.import_family_feed(),
  family.publish_album(uuid),
  family.propose_event(uuid, text, text, timestamptz, jsonb, jsonb),
  family.cast_votes(uuid, jsonb),
  family.confirm_event(uuid, uuid, uuid),
  family.cancel_event(uuid),
  family.rsvp(uuid, text, boolean, uuid),
  family.household_busy(timestamptz, timestamptz)
to authenticated;
-- What the Edge Functions, the photo gateway and the scheduled jobs call with the service key.
grant execute on function
  family.is_member(),
  family.add_feed_item(uuid, text, text, jsonb, boolean, timestamptz),
  family.photo_upload_allowed(uuid, uuid),
  family.record_photo(uuid, uuid, text, int, int, timestamptz, int),
  family.close_due_events(timestamptz),
  family.send_event_reminders(timestamptz)
to service_role;

-- Check on the live project (only the names above should be listed):
-- select routine_name, grantee from information_schema.routine_privileges
-- where routine_schema = 'family' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1;
