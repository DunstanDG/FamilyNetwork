// All database calls in one place. Components never talk to Supabase directly.
import { supabase } from './supabase.js';

const WHO = 'id, display_name, avatar_url';

export const POST_SELECT = `
  id, author_id, kind, body, payload, mentions, pinned, created_at, edited_at, digest_id,
  author:profiles!author_id(${WHO}),
  playback(position_seconds, duration_seconds, finished, updated_at),
  photos:photo_assets(id, width, height, taken_at, position, uploaded_by),
  event:events(
    post_id, title, deadline, status, chosen_option_id, chosen_place_id, confirmed_at,
    options:event_options!event_options_event_id_fkey(id, kind, starts_at, ends_at, place_name, place_url, position, votes:event_votes(user_id, answer, rank)),
    rsvps:event_rsvps(user_id, answer, add_to_homequest)
  ),
  reactions(id, emoji, user_id),
  comments(
    id, post_id, parent_id, author_id, body, mentions, photo_asset_id, created_at, edited_at,
    author:profiles!author_id(${WHO}),
    reactions(id, emoji, user_id)
  )`;

// RLS silently filters rows you may not touch, so a "successful" update can change nothing.
const mustAffect = (res, verb) =>
  !res.error && Array.isArray(res.data) && res.data.length === 0
    ? { ...res, error: { message: `You can't ${verb} this any more.` } }
    : res;

// ---- posts -------------------------------------------------------------------------------------
export const PAGE_SIZE = 20;

// Home (no kind) leaves out auto-posted episodes and videos: they appear once a day inside their
// digest card instead. A module tab (a kind) lists every one of them.
export async function fetchPosts({ kind, before, limit = PAGE_SIZE }) {
  let q = supabase.from('posts').select(POST_SELECT).eq('pinned', false)
    .order('created_at', { ascending: false }).limit(limit);
  q = kind ? q.eq('kind', kind) : q.is('digest_id', null);
  if (before) q = q.lt('created_at', before);
  return withDigestItems(await q);
}

export async function fetchPinned({ kind }) {
  let q = supabase.from('posts').select(POST_SELECT).eq('pinned', true).order('created_at', { ascending: false });
  if (kind) q = q.eq('kind', kind);
  return withDigestItems(await q);
}

export const fetchPost = async (id) => withDigestItems(await supabase.from('posts').select(POST_SELECT).eq('id', id).maybeSingle());

const DIGEST_ITEM = 'id, kind, payload, created_at, digest_id, playback(position_seconds, duration_seconds, finished, updated_at), comments(id), reactions(id)';

// Fill each digest card with the episodes and videos filed under it.
async function withDigestItems(res) {
  if (res.error || !res.data) return res;
  const list = Array.isArray(res.data) ? res.data : [res.data];
  const ids = list.filter((p) => p.kind === 'digest').map((p) => p.id);
  if (!ids.length) return res;
  const { data, error } = await supabase.from('posts').select(DIGEST_ITEM).in('digest_id', ids).order('created_at');
  if (error) return { ...res, error };
  const filled = list.map((p) => (p.kind === 'digest' ? { ...p, items: data.filter((d) => d.digest_id === p.id) } : p));
  return { ...res, data: Array.isArray(res.data) ? filled : filled[0] };
}
export const insertPost = (row) => supabase.from('posts').insert(row);
export const insertComment = (row) => supabase.from('comments').insert(row);

export const sendQueued = (entry) => (entry.type === 'post' ? insertPost(entry.data) : insertComment(entry.data));

export const editPost = async (id, patch) => mustAffect(await supabase.from('posts').update(patch).eq('id', id).select('id'), 'edit');
export const setPinned = async (id, pinned) => mustAffect(await supabase.from('posts').update({ pinned }).eq('id', id).select('id'), 'pin');
export const removePost = async (id) => mustAffect(await supabase.from('posts').delete().eq('id', id).select('id'), 'delete');
export const editComment = async (id, patch) => mustAffect(await supabase.from('comments').update(patch).eq('id', id).select('id'), 'edit');
export const removeComment = async (id) => mustAffect(await supabase.from('comments').delete().eq('id', id).select('id'), 'delete');

// ---- feeds: followed shows and channels, previews, resume positions ------------------------------
export const fetchSources = (kind) =>
  supabase.from('sources').select('id, kind, feed_url, title, image_url, site_url, added_by, last_polled_at, failures, last_error, created_at')
    .eq('kind', kind).order('title');
export const followSource = (row) => supabase.from('sources').insert(row);
export const unfollowSource = async (id) => mustAffect(await supabase.from('sources').delete().eq('id', id).select('id'), 'unfollow');

// Calls the `lookup` Edge Function. Resolves to { data } or { error: { message } }.
export async function lookup(body) {
  try {
    const { data, error } = await supabase.functions.invoke('lookup', { body });
    if (error) {
      let message = error.message;
      try { message = (await error.context?.json())?.error || message; } catch { /* keep the generic one */ }
      return { error: { message } };
    }
    if (data?.error) return { error: { message: data.error } };
    return { data };
  } catch (e) {
    return { error: { message: e.message } };
  }
}

export const savePlayback = ({ postId, position, duration, finished }) =>
  supabase.from('playback').upsert({
    post_id: postId, position_seconds: Math.max(0, Math.round(position)), duration_seconds: duration ? Math.round(duration) : null,
    finished: Boolean(finished), updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,post_id' });

// ---- photos (the bytes go to the gateway; see photos.js) ---------------------------------------
// Posts with photos are written straight away rather than through the outbox: the photos need a
// connection anyway, and the post must exist before they can be attached to it.
export const createPhotoPost = (row) => supabase.from('posts').insert(row).select('id').single();
export const publishAlbum = (postId) => supabase.rpc('publish_album', { p_post: postId });
export const removePhoto = async (id) => mustAffect(await supabase.from('photo_assets').delete().eq('id', id).select('id'), 'remove');

// ---- calendar ----------------------------------------------------------------------------------
export const proposeEvent = ({ id, title, body, deadline, slots, places }) =>
  supabase.rpc('propose_event', { p_id: id, p_title: title, p_body: body, p_deadline: deadline, p_slots: slots, p_places: places });
export const castVotes = (eventId, votes) => supabase.rpc('cast_votes', { p_event: eventId, p_votes: votes });
export const confirmEvent = (eventId, slotId, placeId) => supabase.rpc('confirm_event', { p_event: eventId, p_slot: slotId, p_place: placeId });
export const cancelEvent = (eventId) => supabase.rpc('cancel_event', { p_event: eventId });
export const rsvp = ({ eventId, answer, addToHomequest = false, forUser = null }) =>
  supabase.rpc('rsvp', { p_event: eventId, p_answer: answer, p_add_to_homequest: addToHomequest, p_for: forUser });
export const householdBusy = (from, to) => supabase.rpc('household_busy', { p_from: from, p_to: to });

// Confirmed events still to come, soonest first.
export async function fetchUpcoming() {
  const res = await supabase.from('events')
    .select('post_id, title, chosen:event_options!events_chosen_option_fkey!inner(starts_at, ends_at), place:event_options!events_chosen_place_fkey(place_name)')
    .eq('status', 'confirmed').gt('chosen.starts_at', new Date().toISOString());
  if (res.error) return res;
  const one = (x) => (Array.isArray(x) ? x[0] : x);
  const data = res.data.map((e) => ({ ...e, chosen: one(e.chosen), place: one(e.place) }))
    .sort((a, b) => (a.chosen.starts_at < b.chosen.starts_at ? -1 : 1));
  return { data };
}

// ---- reactions ---------------------------------------------------------------------------------
export const addReaction = ({ postId, commentId, emoji }) =>
  supabase.from('reactions').insert({ post_id: postId ?? null, comment_id: commentId ?? null, emoji });

export function removeReaction({ postId, commentId, emoji, userId }) {
  const q = supabase.from('reactions').delete().eq('user_id', userId).eq('emoji', emoji);
  return postId ? q.eq('post_id', postId) : q.eq('comment_id', commentId);
}

// ---- people ------------------------------------------------------------------------------------
export const fetchMembers = () =>
  supabase.from('profiles').select('id, display_name, avatar_url, role, household_id').order('display_name');
export const fetchHouseholds = () => supabase.from('households').select('id, name, homequest_linked').order('name');
export const createHousehold = (name) => supabase.from('households').insert({ name });
export const linkHomequest = (id, linked) => supabase.from('households').update({ homequest_linked: linked }).eq('id', id);
export const updateMember = (id, role, householdId) =>
  supabase.rpc('admin_update_member', { p_user: id, p_role: role, p_household: householdId || null });
export const removeMember = (id) => supabase.rpc('admin_remove_member', { p_user: id });

export const fetchProfile = (id) => supabase.from('profiles').select('*').eq('id', id).maybeSingle();
export const updateProfile = (id, patch) => supabase.from('profiles').update(patch).eq('id', id).select('*').single();
export const touchLastSeen = (id, iso) => supabase.from('profiles').update({ last_seen_at: iso }).eq('id', id);

// ---- invites -----------------------------------------------------------------------------------
export const peekInvite = (code) => supabase.rpc('peek_invite', { p_code: code });
export const redeemInvite = (code, name) => supabase.rpc('redeem_invite', { p_code: code, p_display_name: name });
export const createInvite = ({ role, householdId, note }) =>
  supabase.from('invites').insert({ role, household_id: householdId || null, note: note || null }).select('*').single();
export const fetchInvites = () =>
  supabase.from('invites').select('code, role, household_id, note, expires_at, used_by, used_at, created_at')
    .order('created_at', { ascending: false }).limit(30);
export const deleteInvite = (code) => supabase.from('invites').delete().eq('code', code);

// ---- notifications -----------------------------------------------------------------------------
export const fetchNotifications = () =>
  supabase.from('notifications')
    .select(`id, kind, module, post_id, comment_id, snippet, created_at, read_at, actor:profiles!actor_id(${WHO})`)
    .order('created_at', { ascending: false }).limit(30);
export const countUnread = () =>
  supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
export const markAllRead = () =>
  supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null);
