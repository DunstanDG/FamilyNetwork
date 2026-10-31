import { useEffect, useRef } from 'react';
import { avatarHue, initials } from '../lib/timeline.js';
import { tokenize } from '../lib/mentions.js';
import { useMembers } from '../members.jsx';

export function Avatar({ person, size = 44 }) {
  const name = person?.display_name || '?';
  const style = { width: size, height: size, fontSize: size * 0.4 };
  if (person?.avatar_url) {
    return (
      <img
        className="avatar" style={style} src={person.avatar_url} alt="" loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextSibling?.removeAttribute('hidden'); }}
      />
    );
  }
  return <span className="avatar initials" style={{ ...style, '--hue': avatarHue(person?.id) }} aria-hidden="true">{initials(name)}</span>;
}

// Avatar with an initials fallback that appears if the picture fails to load.
export function PersonAvatar({ person, size }) {
  return (
    <>
      <Avatar person={person} size={size} />
      {person?.avatar_url && <span hidden><Avatar person={{ ...person, avatar_url: null }} size={size} /></span>}
    </>
  );
}

export function Sheet({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Post and reply text, with @mentions highlighted and web links made clickable.
export function Body({ text }) {
  const { members } = useMembers();
  if (!text) return null;
  return (
    <p className="text">
      {tokenize(text, members).map((part, i) => {
        if (part.type === 'mention') return <strong key={i} className="mention">{part.value}</strong>;
        if (part.type === 'link') return <a key={i} href={part.value} target="_blank" rel="noopener noreferrer">{part.value}</a>;
        return part.value;
      })}
    </p>
  );
}

export function Message({ children, tone }) {
  if (!children) return null;
  return <p className={`msg ${tone || ''}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>;
}
