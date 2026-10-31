import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useMembers } from '../members.jsx';
import { useOutbox } from '../outbox.jsx';
import { editComment, removeComment } from '../data.js';
import { extractMentions } from '../lib/mentions.js';
import { ago, canEdit } from '../lib/time.js';
import { uuid } from '../lib/uuid.js';
import { notifyChanged } from '../hooks.js';
import MentionTextarea from './MentionTextarea.jsx';
import Reactions from './Reactions.jsx';
import { Body, Message, PersonAvatar } from './ui.jsx';

const byTime = (a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);

function Comment({ comment, isReply, onReply }) {
  const { profile } = useAuth();
  const { members } = useMembers();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [error, setError] = useState('');
  const pending = comment._pending;
  const mine = comment.author_id === profile.id;
  const admin = profile.role === 'admin';

  async function save() {
    const body = draft.trim();
    if (!body) return;
    const { error: err } = await editComment(comment.id, { body, mentions: extractMentions(body, members) });
    if (err) return setError(err.message);
    setEditing(false); setError(''); notifyChanged();
    return undefined;
  }

  async function remove() {
    if (!window.confirm('Delete this reply?')) return;
    const { error: err } = await removeComment(comment.id);
    if (err) return setError(err.message);
    notifyChanged();
    return undefined;
  }

  return (
    <div className={`comment ${isReply ? 'reply' : ''} ${pending ? 'pending' : ''}`} id={`c-${comment.id}`}>
      <PersonAvatar person={comment.author || members.find((m) => m.id === comment.author_id)} size={isReply ? 30 : 36} />
      <div className="comment-main">
        <div className="comment-bubble">
          <p className="who">
            <strong>{(comment.author || {}).display_name || 'Someone'}</strong>
            <span className="when">{pending ? 'Sending…' : ago(comment.created_at)}{comment.edited_at ? ' · edited' : ''}{comment.photo_asset_id && !isReply ? ' · 📷 on a photo' : ''}</span>
          </p>
          {editing ? (
            <>
              <MentionTextarea value={draft} onChange={setDraft} onSubmit={save} rows={2} label="Edit your reply" autoFocus />
              <div className="row">
                <button className="mini" onClick={save}>Save</button>
                <button className="mini" onClick={() => { setEditing(false); setDraft(comment.body); }}>Cancel</button>
              </div>
            </>
          ) : <Body text={comment.body} />}
        </div>
        {!pending && !editing && (
          <div className="comment-actions">
            <Reactions rows={comment.reactions} commentId={comment.id} compact />
            {!isReply && <button className="linkish" onClick={() => onReply(comment)}>Reply</button>}
            {mine && canEdit(comment.created_at) && <button className="linkish" onClick={() => setEditing(true)}>Edit</button>}
            {(mine || admin) && <button className="linkish danger" onClick={remove}>Delete</button>}
          </div>
        )}
        {pending && comment._failed && <PendingNote id={comment._outboxId} failed={comment._failed} />}
        <Message tone="error">{error}</Message>
      </div>
    </div>
  );
}

export function PendingNote({ id, failed }) {
  const outbox = useOutbox();
  return (
    <p className="pending-note" role="status">
      {failed ? `Couldn’t send: ${failed}` : 'Waiting for a connection…'}{' '}
      {failed && <button className="linkish" onClick={() => outbox.retry(id)}>Try again</button>}{' '}
      <button className="linkish danger" onClick={() => outbox.discard(id)}>Discard</button>
    </p>
  );
}

export default function Thread({ post }) {
  const { profile } = useAuth();
  const { members } = useMembers();
  const outbox = useOutbox();
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [note, setNote] = useState('');
  const boxRef = useRef(null);

  const loadedIds = new Set((post.comments || []).map((c) => c.id));
  const queued = [...outbox.items, ...outbox.settled]
    .filter((i) => i.type === 'comment' && i.data.post_id === post.id && !loadedIds.has(i.id))
    .map((i) => ({
      ...i.data, author_id: profile.id, author: profile, created_at: new Date(i.queuedAt).toISOString(),
      reactions: [], _pending: true, _failed: i.failed, _outboxId: i.id,
    }));
  const all = [...(post.comments || []), ...queued];
  const top = all.filter((c) => !c.parent_id).sort(byTime);
  const repliesOf = (id) => all.filter((c) => c.parent_id === id).sort(byTime);

  useEffect(() => {
    if (replyTo) boxRef.current?.querySelector('textarea')?.focus();
  }, [replyTo]);

  function startReply(comment) {
    const name = comment.author?.display_name;
    setReplyTo({ id: comment.id, name });
    setText((t) => (t.trim() ? t : name ? `@${name} ` : ''));
  }

  async function send(e) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    const id = uuid();
    const res = await outbox.submit({
      id, type: 'comment',
      data: { id, post_id: post.id, parent_id: replyTo?.id ?? null, body, mentions: extractMentions(body, members) },
    });
    if (!res.ok) return setNote(res.error);
    setText(''); setReplyTo(null);
    setNote(res.queued ? 'You’re offline. Your reply will send when you’re back online.' : '');
    return undefined;
  }

  return (
    <div className="thread">
      {top.length > 0 && (
        <ul className="comments">
          {top.map((c) => (
            <li key={c.id} className="comment-group">
              <Comment comment={c} onReply={startReply} />
              {repliesOf(c.id).length > 0 && (
                <ul className="comments nested">
                  {repliesOf(c.id).map((r) => (
                    <li key={r.id}><Comment comment={r} isReply /></li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="reply-box" onSubmit={send} ref={boxRef}>
        {replyTo && (
          <p className="replying">
            Replying to {replyTo.name || 'a reply'}{' '}
            <button type="button" className="linkish" onClick={() => { setReplyTo(null); setText(''); }}>Cancel</button>
          </p>
        )}
        <MentionTextarea value={text} onChange={setText} onSubmit={send} rows={2} placeholder="Write a reply…" label="Write a reply" />
        <button className="primary" type="submit" disabled={!text.trim()}>Reply</button>
        <Message tone="">{note}</Message>
      </form>
    </div>
  );
}
