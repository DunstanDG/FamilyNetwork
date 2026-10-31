import { useState } from 'react';
import { useMembers } from '../members.jsx';
import { useOutbox } from '../outbox.jsx';
import { extractMentions } from '../lib/mentions.js';
import { normaliseLink } from '../lib/timeline.js';
import { uuid } from '../lib/uuid.js';
import MentionTextarea from './MentionTextarea.jsx';
import { Message } from './ui.jsx';

export default function Composer() {
  const { members } = useMembers();
  const outbox = useOutbox();
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [note, setNote] = useState({ text: '', tone: '' });
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e?.preventDefault();
    const body = text.trim();
    const url = showLink && link.trim() ? normaliseLink(link) : null;
    if (showLink && link.trim() && !url) return setNote({ text: 'That link doesn’t look right. It should start with http or https.', tone: 'error' });
    if (!body && !url) return undefined;

    setBusy(true);
    const id = uuid();
    const res = await outbox.submit({
      id, type: 'post',
      data: { id, kind: 'update', body, payload: url ? { link: { url } } : {}, mentions: extractMentions(body, members) },
    });
    setBusy(false);
    if (!res.ok) return setNote({ text: res.error, tone: 'error' });
    setText(''); setLink(''); setShowLink(false);
    setNote(res.queued ? { text: 'You’re offline. Your post is saved and will send by itself when you’re back online.', tone: '' } : { text: '', tone: '' });
    return undefined;
  }

  return (
    <form className="composer card-lite" onSubmit={submit}>
      <MentionTextarea
        value={text} onChange={setText} onSubmit={submit} rows={3} maxLength={5000}
        placeholder="Share something with the family…" label="Write an update"
      />
      {showLink && (
        <input
          className="field" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)}
          placeholder="Paste a link" aria-label="Link to share"
        />
      )}
      <div className="composer-actions">
        <button type="button" className="mini" onClick={() => setShowLink((s) => !s)} aria-pressed={showLink}>
          🔗 {showLink ? 'Remove link' : 'Add a link'}
        </button>
        <button className="primary" type="submit" disabled={busy || (!text.trim() && !link.trim())}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>
      <Message tone={note.tone}>{note.text}</Message>
    </form>
  );
}
