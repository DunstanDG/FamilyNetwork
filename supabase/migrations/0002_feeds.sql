-- Family Network, phase 2: feeds move in.
--
-- Adds shared links, videos and podcast episodes, the shows and channels the family follows, the
-- items the feed poller has already seen, and podcast resume positions.
--
-- Auto-posted episodes and videos are ordinary posts with no author. Each one hangs off a daily
-- "New from your shows" digest post (kind 'digest') through posts.digest_id, so Home shows one card
-- a day while the Podcasts and Videos tabs list every episode, each with its own replies and reactions.

-- ---------------------------------------------------------------------------------------------
-- Posts: system posts, digests, and the kinds members can now share
-- ---------------------------------------------------------------------------------------------

alter table family.posts alter column author_id drop not null;     -- null = posted by the feed poller
alter table family.posts drop constraint if exists posts_kind_check;
alter table family.posts add constraint posts_kind_check
  check (kind in ('update', 'photo_album', 'podcast_episode', 'video', 'link', 'event', 'digest'));
alter table family.posts add column if not exists digest_id uuid references family.posts (id) on delete cascade;
create index if not exists posts_digest_idx on family.posts (digest_id) where digest_id is not null;
create index if not exists posts_home_idx on family.posts (created_at desc) where digest_id is null;
-- One digest a day (the day is the family's local date, Europe/London).
create unique index if not exists posts_one_digest_per_day on family.posts ((payload ->> 'day')) where kind = 'digest';

drop policy if exists posts_insert on family.posts;
create policy posts_insert on family.posts for insert to authenticated
  with check (
    family.is_member() and author_id = auth.uid() and not pinned
    and kind in ('update', 'link', 'video', 'podcast_episode')
  );

-- Same rules as phase 1, but safe for posts with no author: nobody can edit the words of a system
-- post (admins can still pin or remove it).
create or replace function family.guard_post_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if new.author_id is distinct from old.author_id or new.kind <> old.kind or new.created_at <> old.created_at
     or new.digest_id is distinct from old.digest_id then
    raise exception 'author, kind and date cannot be changed';
  end if;
  if new.pinned is distinct from old.pinned and not family.is_admin() then
    raise exception 'only an admin can pin posts';
  end if;
  if (new.body, new.payload, new.mentions) is distinct from (old.body, old.payload, old.mentions) then
    if old.author_id is distinct from auth.uid() or now() - old.created_at > interval '15 minutes' then
      raise exception 'posts can only be edited by their author within 15 minutes';
    end if;
    new.edited_at := now();
  end if;
  return new;
end $$;

-- Replies to a system post: the post has no author to notify, so only mentions and the parent
-- reply's author are told.
create or replace function family.notify_on_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  post_author   uuid;
  post_kind     text;
  parent_author uuid;
  snip          text := left(new.body, 140);
begin
  select author_id, kind into post_author, post_kind from family.posts where id = new.post_id;

  insert into family.notifications (user_id, actor_id, kind, module, post_id, comment_id, snippet)
  select p.id, new.author_id, 'mention', post_kind, new.post_id, new.id, snip
  from family.profiles p
  where p.id = any (new.mentions) and p.id <> new.author_id;

  if post_author is not null and post_author <> new.author_id and not (post_author = any (new.mentions)) then
    insert into family.notifications (user_id, actor_id, kind, module, post_id, comment_id, snippet)
    values (post_author, new.author_id, 'reply', post_kind, new.post_id, new.id, snip);
  end if;

  if new.parent_id is not null then
    select author_id into parent_author from family.comments where id = new.parent_id;
    if parent_author <> new.author_id
       and parent_author is distinct from post_author
       and not (parent_author = any (new.mentions)) then
      insert into family.notifications (user_id, actor_id, kind, module, post_id, comment_id, snippet)
      values (parent_author, new.author_id, 'reply', post_kind, new.post_id, new.id, snip);
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Followed shows and channels (shared by the whole family)
-- ---------------------------------------------------------------------------------------------

create table if not exists family.sources (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('podcast', 'youtube')),
  feed_url       text not null unique check (feed_url ~ '^https?://' and char_length(feed_url) <= 2000),
  title          text not null default '' check (char_length(title) <= 200),
  image_url      text check (image_url is null or (image_url ~ '^https://' and char_length(image_url) <= 2000)),
  site_url       text check (site_url is null or (site_url ~ '^https?://' and char_length(site_url) <= 2000)),
  added_by       uuid default auth.uid() references family.profiles (id) on delete set null,
  last_polled_at timestamptz,
  etag           text,
  last_modified  text,
  failures       int not null default 0,
  last_error     text,
  created_at     timestamptz not null default now(),
  -- YouTube channel feeds have one fixed shape; anything else would be a mistake or a trick.
  check (kind <> 'youtube' or feed_url ~ '^https://www\.youtube\.com/feeds/videos\.xml\?channel_id=UC[A-Za-z0-9_-]{22}$')
);

-- Items the poller has seen. guid dedupes episodes and videos before they become posts; post_id is
-- null for back-catalogue items recorded on first follow but never posted.
create table if not exists family.feed_items (
  id         bigint generated always as identity primary key,
  source_id  uuid not null references family.sources (id) on delete cascade,
  guid       text not null,
  post_id    uuid references family.posts (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (source_id, guid)
);

-- Podcast resume positions, one row per person per episode.
create table if not exists family.playback (
  user_id          uuid not null default auth.uid() references family.profiles (id) on delete cascade,
  post_id          uuid not null references family.posts (id) on delete cascade,
  position_seconds numeric not null default 0 check (position_seconds >= 0),
  duration_seconds numeric check (duration_seconds is null or duration_seconds >= 0),
  finished         boolean not null default false,
  updated_at       timestamptz not null default now(),
  primary key (user_id, post_id)
);

alter table family.sources    enable row level security;
alter table family.feed_items enable row level security;
alter table family.playback   enable row level security;

drop policy if exists sources_select on family.sources;
create policy sources_select on family.sources for select to authenticated using (family.is_member());
drop policy if exists sources_insert on family.sources;
create policy sources_insert on family.sources for insert to authenticated
  with check (family.is_member() and added_by = auth.uid());
drop policy if exists sources_delete on family.sources;
create policy sources_delete on family.sources for delete to authenticated
  using (added_by = auth.uid() or family.is_admin());

drop policy if exists feed_items_select on family.feed_items;
create policy feed_items_select on family.feed_items for select to authenticated using (family.is_member());

drop policy if exists playback_select on family.playback;
create policy playback_select on family.playback for select to authenticated using (user_id = auth.uid());
drop policy if exists playback_insert on family.playback;
create policy playback_insert on family.playback for insert to authenticated
  with check (user_id = auth.uid() and family.is_member());
drop policy if exists playback_update on family.playback;
create policy playback_update on family.playback for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists playback_delete on family.playback;
create policy playback_delete on family.playback for delete to authenticated using (user_id = auth.uid());

grant select, delete on family.sources to authenticated;
grant insert (kind, feed_url, title, image_url, site_url) on family.sources to authenticated;
grant select on family.feed_items to authenticated;
grant select, delete on family.playback to authenticated;
grant insert (post_id, position_seconds, duration_seconds, finished, updated_at) on family.playback to authenticated;
-- post_id too: an upsert from the app rewrites every column it sends (moving your own row is harmless).
grant update (post_id, position_seconds, duration_seconds, finished, updated_at) on family.playback to authenticated;
grant all on family.sources, family.feed_items, family.playback to service_role;

-- ---------------------------------------------------------------------------------------------
-- Used by the feed poller (service role): file a new item under today's digest
-- ---------------------------------------------------------------------------------------------

create or replace function family.add_feed_item(
  p_source uuid, p_guid text, p_kind text, p_payload jsonb, p_post boolean, p_published timestamptz default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  day_    text := to_char(now() at time zone 'Europe/London', 'YYYY-MM-DD');
  digest_ uuid;
  post_   uuid;
begin
  if p_kind not in ('podcast_episode', 'video') then raise exception 'unknown feed item kind'; end if;
  if exists (select 1 from family.feed_items where source_id = p_source and guid = p_guid) then return null; end if;

  if p_post then
    select id into digest_ from family.posts where kind = 'digest' and payload ->> 'day' = day_;
    if digest_ is null then
      insert into family.posts (author_id, kind, body, payload)
      values (null, 'digest', '', jsonb_build_object('day', day_))
      on conflict do nothing
      returning id into digest_;
      if digest_ is null then
        select id into digest_ from family.posts where kind = 'digest' and payload ->> 'day' = day_;
      end if;
    end if;
    insert into family.posts (author_id, kind, body, payload, digest_id)
    values (null, p_kind, '', p_payload || jsonb_build_object('source_id', p_source, 'published_at', p_published), digest_)
    returning id into post_;
  end if;

  insert into family.feed_items (source_id, guid, post_id) values (p_source, p_guid, post_)
  on conflict (source_id, guid) do nothing;
  return post_;
end $$;

revoke all on function family.add_feed_item(uuid, text, text, jsonb, boolean, timestamptz) from public;
grant execute on function family.add_feed_item(uuid, text, text, jsonb, boolean, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Moving Family Feed's data across (run once; see supabase/import_family_feed.sql)
-- ---------------------------------------------------------------------------------------------

-- Staging tables you fill from a Family Feed export (CSV upload in the Table editor works).
create table if not exists family.ff_follows (
  kind     text not null check (kind in ('podcast', 'youtube')),
  feed_url text not null,
  title    text,
  email    text            -- who followed it in Family Feed (optional)
);
create table if not exists family.ff_likes (
  email        text not null,            -- the person's sign-in email
  kind         text not null check (kind in ('podcast', 'youtube', 'link')),
  item_url     text not null,            -- the episode, video or article
  title        text,
  feed_url     text,                     -- the show or channel it came from, if any
  audio_url    text,
  published_at timestamptz,
  liked        boolean not null default true   -- false = a dislike, which is dropped
);
alter table family.ff_follows enable row level security;   -- no policies: SQL editor / service role only
alter table family.ff_likes   enable row level security;

-- Follows become sources; likes become heart reactions on a post for the item (created if needed,
-- with no author and no digest, dated when it was published). Dislikes are dropped. Safe to re-run.
create or replace function family.import_family_feed() returns table (sources_added int, posts_added int, hearts_added int)
language plpgsql security definer set search_path = '' as $$
declare
  s int; p int; h int;
begin
  if auth.uid() is not null and not family.is_admin() then raise exception 'admins only'; end if;

  insert into family.sources (kind, feed_url, title, added_by)
  select distinct on (f.feed_url) f.kind, f.feed_url, coalesce(f.title, ''),
         (select pr.id from family.profiles pr join auth.users u on u.id = pr.id where lower(u.email) = lower(f.email))
  from family.ff_follows f
  where f.feed_url ~ '^https?://'
  on conflict (feed_url) do nothing;
  get diagnostics s = row_count;

  with liked as (
    select distinct on (l.item_url) l.*
    from family.ff_likes l where l.liked and l.item_url ~ '^https?://'
  )
  insert into family.posts (author_id, kind, body, payload, created_at)
  select null,
         case l.kind when 'podcast' then 'podcast_episode' when 'youtube' then 'video' else 'link' end,
         '',
         jsonb_strip_nulls(jsonb_build_object(
           'url', l.item_url, 'title', l.title, 'audio_url', l.audio_url, 'imported', true,
           'source_id', (select src.id from family.sources src where src.feed_url = l.feed_url),
           'source_title', (select src.title from family.sources src where src.feed_url = l.feed_url),
           'video_id', case when l.kind = 'youtube' then substring(l.item_url from '[?&]v=([A-Za-z0-9_-]{11})') end,
           'published_at', l.published_at)),
         coalesce(l.published_at, now())
  from liked l
  where not exists (select 1 from family.posts x where x.payload ->> 'url' = l.item_url);
  get diagnostics p = row_count;

  insert into family.reactions (post_id, user_id, emoji)
  select distinct x.id, pr.id, 'heart'
  from family.ff_likes l
  join auth.users u on lower(u.email) = lower(l.email)
  join family.profiles pr on pr.id = u.id
  join family.posts x on x.payload ->> 'url' = l.item_url
  where l.liked
  on conflict do nothing;
  get diagnostics h = row_count;

  return query select s, p, h;
end $$;
revoke all on function family.import_family_feed() from public;
grant execute on function family.import_family_feed() to authenticated;   -- checks for an admin itself

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['sources'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'family' and tablename = t) then
        execute format('alter publication supabase_realtime add table family.%I', t);
      end if;
    end loop;
  end if;
end $$;
