import { useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useMembers } from '../members.jsx';
import { editPost, removePost, setPinned } from '../data.js';
import { extractMentions } from '../lib/mentions.js';
import { ago, canEdit } from '../lib/time.js';
import { KIND_LABEL } from '../lib/timeline.js';
import { notifyChanged } from '../hooks.js';
import MentionTextarea from './MentionTextarea.jsx';
import Reactions from './Reactions.jsx';
import Thread, { PendingNote } from './Thread.jsx';
import { Body, Ico, Menu, Message, PersonAvatar } from './ui.jsx';
import { CalendarDays, Headphones, Images, MessageCircle, Newspaper, Pencil, Pin, PinOff, PlaySquare, Trash2 } from 'lucide-react';

const KIND_ICON = { photo_album: Images, podcast_episode: Headphones, video: PlaySquare, link: Newspaper, event: CalendarDays };
import { DigestBlock, EpisodeBlock, LinkPreview, SourceFace, VideoBlock } from './cards.jsx';
import { AlbumBlock } from './Photos.jsx';
import { EventBlock } from './Calendar.jsx';

// What goes between the header and the reactions, by kind of post.
function PostBody({ post }) {
  const p = post.payload || {};
  switch (post.kind) {
    case 'link': return <LinkPreview url={p.url} preview={p.preview} />;
    case 'video': return <VideoBlock payload={p} />;
    case 'podcast_episode': return <EpisodeBlock post={post} />;
    case 'digest': return <DigestBlock post={post} />;
    case 'photo_album': return <AlbumBlock post={post} />;
    case 'event': return <EventBlock post={post} />;
    default:
      return (
        <>
          {post.photos?.length > 0 && <AlbumBlock post={post} />}
          {p.link?.url && <LinkPreview url={p.link.url} preview={p.link.preview} />}
        </>
      );
  }
}

export default function PostCard({ post, highlight = false }) {
  const { profile } = useAuth();
  const { members } = useMembers();
  const comments = post.comments || [];
  const [open, setOpen] = useState(highlight || (comments.length > 0 && comments.length <= 3));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(post.body);
  const [error, setError] = useState('');

  const pending = Boolean(post._pending);
  const mine = post.author_id === profile.id;
  const admin = profile.role === 'admin';
  const replyCount = comments.length;
  const system = !post.author_id && !pending;
  const author = post.author || members.find((m) => m.id === post.author_id);
  const name = system
    ? (post.kind === 'digest' ? 'New from your shows' : post.payload?.source_title || 'From your shows')
    : author?.display_name || 'Someone';

  async function save() {
    const body = draft.trim();
    const hasLink = Boolean(post.payload?.link?.url || post.payload?.url);
    if (!body && !hasLink) return;
    const { error: err } = await editPost(post.id, { body, mentions: extractMentions(body, members) });
    if (err) return setError(err.message);
    setEditing(false); setError(''); notifyChanged();
    return undefined;
  }

  async function remove() {
    if (!window.confirm('Delete this post and its replies?')) return;
    const { error: err } = await removePost(post.id);
    if (err) return setError(err.message);
    notifyChanged();
    return undefined;
  }

  async function togglePin() {
    const { error: err } = await setPinned(post.id, !post.pinned);
    if (err) return setError(err.message);
    notifyChanged();
    return undefined;
  }

  const canChange = !pending && ((mine && canEdit(post.created_at)) || mine || admin);

  return (
    <article className={`post ${post.pinned ? 'pinned' : ''} ${pending ? 'pending' : ''}`} id={`p-${post.id}`}>
      <header className="post-head">
        {system ? <SourceFace post={post} /> : <PersonAvatar person={author} />}
        <div className="post-who">
          <strong>{name}</strong>
          <span className="when meta">
            {pending ? 'Sending…' : ago(post.created_at)}
            {post.edited_at ? ' · edited' : ''}
            {KIND_ICON[post.kind] && (
              <span className="kind-tag">· <Ico as={KIND_ICON[post.kind]} size={14} />{KIND_LABEL[post.kind]}</span>
            )}
          </span>
        </div>
        {post.pinned && <span className="badge brand"><Ico as={Pin} size={13} />Pinned</span>}
        {canChange && (
          <Menu>
            {mine && canEdit(post.created_at) && <button onClick={() => { setEditing(true); setDraft(post.body); }}><Ico as={Pencil} size={18} />Edit</button>}
            {admin && <button onClick={togglePin}><Ico as={post.pinned ? PinOff : Pin} size={18} />{post.pinned ? 'Unpin' : 'Pin to top'}</button>}
            {(mine || admin) && <button className="danger" onClick={remove}><Ico as={Trash2} size={18} />Delete</button>}
          </Menu>
        )}
      </header>

      {editing ? (
        <div className="edit">
          <MentionTextarea value={draft} onChange={setDraft} onSubmit={save} rows={3} label="Edit your post" autoFocus maxLength={5000} />
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            <button className="mini" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <Body text={post.body} />
      )}

      <PostBody post={post} />
      <Message tone="error">{error}</Message>

      {pending ? (
        <PendingNote id={post._outboxId} failed={post._failed} />
      ) : (
        <>
          <div className="post-actions">
            <Reactions rows={post.reactions} postId={post.id} />
            <button className="mini" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              <Ico as={MessageCircle} size={19} />{replyCount === 0 ? 'Reply' : open ? 'Hide replies' : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
            </button>
          </div>
          {open && <Thread post={post} />}
        </>
      )}
    </article>
  );
}
