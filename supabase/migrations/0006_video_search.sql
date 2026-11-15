-- Family Network: filtered YouTube search.
--
-- Open search over YouTube, with a verdict on every channel it turns up. Results are shown straight
-- away; warnings arrive as each channel is checked (rules first, then a model), and only channels
-- confirmed as junk are hidden. Admins can overrule any verdict.
--
--   yt_channels      one verdict per channel (the long-lived, valuable table)
--   yt_search_cache  a day's worth of search results, so repeats cost no YouTube quota
--   yt_quota         how many uncached searches ran today (YouTube allows about 100 a day)
--   yt_activity      what was played and rated; exported to the home server, then cleared
--   yt_reviews       things waiting for an admin to look at
--
-- Safe to run again. If 0005 is run again afterwards, run this file again too (0005 takes back
-- every function permission, including the two granted at the foot of this file).

-- ---------------------------------------------------------------------------------------------
-- Channel verdicts
-- ---------------------------------------------------------------------------------------------

create table if not exists family.yt_channels (
  channel_id text primary key check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  -- From YouTube, so it may only be kept for 30 days without a refresh (cleared by yt_clear_down).
  title      text check (title is null or char_length(title) <= 200),
  title_at   timestamptz,
  -- checking: asked for, no answer yet.  unchecked: the check failed; try again next time.
  tier       text not null default 'checking' check (tier in ('trusted', 'caution', 'blocked', 'checking', 'unchecked')),
  -- Why: one of the short codes the app turns into words (see src/lib/verdicts.js).
  reason     text not null default '' check (char_length(reason) <= 40),
  topic      text not null default 'other' check (topic in ('news', 'health', 'other')),
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  note       text check (note is null or char_length(note) <= 300),
  -- Who decided: an admin's word is final and is never overwritten by the rules or the model.
  source     text not null default 'pending' check (source in ('pending', 'rules', 'model', 'admin')),
  decided_by uuid references family.profiles (id) on delete set null,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists yt_channels_pending_idx on family.yt_channels (updated_at) where tier in ('checking', 'unchecked');

-- ---------------------------------------------------------------------------------------------
-- Search cache and daily quota (Edge Function only)
-- ---------------------------------------------------------------------------------------------

create table if not exists family.yt_search_cache (
  query_key  text primary key check (char_length(query_key) between 1 and 120),
  results    jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists yt_search_cache_expiry_idx on family.yt_search_cache (expires_at);

create table if not exists family.yt_quota (
  day      date primary key,
  searches int not null default 0
);

-- Counts one uncached search against today's allowance. False once the allowance is used up.
create or replace function family.yt_take_quota(p_cap int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'America/Los_Angeles')::date;   -- YouTube's quota day
  used  int;
begin
  insert into family.yt_quota (day, searches) values (today, 1)
  on conflict (day) do update set searches = family.yt_quota.searches + 1
    where family.yt_quota.searches < p_cap
  returning searches into used;
  return used is not null and used <= p_cap;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Activity: plays and ratings (and searches, if the function is told to log them)
-- ---------------------------------------------------------------------------------------------

create table if not exists family.yt_activity (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references family.profiles (id) on delete cascade,
  kind        text not null check (kind in ('search', 'play', 'like', 'dislike')),
  query       text check (query is null or char_length(query) <= 120),
  video_id    text check (video_id is null or video_id ~ '^[A-Za-z0-9_-]{11}$'),
  channel_id  text check (channel_id is null or channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  created_at  timestamptz not null default now(),
  exported_at timestamptz,
  check ((kind = 'search') = (query is not null)),
  check (kind = 'search' or (video_id is not null and channel_id is not null))
);
create index if not exists yt_activity_export_idx on family.yt_activity (id) where exported_at is null;
create index if not exists yt_activity_age_idx on family.yt_activity (created_at);

-- ---------------------------------------------------------------------------------------------
-- Review queue (admins)
-- ---------------------------------------------------------------------------------------------

create table if not exists family.yt_reviews (
  id          bigint generated always as identity primary key,
  channel_id  text not null references family.yt_channels (channel_id) on delete cascade,
  video_id    text check (video_id is null or video_id ~ '^[A-Za-z0-9_-]{11}$'),
  why         text not null check (why in ('dislike', 'unsure')),
  raised_by   uuid references family.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references family.profiles (id) on delete set null
);
-- One open item per channel and reason: ten dislikes are still one thing to look at.
create unique index if not exists yt_reviews_open_idx on family.yt_reviews (channel_id, why) where resolved_at is null;

-- A thumbs-down puts the channel in front of an admin.
create or replace function family.yt_on_activity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'dislike' then
    insert into family.yt_channels (channel_id) values (new.channel_id) on conflict do nothing;
    insert into family.yt_reviews (channel_id, video_id, why, raised_by)
    values (new.channel_id, new.video_id, 'dislike', new.user_id)
    on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists yt_activity_after_insert on family.yt_activity;
create trigger yt_activity_after_insert after insert on family.yt_activity
  for each row execute function family.yt_on_activity();

-- An admin changing a verdict: it becomes theirs, and anything waiting on that channel is settled.
-- The Edge Function (no signed-in person) writes whatever it likes, except over an admin's verdict.
create or replace function family.yt_guard_channel() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  if auth.uid() is null then
    if old.source = 'admin' and new.source <> 'admin' then
      new.tier := old.tier; new.reason := old.reason; new.source := old.source;
      new.confidence := old.confidence; new.note := old.note; new.topic := old.topic;
      new.decided_by := old.decided_by; new.checked_at := old.checked_at;
    end if;
    return new;
  end if;
  if not family.is_admin() then raise exception 'admins only'; end if;
  if new.tier not in ('trusted', 'caution', 'blocked') then
    raise exception 'choose trusted, caution or blocked';
  end if;
  new.source := 'admin';
  new.reason := 'admin';
  new.confidence := null;
  new.decided_by := auth.uid();
  new.checked_at := now();
  update family.yt_reviews set resolved_at = now(), resolved_by = auth.uid()
  where channel_id = new.channel_id and resolved_at is null;
  return new;
end $$;
drop trigger if exists yt_channels_before_update on family.yt_channels;
create trigger yt_channels_before_update before update on family.yt_channels
  for each row execute function family.yt_guard_channel();

-- ---------------------------------------------------------------------------------------------
-- Nightly clear-down (pg_cron; see supabase/schedule.sql)
-- ---------------------------------------------------------------------------------------------

-- Keeps the small tables small. Activity is only deleted once the home server has exported it, or
-- after 90 days if nothing ever exports it. Verdicts are kept; only stale YouTube titles go.
create or replace function family.yt_clear_down(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n_cache int; n_activity int; n_reviews int; n_titles int; n_quota int;
begin
  delete from family.yt_search_cache where expires_at < p_now;
  get diagnostics n_cache = row_count;

  delete from family.yt_activity
  where (exported_at is not null and created_at < p_now - interval '7 days')
     or created_at < p_now - interval '90 days';
  get diagnostics n_activity = row_count;

  delete from family.yt_reviews where resolved_at < p_now - interval '30 days';
  get diagnostics n_reviews = row_count;

  update family.yt_channels set title = null, title_at = null
  where title is not null and title_at < p_now - interval '30 days';
  get diagnostics n_titles = row_count;

  delete from family.yt_quota where day < (p_now - interval '30 days')::date;
  get diagnostics n_quota = row_count;

  return jsonb_build_object('cache', n_cache, 'activity', n_activity, 'reviews', n_reviews, 'titles', n_titles, 'quota', n_quota);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------

alter table family.yt_channels     enable row level security;
alter table family.yt_search_cache enable row level security;   -- no policies: Edge Function only
alter table family.yt_quota        enable row level security;   -- no policies: Edge Function only
alter table family.yt_activity     enable row level security;
alter table family.yt_reviews      enable row level security;

drop policy if exists yt_channels_select on family.yt_channels;
create policy yt_channels_select on family.yt_channels for select to authenticated using (family.is_member());
drop policy if exists yt_channels_update on family.yt_channels;
create policy yt_channels_update on family.yt_channels for update to authenticated
  using (family.is_admin()) with check (family.is_admin());

-- People see and add only their own plays and ratings. Searches are written by the function.
drop policy if exists yt_activity_select on family.yt_activity;
create policy yt_activity_select on family.yt_activity for select to authenticated using (user_id = auth.uid());
drop policy if exists yt_activity_insert on family.yt_activity;
create policy yt_activity_insert on family.yt_activity for insert to authenticated
  with check (family.is_member() and user_id = auth.uid() and kind in ('play', 'like', 'dislike'));

drop policy if exists yt_reviews_select on family.yt_reviews;
create policy yt_reviews_select on family.yt_reviews for select to authenticated using (family.is_admin());

revoke all on family.yt_channels, family.yt_search_cache, family.yt_quota, family.yt_activity, family.yt_reviews
  from anon, authenticated;
grant select on family.yt_channels to authenticated;
grant update (tier) on family.yt_channels to authenticated;
grant select on family.yt_activity to authenticated;
grant insert (kind, video_id, channel_id) on family.yt_activity to authenticated;
grant select on family.yt_reviews to authenticated;
grant all on family.yt_channels, family.yt_search_cache, family.yt_quota, family.yt_activity, family.yt_reviews to service_role;

-- Function permissions: nothing by default (as 0005), then the one the Edge Function calls.
revoke all on function family.yt_take_quota(int), family.yt_clear_down(timestamptz), family.yt_on_activity(), family.yt_guard_channel()
  from public, anon, authenticated, service_role;
grant execute on function family.yt_take_quota(int) to service_role;

-- Live updates: the app listens for verdicts landing on the channels it is showing.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'family' and tablename = 'yt_channels') then
    alter publication supabase_realtime add table family.yt_channels;
  end if;
end $$;
