import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { addReaction, removeReaction } from '../data.js';
import { summariseReactions } from '../lib/timeline.js';
import { notifyChanged } from '../hooks.js';

// One row of reaction buttons, used under posts and under replies alike. Taps show instantly and are
// confirmed (or undone) once the server answers.
export default function Reactions({ rows, postId, commentId, compact = false }) {
  const { profile } = useAuth();
  const [override, setOverride] = useState({});
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);

  useEffect(() => { setOverride({}); }, [rows]);

  const summary = summariseReactions(rows, profile.id).map((r) => {
    const mine = r.key in override ? override[r.key] : r.mine;
    return { ...r, mine, count: r.count + (mine ? 1 : 0) - (r.mine ? 1 : 0) };
  });

  async function toggle(r) {
    setError('');
    const next = !r.mine;
    setOverride((o) => ({ ...o, [r.key]: next }));
    const target = { postId, commentId, emoji: r.key, userId: profile.id };
    const { error: err } = next ? await addReaction(target) : await removeReaction(target);
    if (err && err.code !== '23505') {
      setOverride((o) => { const { [r.key]: _drop, ...rest } = o; return rest; });
      setError(navigator.onLine ? 'That didn’t go through. Try again.' : 'You’re offline.');
      return;
    }
    notifyChanged();
  }

  // Under replies, keep it quiet: show only reactions in use, with a button to add another.
  const shown = compact && !picking ? summary.filter((r) => r.count > 0 || r.mine) : summary;

  return (
    <div className={`reactions ${compact ? 'compact' : ''}`} role="group" aria-label="Reactions">
      {shown.map((r) => (
        <button
          key={r.key} type="button" className={`react ${r.mine ? 'on' : ''}`}
          aria-pressed={r.mine} aria-label={`${r.label}${r.count ? `, ${r.count}` : ''}`}
          onClick={() => toggle(r)}
        >
          <span aria-hidden="true">{r.emoji}</span>
          {r.count > 0 && <span className="count">{r.count}</span>}
        </button>
      ))}
      {compact && (
        <button type="button" className="react add" aria-expanded={picking} aria-label={picking ? 'Hide reactions' : 'Add a reaction'} onClick={() => setPicking((p) => !p)}>
          {picking ? '✕' : '☺+'}
        </button>
      )}
      {error && <span className="react-error" role="alert">{error}</span>}
    </div>
  );
}
