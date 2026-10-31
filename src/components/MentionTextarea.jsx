import { useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useMembers } from '../members.jsx';
import { activeMention, applyMention, suggestMembers } from '../lib/mentions.js';
import { PersonAvatar } from './ui.jsx';

// A text box that suggests family members when you type "@". Works by tap, mouse or keyboard
// (arrows + Enter/Tab, Escape to dismiss); Ctrl/Cmd+Enter sends.
export default function MentionTextarea({ value, onChange, onSubmit, placeholder, rows = 3, autoFocus, label, maxLength = 2000 }) {
  const { profile } = useAuth();
  const { members } = useMembers();
  const ref = useRef(null);
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(null);

  const active = activeMention(value, caret);
  const options = active && dismissed !== active.start ? suggestMembers(active.query, members, profile.id) : [];
  const open = options.length > 0;

  function choose(member) {
    const next = applyMention(value, caret, active.start, member.display_name);
    onChange(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  function onKeyDown(e) {
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + options.length) % options.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(options[index] || options[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(active.start); return; }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit?.(); }
  }

  const track = (e) => setCaret(e.target.selectionStart ?? e.target.value.length);

  return (
    <div className="mention-wrap">
      <textarea
        ref={ref} value={value} rows={rows} maxLength={maxLength} autoFocus={autoFocus}
        placeholder={placeholder} aria-label={label || placeholder}
        aria-autocomplete="list" aria-expanded={open}
        onChange={(e) => { onChange(e.target.value); track(e); setIndex(0); setDismissed(null); }}
        onSelect={track} onClick={track} onKeyUp={track} onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="mention-list" role="listbox" aria-label="Family members">
          {options.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === index}>
              <button type="button" className={i === index ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(m)}>
                <PersonAvatar person={m} size={32} /> {m.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
