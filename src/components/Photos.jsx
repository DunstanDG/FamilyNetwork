import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useMembers } from '../members.jsx';
import { useOutbox } from '../outbox.jsx';
import { createPhotoPost, publishAlbum, removePhoto } from '../data.js';
import { checkFile, downloadOriginal, photosConfigured, uploadAll, usePhotoUrl } from '../photos.js';
import { extractMentions } from '../lib/mentions.js';
import { ago } from '../lib/time.js';
import { uuid } from '../lib/uuid.js';
import { notifyChanged } from '../hooks.js';
import MentionTextarea from './MentionTextarea.jsx';
import { Body, Message, PersonAvatar, Sheet } from './ui.jsx';

const byPosition = (a, b) => (a.position - b.position) || (a.id < b.id ? -1 : 1);
export const sortedPhotos = (post) => [...(post.photos || [])].sort(byPosition);

export function PhotoImg({ id, size = 'thumbnail', alt = '', className = '', style }) {
  const { url, error } = usePhotoUrl(id, size);
  if (error) return <span className={`photo-missing ${className}`} style={style} title={error}>📷</span>;
  if (!url) return <span className={`photo-loading ${className}`} style={style} aria-hidden="true" />;
  return <img src={url} alt={alt} className={className} style={style} draggable={false} />;
}

// An album (or the single photo on an update) as a tidy grid; tap to open the viewer.
export function AlbumBlock({ post }) {
  const photos = sortedPhotos(post);
  const [open, setOpen] = useState(null);
  const title = post.payload?.title;
  if (!photosConfigured) return <p className="hint">Photos are not set up on this copy of the app yet.</p>;
  if (!photos.length) {
    return post.kind === 'photo_album' ? <p className="hint">{title ? `${title}: ` : ''}photos on their way…</p> : null;
  }
  const shown = photos.slice(0, photos.length === 4 ? 4 : 5);
  const more = photos.length - shown.length;
  return (
    <div className="album">
      {title && <p className="album-title">{title} <span className="when">· {photos.length} photo{photos.length === 1 ? '' : 's'}</span></p>}
      <div className={`album-grid n${Math.min(shown.length, 5)}`}>
        {shown.map((ph, i) => (
          <button key={ph.id} className="album-cell" onClick={() => setOpen(i)} aria-label={`Open photo ${i + 1} of ${photos.length}`}>
            <PhotoImg id={ph.id} size={shown.length === 1 ? 'preview' : 'thumbnail'} />
            {i === shown.length - 1 && more > 0 && <span className="album-more">+{more}</span>}
          </button>
        ))}
      </div>
      {open !== null && <PhotoViewer post={post} start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

// Full screen, one photo at a time: swipe or arrow keys, download the original, talk about this photo.
export function PhotoViewer({ post, start = 0, onClose }) {
  const { profile } = useAuth();
  const { members, byId } = useMembers();
  const outbox = useOutbox();
  const photos = sortedPhotos(post);
  const [i, setI] = useState(Math.min(start, photos.length - 1));
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const touch = useRef(null);
  const ref = useRef(null);
  const photo = photos[i];

  const go = useCallback((d) => setI((n) => Math.max(0, Math.min(photos.length - 1, n + d))), [photos.length]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [go, onClose]);

  const comments = useMemo(() => {
    const loaded = (post.comments || []).filter((c) => c.photo_asset_id === photo?.id);
    const ids = new Set(loaded.map((c) => c.id));
    const queued = [...outbox.items, ...outbox.settled]
      .filter((q) => q.type === 'comment' && q.data.photo_asset_id === photo?.id && !ids.has(q.id))
      .map((q) => ({ ...q.data, author_id: profile.id, created_at: new Date(q.queuedAt).toISOString(), _pending: true }));
    return [...loaded, ...queued].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  }, [post.comments, photo?.id, outbox.items, outbox.settled, profile.id]);

  if (!photo) return null;

  async function send(e) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    const id = uuid();
    const res = await outbox.submit({ id, type: 'comment', data: { id, post_id: post.id, parent_id: null, body, mentions: extractMentions(body, members), photo_asset_id: photo.id } });
    if (!res.ok) { setNote(res.error); return; }
    setText(''); setNote(res.queued ? 'You’re offline. It will send when you’re back.' : '');
  }

  async function download() {
    setBusy(true); setNote('');
    try { await downloadOriginal(photo.id); } catch (err) { setNote(err.message); }
    setBusy(false);
  }

  async function remove() {
    if (!window.confirm('Remove this photo for everyone?')) return;
    const { error } = await removePhoto(photo.id);
    if (error) { setNote(error.message); return; }
    notifyChanged();
    if (photos.length === 1) onClose(); else setI((n) => Math.max(0, n - (n === photos.length - 1 ? 1 : 0)));
  }

  const canRemove = photo.uploaded_by === profile.id || profile.role === 'admin';

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Photo ${i + 1} of ${photos.length}`} ref={ref} tabIndex={-1}>
      <div className="viewer-top">
        <span>{i + 1} / {photos.length}</span>
        <div className="row">
          <button className="viewer-btn" onClick={download} disabled={busy} aria-label="Download the original">⤓</button>
          {canRemove && <button className="viewer-btn" onClick={remove} aria-label="Remove this photo">🗑</button>}
          <button className="viewer-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </div>
      <div
        className="viewer-stage"
        onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          if (touch.current === null) return;
          const dx = e.changedTouches[0].clientX - touch.current;
          touch.current = null;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        }}
      >
        {i > 0 && <button className="viewer-nav prev" onClick={() => go(-1)} aria-label="Previous photo">‹</button>}
        <PhotoImg key={photo.id} id={photo.id} size="preview" className="viewer-img" alt={`Photo ${i + 1}`} />
        {i < photos.length - 1 && <button className="viewer-nav next" onClick={() => go(1)} aria-label="Next photo">›</button>}
      </div>
      <div className="viewer-talk">
        {photo.taken_at && <p className="when">{new Date(photo.taken_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>}
        <ul className="plain viewer-comments">
          {comments.map((c) => {
            const who = c.author || byId.get(c.author_id);
            return (
              <li key={c.id} className="viewer-comment">
                <PersonAvatar person={who} size={28} />
                <span><strong>{who?.display_name || 'Someone'}</strong> <Body text={c.body} /> <small className="when">{c._pending ? 'Sending…' : ago(c.created_at)}</small></span>
              </li>
            );
          })}
        </ul>
        <form className="row" onSubmit={send}>
          <MentionTextarea value={text} onChange={setText} onSubmit={send} rows={1} placeholder="Say something about this photo…" label="Comment on this photo" />
          <button className="primary" disabled={!text.trim()}>Send</button>
        </form>
        <Message tone="error">{note}</Message>
      </div>
    </div>
  );
}

// Choosing photos: shows small previews and turns away files we can't clean of location data.
export function PhotoPicker({ files, onChange, multiple = true, label = 'Choose photos' }) {
  const [problems, setProblems] = useState([]);
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  function pick(e) {
    const chosen = [...e.target.files];
    e.target.value = '';
    const bad = [];
    const good = chosen.filter((f) => { const p = checkFile(f); if (p) bad.push(`${f.name}: ${p}`); return !p; });
    setProblems(bad);
    onChange(multiple ? [...files, ...good].slice(0, 100) : good.slice(0, 1));
  }

  return (
    <div className="picker">
      {files.length > 0 && (
        <ul className="plain picker-grid">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.lastModified}-${i}`}>
              <img src={urls[i]} alt="" />
              <button type="button" className="picker-x" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <label className="mini file-label">
        📷 {files.length && multiple ? 'Add more' : label}
        <input type="file" accept="image/jpeg,image/png,image/webp,image/*" multiple={multiple} onChange={pick} hidden />
      </label>
      {problems.map((p) => <p key={p} className="msg error">{p}</p>)}
    </div>
  );
}

export function UploadProgress({ progress }) {
  if (progress === null) return null;
  return (
    <div className="upload-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <span style={{ width: `${Math.round(progress * 100)}%` }} />
    </div>
  );
}

// Making an album: a name, a few words, and the photos. Location is removed on the way in.
export function NewAlbum({ onClose }) {
  const { members } = useMembers();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState(null);
  const [note, setNote] = useState({ text: '', tone: '' });
  const [failed, setFailed] = useState([]);
  const [postId, setPostId] = useState(null);

  async function send(retryFiles) {
    if (!navigator.onLine) return setNote({ text: 'Photos need a connection. Try again when you’re back online.', tone: 'error' });
    setNote({ text: '', tone: '' });
    let id = postId;
    if (!id) {
      id = uuid();
      const body = text.trim();
      const { error } = await createPhotoPost({ id, kind: 'photo_album', body, payload: { title: title.trim() || undefined }, mentions: extractMentions(body, members) });
      if (error) return setNote({ text: error.message, tone: 'error' });
      setPostId(id);
      notifyChanged();
    }
    const list = retryFiles || files;
    setProgress(0);
    const results = await uploadAll(id, list, (p) => setProgress(p), retryFiles ? files.length - retryFiles.length : 0);
    setProgress(null);
    const bad = results.filter((r) => !r.ok);
    setFailed(bad.map((r) => r.file));
    await publishAlbum(id);
    notifyChanged();
    if (!bad.length) { onClose(); return undefined; }
    setNote({ text: `${list.length - bad.length} of ${list.length} sent. ${bad[0].error}`, tone: 'error' });
    return undefined;
  }

  const sending = progress !== null;
  return (
    <Sheet title="New album" onClose={sending ? () => {} : onClose}>
      <label className="label" htmlFor="album-title">Name</label>
      <input id="album-title" className="field" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Beach day" disabled={Boolean(postId)} />
      <label className="label" htmlFor="album-words">A few words (optional)</label>
      <div id="album-words">
        <MentionTextarea value={text} onChange={setText} rows={2} label="A few words" placeholder="What was happening?" maxLength={5000} />
      </div>
      {!postId && <PhotoPicker files={files} onChange={setFiles} />}
      <p className="hint">Photos stay on the family’s own server. Where they were taken is removed before they’re saved.</p>
      <UploadProgress progress={progress} />
      {failed.length > 0 && !sending
        ? <button className="primary wide" onClick={() => send(failed)}>Try the {failed.length} again</button>
        : <button className="primary wide" onClick={() => send()} disabled={sending || !files.length}>{sending ? `Sending… ${Math.round(progress * 100)}%` : `Share ${files.length || ''} photo${files.length === 1 ? '' : 's'}`}</button>}
      <Message tone={note.tone}>{note.text}</Message>
    </Sheet>
  );
}
