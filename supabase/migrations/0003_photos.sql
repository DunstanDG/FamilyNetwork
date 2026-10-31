-- Family Network, phase 3: photos.
--
-- Image bytes never touch this database or any third-party cloud: they live in Immich on the home
-- server, reached only through the photo gateway (gateway/), which checks the person's session on
-- every request. This database only records which Immich asset belongs to which post.

alter table family.posts drop constraint posts_kind_check;
alter table family.posts add constraint posts_kind_check
  check (kind in ('update', 'photo_album', 'podcast_episode', 'video', 'link', 'event', 'digest'));

drop policy posts_insert on family.posts;
create policy posts_insert on family.posts for insert to authenticated
  with check (
    family.is_member() and author_id = auth.uid() and not pinned
    and kind in ('update', 'link', 'video', 'podcast_episode', 'photo_album')
  );

create table family.photo_assets (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null references family.posts (id) on delete cascade,
  immich_asset_id text not null,
  uploaded_by     uuid references family.profiles (id) on delete cascade,
  width           int check (width is null or width > 0),
  height          int check (height is null or height > 0),
  taken_at        timestamptz,
  position        int not null default 0,
  created_at      timestamptz not null default now()
);
create index photo_assets_post_idx on family.photo_assets (post_id, position);
create index photo_assets_immich_idx on family.photo_assets (immich_asset_id);
create index photo_assets_uploader_idx on family.photo_assets (uploaded_by);

alter table family.comments
  add constraint comments_photo_asset_id_fkey foreign key (photo_asset_id) references family.photo_assets (id) on delete cascade;

-- Immich assets to move to Immich's bin once nothing here points at them. The gateway empties this.
create table family.photo_deletions (
  immich_asset_id text primary key,
  queued_at       timestamptz not null default now()
);

create function family.queue_photo_deletion() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from family.photo_assets where immich_asset_id = old.immich_asset_id) then
    insert into family.photo_deletions (immich_asset_id) values (old.immich_asset_id) on conflict do nothing;
  end if;
  return old;
end $$;
create trigger photo_assets_queue_deletion after delete on family.photo_assets
  for each row execute function family.queue_photo_deletion();

-- A comment on one photo must be on that photo's post.
create or replace function family.guard_comment_insert() returns trigger
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
    if new.photo_asset_id is null then new.photo_asset_id := parent.photo_asset_id; end if;
  end if;
  if new.photo_asset_id is not null
     and not exists (select 1 from family.photo_assets where id = new.photo_asset_id and post_id = new.post_id) then
    raise exception 'that photo is not part of this post';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Rules the gateway asks the database about (service role), so they live in one tested place
-- ---------------------------------------------------------------------------------------------

-- May this person add a photo to this post? Their own album (any number), or their own update (one).
create function family.photo_upload_allowed(p_post uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from family.posts p
    join family.profiles pr on pr.id = p_user
    where p.id = p_post and p.author_id = p_user
      and (p.kind = 'photo_album'
           or (p.kind = 'update' and not exists (select 1 from family.photo_assets a where a.post_id = p.id)))
  );
$$;

create function family.record_photo(
  p_post uuid, p_user uuid, p_immich text, p_width int, p_height int, p_taken timestamptz, p_position int
) returns family.photo_assets
language plpgsql security definer set search_path = '' as $$
declare row_ family.photo_assets;
begin
  -- Serialise uploads to the same post so the one-photo rule for updates can't be raced.
  perform 1 from family.posts where id = p_post for update;
  if not family.photo_upload_allowed(p_post, p_user) then raise exception 'not allowed to add photos to this post'; end if;
  insert into family.photo_assets (post_id, immich_asset_id, uploaded_by, width, height, taken_at, position)
  values (p_post, p_immich, p_user, p_width, p_height, p_taken, coalesce(p_position, 0))
  returning * into row_;
  return row_;
end $$;

-- The album is uploaded: tell everyone else, once.
create function family.publish_album(p_post uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare p family.posts;
begin
  select * into p from family.posts where id = p_post;
  if not found or p.author_id is distinct from auth.uid() or p.kind <> 'photo_album' then
    raise exception 'only the person who made the album can publish it';
  end if;
  if exists (select 1 from family.notifications where post_id = p_post and kind = 'album') then return; end if;
  if not exists (select 1 from family.photo_assets where post_id = p_post) then return; end if;
  insert into family.notifications (user_id, actor_id, kind, module, post_id, snippet)
  select pr.id, p.author_id, 'album', 'photo_album', p.id,
         left(coalesce(nullif(p.payload ->> 'title', ''), nullif(p.body, ''), 'New photos'), 140)
  from family.profiles pr where pr.id <> p.author_id;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------------------------

alter table family.photo_assets    enable row level security;
alter table family.photo_deletions enable row level security;

create policy photo_assets_select on family.photo_assets for select to authenticated using (family.is_member());
-- Removing a photo: whoever uploaded it, or an admin. (Adding one only happens through the gateway.)
create policy photo_assets_delete on family.photo_assets for delete to authenticated
  using (uploaded_by = auth.uid() or family.is_admin());

grant select, delete on family.photo_assets to authenticated;
grant insert (id, post_id, parent_id, body, mentions, photo_asset_id) on family.comments to authenticated;
grant all on family.photo_assets, family.photo_deletions to service_role;

revoke all on function
  family.photo_upload_allowed(uuid, uuid),
  family.record_photo(uuid, uuid, text, int, int, timestamptz, int),
  family.publish_album(uuid)
from public;
grant execute on function
  family.photo_upload_allowed(uuid, uuid),
  family.record_photo(uuid, uuid, text, int, int, timestamptz, int)
to service_role;
grant execute on function family.publish_album(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table family.photo_assets;
  end if;
end $$;
