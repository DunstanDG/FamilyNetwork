export const EDIT_WINDOW_MS = 15 * 60 * 1000;

export const canEdit = (createdAt, now = Date.now()) => now - new Date(createdAt).getTime() < EDIT_WINDOW_MS;

export function ago(iso, now = Date.now()) {
  const then = new Date(iso);
  const mins = Math.floor((now - then.getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}
