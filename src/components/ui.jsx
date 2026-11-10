import { useEffect, useRef } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
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
          <button className="x" onClick={onClose} aria-label="Close"><Ico as={X} size={20} /></button>
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

// A Lucide icon, hidden from screen readers (the button or text beside it says what it is).
export function Ico({ as: Icon, size = 20, stroke = 2, className }) {
  return <Icon size={size} strokeWidth={stroke} aria-hidden="true" focusable="false" className={className} />;
}

// The title at the top of each tab, with what it's for and its main action.
export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function Empty({ icon, title, children, action }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon"><Ico as={icon} size={26} /></div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// Grey placeholder cards while the timeline loads for the first time.
export function SkeletonPosts({ count = 3 }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="skeleton" aria-hidden="true">
      <div className="sk-row">
        <span className="sk sk-circle" />
        <span style={{ flex: 1 }}>
          <span className="sk sk-line" style={{ display: 'block', width: '40%' }} />
          <span className="sk sk-line" style={{ display: 'block', width: '24%' }} />
        </span>
      </div>
      <span className="sk sk-line" style={{ display: 'block', width: '92%' }} />
      <span className="sk sk-line" style={{ display: 'block', width: i % 2 ? '60%' : '78%' }} />
    </div>
  ));
}

// The "⋯" menu on posts: closes when you choose something, tap elsewhere or press Escape.
export function Menu({ label = 'More options', children }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const close = (e) => { if (el.open && !el.contains(e.target)) el.open = false; };
    const key = (e) => { if (e.key === 'Escape' && el.open) { el.open = false; el.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, []);
  return (
    <details className="menu" ref={ref}>
      <summary aria-label={label}><Ico as={MoreHorizontal} size={22} /></summary>
      <div className="menu-list" onClick={() => { if (ref.current) ref.current.open = false; }}>{children}</div>
    </details>
  );
}
