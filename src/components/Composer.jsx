import { useEffect, useRef, useState } from 'react';
import { useMembers } from '../members.jsx';
import { useOutbox } from '../outbox.jsx';
import { createPhotoPost, lookup } from '../data.js';
import { notifyChanged } from '../hooks.js';
import { photosConfigured, uploadPhoto } from '../photos.js';
import { PhotoPicker, UploadProgress } from './Photos.jsx';
import { extractMentions } from '../lib/mentions.js';
import { normaliseLink } from '../lib/timeline.js';
import { classifyLink } from '../lib/links.js';
import { KIND_NAME, buildPost } from '../lib/share.js';
import { uuid } from '../lib/uuid.js';
import MentionTextarea from './MentionTextarea.jsx';
import { LinkPreview } from './cards.jsx';
import { Message } from './ui.jsx';

const PLACEHOLDER = {
  home: 'Share something with the family…',
  link: 'Say something about it (optional)…',
};

// Writing a post. A link turns it into a video, podcast or news post, with a preview fetched while you
// type. `linkFirst` is for the Podcasts, Videos and News tabs, where sharing a link is the point.
export default function Composer({ linkFirst = false, linkHint = 'Paste a link', initial = null, onPosted, extra = null }) {
  const { members } = useMembers();
  const outbox = useOutbox();
  const [text, setText] = useState(initial?.text || '');
  const [link, setLink] = useState(initial?.url || '');
  const [showLink, setShowLink] = useState(linkFirst || Boolean(initial?.url));
  const [preview, setPreview] = useState({ url: null, data: null, loading: false });
  const [note, setNote] = useState({ text: '', tone: '' });
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState([]);
  const [progress, setProgress] = useState(null);
  const pending = useRef(null);

  const url = showLink && link.trim() ? normaliseLink(link) : null;

  // Fetch a preview shortly after the link stops changing.
  useEffect(() => {
    if (!url || !navigator.onLine) { setPreview({ url: null, data: null, loading: false }); return undefined; }
    if (preview.url === url) return undefined;
    setPreview({ url, data: null, loading: true });
    const t = setTimeout(() => {
      const req = lookup({ action: 'preview', url }).then(({ data }) => data || null);
      pending.current = { url, req };
      req.then((data) => setPreview((cur) => (cur.url === url ? { url, data, loading: false } : cur)));
    }, 500);
    return () => clearTimeout(t);
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e?.preventDefault();
    if (showLink && link.trim() && !url) return setNote({ text: 'That link doesn’t look right. It should start with http or https.', tone: 'error' });
    if (photo.length) return sendWithPhoto();
    if (!text.trim() && !url) return undefined;

    setBusy(true);
    let data = preview.url === url ? preview.data : null;
    // A preview still on its way: wait a moment for it rather than post a bare link.
    if (url && !data && navigator.onLine && pending.current?.url === url) {
      data = await Promise.race([pending.current.req, new Promise((r) => setTimeout(() => r(null), 4000))]);
    }
    const post = buildPost({ text, url, preview: data });
    const id = uuid();
    const res = await outbox.submit({ id, type: 'post', data: { id, ...post, mentions: extractMentions(post.body, members) } });
    setBusy(false);
    if (!res.ok) return setNote({ text: res.error, tone: 'error' });
    setText(''); setLink(''); setShowLink(linkFirst); setPreview({ url: null, data: null, loading: false });
    setNote(res.queued ? { text: 'You’re offline. Your post is saved and will send by itself when you’re back online.', tone: '' } : { text: '', tone: '' });
    onPosted?.(post);
    return undefined;
  }

  // An update with one photo goes straight to the server (photos need a connection).
  async function sendWithPhoto() {
    if (!navigator.onLine) return setNote({ text: 'Photos need a connection. Try again when you’re back online.', tone: 'error' });
    setBusy(true); setNote({ text: '', tone: '' });
    const id = uuid();
    const body = text.trim();
    const { error } = await createPhotoPost({ id, kind: 'update', body, payload: {}, mentions: extractMentions(body, members) });
    if (error) { setBusy(false); return setNote({ text: error.message, tone: 'error' }); }
    setProgress(0);
    try {
      await uploadPhoto(id, photo[0], 0, setProgress);
      setText(''); setPhoto([]);
    } catch (e) {
      setNote({ text: `Your words were posted, but the photo didn’t go: ${e.message}`, tone: 'error' });
    }
    setProgress(null); setBusy(false);
    notifyChanged();
    return undefined;
  }

  const kind = url ? classifyLink(url) : null;
  const canPhoto = !linkFirst && photosConfigured && !showLink;

  return (
    <form className="composer card-lite" onSubmit={submit}>
      {linkFirst && (
        <input
          className="field" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)}
          placeholder={linkHint} aria-label="Link to share" autoComplete="off"
        />
      )}
      <MentionTextarea
        value={text} onChange={setText} onSubmit={submit} rows={linkFirst ? 2 : 3} maxLength={5000}
        placeholder={PLACEHOLDER[linkFirst ? 'link' : 'home']} label={linkFirst ? 'Say something about it' : 'Write an update'}
      />
      {showLink && !linkFirst && (
        <input
          className="field" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)}
          placeholder="Paste a link: a video, a podcast episode or an article" aria-label="Link to share" autoComplete="off"
        />
      )}
      {url && (
        <div className="composer-preview">
          <span className="badge">{KIND_NAME[kind]}</span>
          {preview.loading ? <p className="hint">Getting a preview…</p> : <LinkPreview url={url} preview={preview.data} />}
        </div>
      )}
      {extra}
      <UploadProgress progress={progress} />
      <div className="composer-actions">
        <div className="row wrap">
          {!linkFirst && !photo.length && (
            <button type="button" className="mini" onClick={() => setShowLink((s) => !s)} aria-pressed={showLink}>
              🔗 {showLink ? 'Remove link' : 'Share a link'}
            </button>
          )}
          {canPhoto && <PhotoPicker files={photo} onChange={setPhoto} multiple={false} label="Add a photo" />}
        </div>
        <button className="primary" type="submit" disabled={busy || (!text.trim() && !url && !photo.length)}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
      <Message tone={note.tone}>{note.text}</Message>
    </form>
  );
}
