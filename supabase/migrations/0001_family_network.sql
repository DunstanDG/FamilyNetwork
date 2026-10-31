-- Family Network, phase 1: foundation.
--
-- Everything lives in its own schema (`family`) so it can share a Supabase project with HomeQuest
-- without touching its tables. Membership is decided by having a row in family.profiles, which can
-- only be created by redeeming an invite. Anyone else who signs in (a HomeQuest user, a stranger)
-- can sign in but sees nothing.
--
-- After running this, expose the schema: Project Settings -> API -> Exposed schemas -> add `family`.

create schema if not exists family;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table family.households (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(name) between 1 and 60),
  homequest_linked boolean not null default false,   -- used in phase 4
  created_at       timestamptz not null default now()
);

create table family.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  avatar_url   text,
  household_id uuid references family.households (id) on delete set null,
  role         text not null default 'adult' check (role in ('admin', 'adult', 'child')),
  -- Post kinds this person does not want push notifications for.
  muted_kinds  text[] not null default '{}',
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table family.posts (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null default auth.uid()
             constraint posts_author_id_fkey references family.profiles (id) on delete cascade,
  kind       text not null check (kind in ('update', 'photo_album', 'podcast_episode', 'video', 'link', 'event')),
  body       text not null default '' check (char_length(body) <= 5000),
  payload    jsonb not null default '{}'::jsonb,
  mentions   uuid[] not null default '{}',
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);
create index posts_created_idx on family.posts (created_at desc);
create index posts_kind_created_idx on family.posts (kind, created_at desc);

create table family.comments (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references family.posts (id) on delete cascade,
  parent_id      uuid references family.comments (id) on delete cascade,
  author_id      uuid not null default auth.uid()
                 constraint comments_author_id_fkey references family.profiles (id) on delete cascade,
  body           text not null check (char_length(body) between 1 and 2000),
  mentions       uuid[] not null default '{}',
  photo_asset_id uuid,                                  -- foreign key added with photo_assets in phase 3
  created_at     timestamptz not null default now(),
  edited_at      timestamptz
);
create index comments_post_idx on family.comments (post_id, created_at);

create table family.reactions (
  id         bigint generated always as identity primary key,
  post_id    uuid references family.posts (id) on delete cascade,
  comment_id uuid references family.comments (id) on delete cascade,
  user_id    uuid not null default auth.uid() references family.profiles (id) on delete cascade,
  emoji      text not null check (emoji in ('heart', 'laugh', 'wow', 'thumbs_up')),
  created_at timestamptz not null default now(),
  check (num_nonnulls(post_id, comment_id) = 1)
);
create unique index reactions_post_unique on family.reactions (post_id, user_id, emoji) where post_id is not null;
create unique index reactions_comment_unique on family.reactions (comment_id, user_id, emoji) where comment_id is not null;
create index reactions_comment_idx on family.reactions (comment_id) where comment_id is not null;

create table family.invites (
  code         text primary key default replace(gen_random_uuid()::text, '-', ''),
  created_by   uuid not null default auth.uid() references family.profiles (id) on delete cascade,
  role         text not null default 'adult' check (role in ('admin', 'adult', 'child')),
  household_id uuid references family.households (id) on delete set null,
  note         text check (char_length(note) <= 60),   -- who it is for, so the admin can tell them apart
  expires_at   timestamptz not null default now() + interval '7 days',
  used_by      uuid references family.profiles (id) on delete set null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);

create table family.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references family.profiles (id) on delete cascade,
  endpoint   text not null unique,
  keys       jsonb not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on family.push_subscriptions (user_id);

-- One row per thing the app should tell someone about. Rows are written by triggers; a database
-- webhook on insert calls the send-push Edge Function.
create table family.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references family.profiles (id) on delete cascade,
  actor_id   uuid references family.profiles (id) on delete set null,
  kind       text not null check (kind in ('mention', 'reply', 'album', 'vote', 'event')),
  module     text not null,                 -- the post kind, used to apply per-module muting
  post_id    uuid references family.posts (id) on delete cascade,
  comment_id uuid references family.comments (id) on delete cascade,
  snippet    text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user_idx on family.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Helpers used by policies
-- ---------------------------------------------------------------------------------------------

create function family.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from family.profiles where id = auth.uid());
$$;

create function family.my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from family.profiles where id = auth.uid();
$$;

create function family.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role = 'admin' from family.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards: rules that are awkward to express as policies
-- (auth.uid() is null for the service role and the SQL editor, which skip these.)
-- ---------------------------------------------------------------------------------------------

create function family.guard_post_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if new.author_id <> old.author_id or new.kind <> old.kind or new.created_at <> old.created_at then
    raise exception 'author, kind and date cannot be changed';
  end if;
  if new.pinned is distinct from old.pinned and not family.is_admin() then
    raise exception 'only an admin can pin posts';
  end if;
  if (new.body, new.payload, new.mentions) is distinct from (old.body, old.payload, old.mentions) then
    if old.author_id <> auth.uid() or now() - old.created_at > interval '15 minutes' then
      raise exception 'posts can only be edited by their author within 15 minutes';
    end if;
    new.edited_at := now();
  end if;
  return new;
end $$;
create trigger posts_guard_update before update on family.posts
  for each row execute function family.guard_post_update();

create function family.guard_comment_insert() returns trigger
language plpgsql set search_path = '' as $$
declare parent family.comments;
begin
  if new.parent_id is not null then
    select * into parent from family.comments where id = new.parent_id;
    if not found or parent.post_id <> new.post_id then
      raise exception 'reply must belong to the same post as its parent';
    end if;
    if parent.parent_id is not null then
      raise exception 'replies nest one level only';
    end if;
  end if;
  return new;
end $$;
create trigger comments_guard_insert before insert on family.comments
  for each row execute function family.guard_comment_insert();

create function family.guard_comment_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null then return new; end if;
  if new.post_id <> old.post_id or new.parent_id is distinct from old.parent_id
     or new.author_id <> old.author_id or new.created_at <> old.created_at then
    raise exception 'only the text of a reply can be changed';
  end if;
  if (new.body, new.mentions) is distinct from (old.body, old.mentions) then
    if now() - old.created_at > interval '15 minutes' then
      raise exception 'replies can only be edited within 15 minutes';
    end if;
    new.edited_at := now();
  end if;
  return new;
end $$;
create trigger comments_guard_update before update on family.comments
  for each row execute function family.guard_comment_update();

-- ---------------------------------------------------------------------------------------------
-- Notifications: mentions and replies
-- ---------------------------------------------------------------------------------------------

create function family.notify_on_post() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into family.notifications (user_id, actor_id, kind, module, post_id, snippet)
  select p.id, new.author_id, 'mention', new.kind, new.id, left(new.body, 140)
  from family.profiles p
  where p.id = any (new.mentions) and p.id <> new.author_id;
  return new;
end $$;
create trigger posts_notify after insert on family.posts
  for each row execute function family.notify_on_post();

create function family.notify_on_comment() returns trigger
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

  if post_author <> new.author_id and not (post_author = any (new.mentions)) then
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
create trigger comments_notify after insert on family.comments
  for each row execute function family.notify_on_comment();

-- ---------------------------------------------------------------------------------------------
-- Functions the app calls
-- ---------------------------------------------------------------------------------------------

-- Lets the invite page say "you've been invited" before anyone has signed in. Reveals nothing else.
create function family.peek_invite(p_code text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from family.invites
    where code = p_code and used_by is null and expires_at > now()
  );
$$;

-- Turns a signed-in Google/email user into a family member. Idempotent for existing members.
create function family.redeem_invite(p_code text, p_display_name text) returns family.profiles
language plpgsql security definer set search_path = '' as $$
declare
  inv    family.invites;
  prof   family.profiles;
  name_  text := left(trim(coalesce(p_display_name, '')), 40);
  avatar text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;

  select * into prof from family.profiles where id = auth.uid();
  if found then return prof; end if;

  if name_ = '' then raise exception 'please enter your name'; end if;

  select * into inv from family.invites where code = p_code for update;
  if not found or inv.used_by is not null or inv.expires_at <= now() then
    raise exception 'this invite is no longer valid';
  end if;

  select raw_user_meta_data ->> 'avatar_url' into avatar from auth.users where id = auth.uid();

  insert into family.profiles (id, display_name, avatar_url, household_id, role)
  values (auth.uid(), name_, avatar, inv.household_id, inv.role)
  returning * into prof;

  update family.invites set used_by = auth.uid(), used_at = now() where code = p_code;
  return prof;
end $$;

create function family.admin_update_member(p_user uuid, p_role text, p_household uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare current_role_ text;
begin
  if not family.is_admin() then raise exception 'admins only'; end if;
  if p_role not in ('admin', 'adult', 'child') then raise exception 'unknown role'; end if;
  select role into current_role_ from family.profiles where id = p_user;
  if not found then raise exception 'no such member'; end if;
  if current_role_ = 'admin' and p_role <> 'admin'
     and not exists (select 1 from family.profiles where role = 'admin' and id <> p_user) then
    raise exception 'there must always be one admin';
  end if;
  update family.profiles set role = p_role, household_id = p_household where id = p_user;
end $$;

-- Removes someone from the family circle (and everything they posted). Their sign-in account is
-- left alone because it may be shared with other apps in the same project.
create function family.admin_remove_member(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare current_role_ text;
begin
  if not family.is_admin() then raise exception 'admins only'; end if;
  select role into current_role_ from family.profiles where id = p_user;
  if not found then return; end if;
  if current_role_ = 'admin'
     and not exists (select 1 from family.profiles where role = 'admin' and id <> p_user) then
    raise exception 'there must always be one admin';
  end if;
  delete from family.profiles where id = p_user;
end $$;

-- Registers this device for push. If the same browser was used by someone else before, it moves
-- to the current person so nobody receives another person's notifications.
create function family.register_push(p_endpoint text, p_keys jsonb, p_user_agent text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not family.is_member() then raise exception 'not a member'; end if;
  insert into family.push_subscriptions (user_id, endpoint, keys, user_agent)
  values (auth.uid(), p_endpoint, p_keys, left(p_user_agent, 200))
  on conflict (endpoint) do update
    set user_id = auth.uid(), keys = excluded.keys, user_agent = excluded.user_agent;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------

alter table family.households         enable row level security;
alter table family.profiles           enable row level security;
alter table family.posts              enable row level security;
alter table family.comments           enable row level security;
alter table family.reactions          enable row level security;
alter table family.invites            enable row level security;
alter table family.push_subscriptions enable row level security;
alter table family.notifications      enable row level security;

create policy households_select on family.households for select to authenticated
  using (family.is_member());
create policy households_admin_write on family.households for all to authenticated
  using (family.is_admin()) with check (family.is_admin());

create policy profiles_select on family.profiles for select to authenticated
  using (family.is_member());
create policy profiles_update_self on family.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- No insert or delete policy: profiles are created by redeem_invite and removed by admin_remove_member.

create policy posts_select on family.posts for select to authenticated
  using (family.is_member());
create policy posts_insert on family.posts for insert to authenticated
  with check (family.is_member() and author_id = auth.uid() and kind = 'update' and not pinned);
create policy posts_update on family.posts for update to authenticated
  using (author_id = auth.uid() or family.is_admin())
  with check (author_id = auth.uid() or family.is_admin());
create policy posts_delete on family.posts for delete to authenticated
  using (author_id = auth.uid() or family.is_admin());

create policy comments_select on family.comments for select to authenticated
  using (family.is_member());
create policy comments_insert on family.comments for insert to authenticated
  with check (family.is_member() and author_id = auth.uid());
create policy comments_update on family.comments for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy comments_delete on family.comments for delete to authenticated
  using (author_id = auth.uid() or family.is_admin());

create policy reactions_select on family.reactions for select to authenticated
  using (family.is_member());
create policy reactions_insert on family.reactions for insert to authenticated
  with check (family.is_member() and user_id = auth.uid());
create policy reactions_delete on family.reactions for delete to authenticated
  using (user_id = auth.uid());

-- Adults and admins can invite; children cannot. Only an admin can mint an admin invite.
create policy invites_select on family.invites for select to authenticated
  using (created_by = auth.uid() or family.is_admin());
create policy invites_insert on family.invites for insert to authenticated
  with check (
    created_by = auth.uid()
    and family.my_role() in ('admin', 'adult')
    and (role <> 'admin' or family.is_admin())
    and used_by is null and used_at is null
    and expires_at <= now() + interval '7 days'
  );
create policy invites_delete on family.invites for delete to authenticated
  using (created_by = auth.uid() or family.is_admin());

create policy push_select on family.push_subscriptions for select to authenticated
  using (user_id = auth.uid());
create policy push_delete on family.push_subscriptions for delete to authenticated
  using (user_id = auth.uid());

create policy notifications_select on family.notifications for select to authenticated
  using (user_id = auth.uid());
create policy notifications_update on family.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------------------------
-- Privileges (least privilege on top of RLS)
-- ---------------------------------------------------------------------------------------------

grant usage on schema family to anon, authenticated, service_role;
grant all on all tables in schema family to service_role;
alter default privileges in schema family grant all on tables to service_role;

grant select, insert, update, delete on family.households to authenticated;
grant select on family.profiles to authenticated;
grant update (display_name, avatar_url, muted_kinds, last_seen_at) on family.profiles to authenticated;
grant select, delete on family.posts to authenticated;
grant insert (id, kind, body, payload, mentions) on family.posts to authenticated;
grant update (body, payload, mentions, pinned) on family.posts to authenticated;
grant select, delete on family.comments to authenticated;
grant insert (id, post_id, parent_id, body, mentions) on family.comments to authenticated;
grant update (body, mentions) on family.comments to authenticated;
grant select, delete on family.reactions to authenticated;
grant insert (post_id, comment_id, emoji) on family.reactions to authenticated;
grant select, delete on family.invites to authenticated;
grant insert (role, household_id, note) on family.invites to authenticated;
grant select, delete on family.push_subscriptions to authenticated;
grant select on family.notifications to authenticated;
grant update (read_at) on family.notifications to authenticated;

revoke all on function
  family.is_member(), family.my_role(), family.is_admin(),
  family.peek_invite(text), family.redeem_invite(text, text),
  family.admin_update_member(uuid, text, uuid), family.admin_remove_member(uuid),
  family.register_push(text, jsonb, text)
from public;

grant execute on function family.is_member(), family.my_role(), family.is_admin() to authenticated;
grant execute on function family.peek_invite(text) to anon, authenticated;
grant execute on function
  family.redeem_invite(text, text),
  family.admin_update_member(uuid, text, uuid), family.admin_remove_member(uuid),
  family.register_push(text, jsonb, text)
to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Live updates
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime
      add table family.posts, family.comments, family.reactions, family.notifications;
  end if;
end $$;
