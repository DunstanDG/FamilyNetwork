// Small formatting helpers for players and cards.

// 75 -> "1:15", 3723 -> "1:02:03"
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// 3723 -> "1 hr 2 min", 600 -> "10 min"
export function length(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h && m) return `${h} hr ${m} min`;
  if (h) return `${h} hr`;
  return `${Math.max(1, m)} min`;
}

// Where someone is up to in an episode, in words.
export function progressLabel(playback, duration) {
  if (!playback) return '';
  if (playback.finished) return 'Played';
  const pos = Number(playback.position_seconds) || 0;
  if (pos < 15) return '';
  const total = Number(playback.duration_seconds || duration) || 0;
  if (total && total - pos < 60) return 'Played';
  return total ? `${clock(total - pos)} left` : `Resume at ${clock(pos)}`;
}

// Where to start playing: saved place, unless it is finished or within the last 30 seconds.
export function resumeAt(playback, duration) {
  if (!playback || playback.finished) return 0;
  const pos = Number(playback.position_seconds) || 0;
  const total = Number(playback.duration_seconds || duration) || 0;
  if (total && total - pos < 30) return 0;
  return pos;
}

// "Tuesday 3 November" for a YYYY-MM-DD day, "Today" / "Yesterday" when it is.
export function dayLabel(day, now = new Date()) {
  const fmt = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const today = fmt(now);
  const yesterday = fmt(new Date(now.getTime() - 864e5));
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}
