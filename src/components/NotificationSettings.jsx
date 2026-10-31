import { KIND_LABEL } from '../lib/timeline.js';

const KINDS = ['update', 'photo_album', 'podcast_episode', 'video', 'link', 'event'];

// Which kinds of post may send you a notification. Stored as the list of kinds you've switched OFF.
export default function ModuleToggles({ muted, onChange }) {
  const toggle = (kind) => onChange(muted.includes(kind) ? muted.filter((k) => k !== kind) : [...muted, kind]);
  return (
    <fieldset className="toggles">
      <legend>Tell me about</legend>
      {KINDS.map((kind) => (
        <label key={kind} className="toggle">
          <input type="checkbox" checked={!muted.includes(kind)} onChange={() => toggle(kind)} />
          <span>{KIND_LABEL[kind]}</span>
        </label>
      ))}
      <p className="hint">Switch an area off to stop notifications about it, including replies and mentions.</p>
    </fieldset>
  );
}
