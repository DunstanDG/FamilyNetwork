// All database calls in one place. Components never talk to Supabase directly.
import { supabase } from './supabase.js';

const WHO = 'id, display_name, avatar_url';

export const POST_SELECT = `
  id, author_id, kind, body, payload, mentions, pinned, created_at, edited_at,
  author:profiles!author_id(${WHO}),
  reactions(id, emoji, user_id),
  comments(
    id, post_id, parent_id, author_id, body, mentions, created_at, edited_at,
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

export function fetchPosts({ kind, before, limit = PAGE_SIZE }) {
  let q = supabase.from('posts').select(POST_SELECT).eq('pinned', false)
    .order('created_at', { ascending: false }).limit(limit);
  if (kind) q = q.eq('kind', kind);
  if (before) q = q.lt('created_at', before);
  return q;
}

export function fetchPinned({ kind }) {
  let q = supabase.from('posts').select(POST_SELECT).eq('pinned', true).order('created_at', { ascending: false });
  if (kind) q = q.eq('kind', kind);
  return q;
}

export const fetchPost = (id) => supabase.from('posts').select(POST_SELECT).eq('id', id).maybeSingle();
export const insertPost = (row) => supabase.from('posts').insert(row);
export const insertComment = (row) => supabase.from('comments').insert(row);

export const sendQueued = (entry) => (entry.type === 'post' ? insertPost(entry.data) : insertComment(entry.data));

export const editPost = async (id, patch) => mustAffect(await supabase.from('posts').update(patch).eq('id', id).select('id'), 'edit');
export const setPinned = async (id, pinned) => mustAffect(await supabase.from('posts').update({ pinned }).eq('id', id).select('id'), 'pin');
export const removePost = async (id) => mustAffect(await supabase.from('posts').delete().eq('id', id).select('id'), 'delete');
export const editComment = async (id, patch) => mustAffect(await supabase.from('comments').update(patch).eq('id', id).select('id'), 'edit');
export const removeComment = async (id) => mustAffect(await supabase.from('comments').delete().eq('id', id).select('id'), 'delete');

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
export const fetchHouseholds = () => supabase.from('households').select('id, name').order('name');
export const createHousehold = (name) => supabase.from('households').insert({ name });
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
