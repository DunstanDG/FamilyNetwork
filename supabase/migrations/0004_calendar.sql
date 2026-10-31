-- Family Network, phase 4: calendar voting.
--
-- Someone proposes an event with 2-6 date/time slots and 1-4 places. Everyone marks each slot
-- Yes (2) / If needed (1) / No (0) and ranks the places. Voting closes at the deadline, or early once
-- every adult has voted; the best slot and place win (ties go the organiser's way). The organiser can
-- also confirm whenever they like, change the date later, or cancel.
--
-- Confirmed events reach HomeQuest only for household members who choose "Add to my HomeQuest" when
-- they RSVP (a parent can do it for a child). All HomeQuest access goes through the three adapter
-- functions at the bottom of this file; see supabase/homequest_adapter.sql to point them at
-- HomeQuest's own tables.

create table family.events (
  post_id            uuid primary key references family.posts (id) on delete cascade,
  title              text not null check (char_length(title) between 1 and 120),
  deadline           timestamptz not null,
  status             text not null default 'voting' check (status in ('voting', 'confirmed', 'cancelled')),
  chosen_option_id   uuid,
  chosen_place_id    uuid,
  confirmed_at       timestamptz,
  reminded_for       timestamptz,   -- the start time the day-before reminder was sent for
  homequest_event_id text,          -- the HomeQuest copy, while anyone has opted in
  created_at         timestamptz not null default now()
);

create table family.event_options (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references family.events (post_id) on delete cascade,
  kind       text not null check (kind in ('slot', 'place')),
  starts_at  timestamptz,
  ends_at    timestamptz,
  place_name text check (char_length(place_name) between 1 and 120),
  place_url  text check (place_url is null or (place_url ~ '^https?://' and char_length(place_url) <= 1000)),
  position   int not null default 0,
  check ((kind = 'slot' and starts_at is not null and place_name is null)
      or (kind = 'place' and place_name is not null and starts_at is null and ends_at is null)),
  check (ends_at is null or ends_at > starts_at)
);
create index event_options_event_idx on family.event_options (event_id, kind, position);

alter table family.events
  add constraint events_chosen_option_fkey foreign key (chosen_option_id) references family.event_options (id) on delete set null,
  add constraint events_chosen_place_fkey foreign key (chosen_place_id) references family.event_options (id) on delete set null;

create table family.event_votes (
  option_id  uuid not null references family.event_options (id) on delete cascade,
  user_id    uuid not null default auth.uid() references family.profiles (id) on delete cascade,
  answer     text check (answer in ('yes', 'if_needed', 'no')),   -- for slots
  rank       int check (rank between 1 and 4),                     -- for places, 1 = favourite
  updated_at timestamptz not null default now(),
  primary key (option_id, user_id),
  check (num_nonnulls(answer, rank) = 1)
);

create table family.event_rsvps (
  event_id         uuid not null references family.events (post_id) on delete cascade,
  user_id          uuid not null references family.profiles (id) on delete cascade,
  answer           text not null check (answer in ('going', 'maybe', 'not_going')),
  add_to_homequest boolean not null default false,
  set_by           uuid default auth.uid() references family.profiles (id) on delete set null,
  updated_at       timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- What has been asked of HomeQuest. The default adapter only records here; a direct adapter writes
-- straight into HomeQuest and records here too, as a log.
create table family.homequest_outbox (
  id                 bigint generated always as identity primary key,
  action             text not null check (action in ('upsert', 'delete')),
  event_id           uuid,
  homequest_event_id text,
  payload            jsonb,
  created_at         timestamptz not null default now(),
  processed_at       timestamptz
);

-- ---------------------------------------------------------------------------------------------
-- HomeQuest adapter: the only functions that know HomeQuest exists.
-- These defaults queue changes in family.homequest_outbox and report no busy times.
-- ---------------------------------------------------------------------------------------------

-- Create or update the household's copy of an event; returns HomeQuest's id for it.
-- p_event: { title, starts_at, ends_at, place, place_url, link, attendees: [{ id, name }] }
create function family.homequest_upsert_event(p_existing text, p_event jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare id_ bigint;
begin
  insert into family.homequest_outbox (action, event_id, homequest_event_id, payload)
  values ('upsert', (p_event ->> 'event_id')::uuid, p_existing, p_event)
  returning id into id_;
  return coalesce(p_existing, 'queued-' || (p_event ->> 'event_id'));
end $$;

create function family.homequest_delete_event(p_id text, p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into family.homequest_outbox (action, event_id, homequest_event_id) values ('delete', p_event, p_id);
end $$;

-- When is this household busy? Times only, never what they are doing.
create function family.homequest_busy(p_household uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select null::timestamptz, null::timestamptz where false;
$$;

-- ---------------------------------------------------------------------------------------------
-- Scoring (mirrored in src/lib/events.js so the grid can update live)
-- ---------------------------------------------------------------------------------------------

create function family.best_options(p_event uuid) returns table (slot_id uuid, place_id uuid)
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
           coalesce(sum((select n from nplaces) - v.rank + 1), 0) as score,
           min(case when v.user_id = (select organiser from ev) then v.rank end) as mine
    from family.event_options o left join family.event_votes v on v.option_id = o.id
    where o.event_id = p_event and o.kind = 'place' group by o.id
  )
  select (select id from slots order by score desc, mine desc nulls last, starts_at, position limit 1),
         (select id from places order by score desc, mine asc nulls last, position limit 1);
$$;

-- ---------------------------------------------------------------------------------------------
-- Keeping HomeQuest in step
-- ---------------------------------------------------------------------------------------------

create function family.homequest_sync(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ev        family.events;
  slot      family.event_options;
  place     family.event_options;
  attendees jsonb;
  new_id    text;
begin
  select * into ev from family.events where post_id = p_event;
  if not found then return; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'name', pr.display_name) order by pr.display_name), '[]'::jsonb)
  into attendees
  from family.event_rsvps r
  join family.profiles pr on pr.id = r.user_id
  join family.households h on h.id = pr.household_id
  where r.event_id = p_event and r.add_to_homequest and r.answer <> 'not_going' and h.homequest_linked;

  if ev.status = 'confirmed' and jsonb_array_length(attendees) > 0 then
    select * into slot from family.event_options where id = ev.chosen_option_id;
    select * into place from family.event_options where id = ev.chosen_place_id;
    new_id := family.homequest_upsert_event(ev.homequest_event_id, jsonb_build_object(
      'event_id', ev.post_id, 'title', ev.title, 'starts_at', slot.starts_at,
      'ends_at', coalesce(slot.ends_at, slot.starts_at + interval '2 hours'),
      'place', place.place_name, 'place_url', place.place_url, 'attendees', attendees));
    update family.events set homequest_event_id = new_id where post_id = p_event and homequest_event_id is distinct from new_id;
  elsif ev.homequest_event_id is not null then
    perform family.homequest_delete_event(ev.homequest_event_id, p_event);
    update family.events set homequest_event_id = null where post_id = p_event;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- What the app calls
-- ---------------------------------------------------------------------------------------------

-- p_slots: [{ starts_at, ends_at? }], p_places: [{ name, url? }]. Returns the new post's id.
create function family.propose_event(
  p_id uuid, p_title text, p_body text, p_deadline timestamptz, p_slots jsonb, p_places jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  title_  text := left(trim(coalesce(p_title, '')), 120);
  n_slots int := jsonb_array_length(coalesce(p_slots, '[]'::jsonb));
  n_place int := jsonb_array_length(coalesce(p_places, '[]'::jsonb));
  first_  timestamptz;
  me      uuid := auth.uid();
begin
  if not family.is_member() then raise exception 'not a member'; end if;
  if title_ = '' then raise exception 'please give the event a name'; end if;
  if n_slots < 2 or n_slots > 6 then raise exception 'offer between 2 and 6 dates'; end if;
  if n_place < 1 or n_place > 4 then raise exception 'offer between 1 and 4 places'; end if;
  select min((s ->> 'starts_at')::timestamptz) into first_ from jsonb_array_elements(p_slots) s;
  if first_ <= now() then raise exception 'dates must be in the future'; end if;
  if p_deadline <= now() then raise exception 'the voting deadline must be in the future'; end if;
  if p_deadline > first_ then raise exception 'voting must close before the first date'; end if;
  if p_deadline > now() + interval '60 days' then raise exception 'voting can stay open for 60 days at most'; end if;

  insert into family.posts (id, author_id, kind, body, payload)
  values (coalesce(p_id, gen_random_uuid()), me, 'event', left(coalesce(p_body, ''), 5000), jsonb_build_object('title', title_))
  returning id into p_id;
  insert into family.events (post_id, title, deadline) values (p_id, title_, p_deadline);

  insert into family.event_options (event_id, kind, starts_at, ends_at, position)
  select p_id, 'slot', (s ->> 'starts_at')::timestamptz, nullif(s ->> 'ends_at', '')::timestamptz, (ord - 1)::int
  from jsonb_array_elements(p_slots) with ordinality as t(s, ord);
  insert into family.event_options (event_id, kind, place_name, place_url, position)
  select p_id, 'place', left(trim(pl ->> 'name'), 120), nullif(trim(coalesce(pl ->> 'url', '')), ''), (ord - 1)::int
  from jsonb_array_elements(p_places) with ordinality as t(pl, ord);

  insert into family.notifications (user_id, actor_id, kind, module, post_id, snippet)
  select pr.id, me, 'vote', 'event', p_id, title_ from family.profiles pr where pr.id <> me;
  return p_id;
end $$;

create function family.confirm_choice(p_event uuid, p_slot uuid, p_place uuid, p_actor uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  ev    family.events;
  slot  family.event_options;
  place family.event_options;
  when_ text;
begin
  select * into ev from family.events where post_id = p_event for update;
  select * into slot from family.event_options where id = p_slot and event_id = p_event and kind = 'slot';
  if not found then raise exception 'pick one of the offered dates'; end if;
  select * into place from family.event_options where id = p_place and event_id = p_event and kind = 'place';
  if not found then raise exception 'pick one of the offered places'; end if;
  if ev.status = 'confirmed' and ev.chosen_option_id = p_slot and ev.chosen_place_id = p_place then return; end if;

  update family.events
  set status = 'confirmed', chosen_option_id = p_slot, chosen_place_id = p_place, confirmed_at = now(),
      reminded_for = case when ev.chosen_option_id = p_slot then reminded_for end
  where post_id = p_event;

  when_ := to_char(slot.starts_at at time zone 'Europe/London', 'Dy FMDD Mon, HH24:MI');
  insert into family.notifications (user_id, actor_id, kind, module, post_id, snippet)
  select pr.id, p_actor, 'event', 'event', p_event, left(format('%s: %s at %s', ev.title, when_, place.place_name), 140)
  from family.profiles pr where pr.id is distinct from p_actor;

  perform family.homequest_sync(p_event);
end $$;

create function family.confirm_event(p_event uuid, p_slot uuid, p_place uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare st text; organiser uuid;
begin
  select e.status, p.author_id into st, organiser from family.events e join family.posts p on p.id = e.post_id where e.post_id = p_event;
  if not found then raise exception 'no such event'; end if;
  if organiser is distinct from auth.uid() and not family.is_admin() then raise exception 'only the organiser can confirm'; end if;
  if st = 'cancelled' then raise exception 'this event was cancelled'; end if;
  perform family.confirm_choice(p_event, p_slot, p_place, auth.uid());
end $$;

create function family.cancel_event(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ev family.events; organiser uuid;
begin
  select e.* into ev from family.events e where e.post_id = p_event for update;
  if not found then raise exception 'no such event'; end if;
  select author_id into organiser from family.posts where id = p_event;
  if organiser is distinct from auth.uid() and not family.is_admin() then raise exception 'only the organiser can cancel'; end if;
  if ev.status = 'cancelled' then return; end if;
  update family.events set status = 'cancelled' where post_id = p_event;
  insert into family.notifications (user_id, actor_id, kind, module, post_id, snippet)
  select pr.id, auth.uid(), 'event', 'event', p_event, left(format('Cancelled: %s', ev.title), 140)
  from family.profiles pr where pr.id <> auth.uid();
  perform family.homequest_sync(p_event);
end $$;

-- Has every adult voted on every date? (Children may vote but nobody waits for them.)
create function family.everyone_voted(p_event uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from family.profiles pr, family.event_options o
    where o.event_id = p_event and o.kind = 'slot' and pr.role in ('admin', 'adult')
      and not exists (select 1 from family.event_votes v where v.option_id = o.id and v.user_id = pr.id)
  );
$$;

-- Replaces your votes on one event. p_votes: [{ option_id, answer }] for dates, [{ option_id, rank }] for places.
create function family.cast_votes(p_event uuid, p_votes jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  ev   family.events;
  me   uuid := auth.uid();
  best record;
begin
  if not family.is_member() then raise exception 'not a member'; end if;
  select * into ev from family.events where post_id = p_event for update;
  if not found then raise exception 'no such event'; end if;
  if ev.status <> 'voting' or ev.deadline <= now() then raise exception 'voting has closed'; end if;

  if exists (
    select 1 from jsonb_to_recordset(p_votes) as x(option_id uuid, answer text, rank int)
    left join family.event_options o on o.id = x.option_id and o.event_id = p_event
    where o.id is null
       or (o.kind = 'slot' and (x.answer is null or x.rank is not null))
       or (o.kind = 'place' and (x.rank is null or x.answer is not null))
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

-- Going / maybe / can't, for yourself or for a child in your household; optionally into HomeQuest.
create function family.rsvp(p_event uuid, p_answer text, p_add_to_homequest boolean default false, p_for uuid default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  me     family.profiles;
  target family.profiles;
  linked boolean;
begin
  select * into me from family.profiles where id = auth.uid();
  if not found then raise exception 'not a member'; end if;
  select * into target from family.profiles where id = coalesce(p_for, me.id);
  if not found then raise exception 'no such member'; end if;
  if target.id <> me.id then
    if target.role <> 'child' or me.role = 'child' or me.household_id is null or target.household_id is distinct from me.household_id then
      raise exception 'you can only answer for children in your household';
    end if;
  end if;
  if not exists (select 1 from family.events where post_id = p_event and status = 'confirmed') then
    raise exception 'this event isn''t confirmed';
  end if;
  select coalesce(h.homequest_linked, false) into linked from family.households h where h.id = target.household_id;
  if p_add_to_homequest and not coalesce(linked, false) then raise exception 'that household doesn''t use HomeQuest'; end if;

  insert into family.event_rsvps (event_id, user_id, answer, add_to_homequest, set_by, updated_at)
  values (p_event, target.id, p_answer, coalesce(p_add_to_homequest, false), me.id, now())
  on conflict (event_id, user_id) do update
    set answer = excluded.answer, add_to_homequest = excluded.add_to_homequest, set_by = excluded.set_by, updated_at = now();
  perform family.homequest_sync(p_event);
end $$;

-- Busy times for your own household between two dates, for the voting grid. Times only.
create function family.household_busy(p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare hh uuid;
begin
  select pr.household_id into hh from family.profiles pr join family.households h on h.id = pr.household_id
  where pr.id = auth.uid() and h.homequest_linked;
  if hh is null or p_to <= p_from or p_to - p_from > interval '120 days' then return; end if;
  return query select b.starts_at, b.ends_at from family.homequest_busy(hh, p_from, p_to) b;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Scheduled jobs (see supabase/schedule.sql)
-- ---------------------------------------------------------------------------------------------

-- Voting deadlines that have passed: confirm the best date and place.
create function family.close_due_events(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare e record; best record; n int := 0;
begin
  for e in select post_id from family.events where status = 'voting' and deadline <= p_now loop
    select * into best from family.best_options(e.post_id);
    perform family.confirm_choice(e.post_id, best.slot_id, best.place_id, null);
    n := n + 1;
  end loop;
  return n;
end $$;

-- From 9am the day before, remind everyone who hasn't said they can't come.
create function family.send_event_reminders(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = '' as $$
declare e record; n int := 0;
  local_now timestamp := p_now at time zone 'Europe/London';
begin
  if extract(hour from local_now) < 9 then return 0; end if;
  for e in
    select ev.post_id, ev.title, o.starts_at, pl.place_name
    from family.events ev
    join family.event_options o on o.id = ev.chosen_option_id
    left join family.event_options pl on pl.id = ev.chosen_place_id
    where ev.status = 'confirmed'
      and (o.starts_at at time zone 'Europe/London')::date = local_now::date + 1
      and ev.reminded_for is distinct from o.starts_at
  loop
    insert into family.notifications (user_id, kind, module, post_id, snippet)
    select pr.id, 'event', 'event', e.post_id,
           left(format('Tomorrow: %s at %s, %s', e.title, to_char(e.starts_at at time zone 'Europe/London', 'HH24:MI'), e.place_name), 140)
    from family.profiles pr
    where not exists (select 1 from family.event_rsvps r where r.event_id = e.post_id and r.user_id = pr.id and r.answer = 'not_going');
    update family.events set reminded_for = e.starts_at where post_id = e.post_id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------------------------

alter table family.events           enable row level security;
alter table family.event_options    enable row level security;
alter table family.event_votes      enable row level security;
alter table family.event_rsvps      enable row level security;
alter table family.homequest_outbox enable row level security;

-- Everything is written through the functions above; members can read it all (votes are open, like a
-- sign-up sheet on the fridge).
create policy events_select on family.events for select to authenticated using (family.is_member());
create policy event_options_select on family.event_options for select to authenticated using (family.is_member());
create policy event_votes_select on family.event_votes for select to authenticated using (family.is_member());
create policy event_rsvps_select on family.event_rsvps for select to authenticated using (family.is_member());

grant select on family.events, family.event_options, family.event_votes, family.event_rsvps to authenticated;
grant all on family.events, family.event_options, family.event_votes, family.event_rsvps, family.homequest_outbox to service_role;

revoke all on function
  family.homequest_upsert_event(text, jsonb), family.homequest_delete_event(text, uuid),
  family.homequest_busy(uuid, timestamptz, timestamptz), family.homequest_sync(uuid),
  family.best_options(uuid), family.everyone_voted(uuid),
  family.propose_event(uuid, text, text, timestamptz, jsonb, jsonb),
  family.confirm_choice(uuid, uuid, uuid, uuid), family.confirm_event(uuid, uuid, uuid), family.cancel_event(uuid),
  family.cast_votes(uuid, jsonb), family.rsvp(uuid, text, boolean, uuid), family.household_busy(timestamptz, timestamptz),
  family.close_due_events(timestamptz), family.send_event_reminders(timestamptz)
from public;
grant execute on function
  family.propose_event(uuid, text, text, timestamptz, jsonb, jsonb), family.confirm_event(uuid, uuid, uuid),
  family.cancel_event(uuid), family.cast_votes(uuid, jsonb), family.rsvp(uuid, text, boolean, uuid),
  family.household_busy(timestamptz, timestamptz)
to authenticated;
grant execute on function family.close_due_events(timestamptz), family.send_event_reminders(timestamptz) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table family.events, family.event_votes, family.event_rsvps;
  end if;
end $$;
