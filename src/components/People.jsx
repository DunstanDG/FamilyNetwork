import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useMembers } from '../members.jsx';
import { appUrl } from '../supabase.js';
import { createHousehold, createInvite, deleteInvite, fetchInvites, removeMember, updateMember } from '../data.js';
import { Message, PersonAvatar, Sheet } from './ui.jsx';

const ROLE_LABEL = { admin: 'Admin', adult: 'Adult', child: 'Child' };
const inviteLink = (code) => `${appUrl()}?invite=${code}`;
const daysLeft = (iso) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));

function InviteLink({ link, name }) {
  const [copied, setCopied] = useState(false);
  const text = `${name ? `Hi ${name}! ` : ''}Here's your invite to our family space: ${link}`;

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select-all fallback below */ }
  }

  return (
    <div className="invite">
      <input className="field" readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
      <div className="row wrap">
        <button className="mini" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
        <a className="mini" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">Send on WhatsApp</a>
        {navigator.share && <button className="mini" onClick={() => navigator.share({ text, url: link }).catch(() => {})}>Share…</button>}
      </div>
    </div>
  );
}

function Invites({ onChange }) {
  const { profile } = useAuth();
  const { households } = useMembers();
  const admin = profile.role === 'admin';
  const [list, setList] = useState([]);
  const [note, setNote] = useState('');
  const [role, setRole] = useState('adult');
  const [household, setHousehold] = useState('');
  const [fresh, setFresh] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await fetchInvites();
    setList((data || []).filter((i) => !i.used_by && new Date(i.expires_at) > new Date()));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    setBusy(true); setError('');
    const { data, error: err } = await createInvite({ role, householdId: household, note: note.trim() });
    setBusy(false);
    if (err) return setError(err.message);
    setFresh({ ...data, forName: note.trim() });
    setNote('');
    load(); onChange?.();
    return undefined;
  }

  async function revoke(code) {
    await deleteInvite(code);
    if (fresh?.code === code) setFresh(null);
    load();
  }

  return (
    <section>
      <h3>Invite someone</h3>
      <p className="hint">Each link works once and expires after 7 days.</p>
      <form onSubmit={create}>
        <label className="label" htmlFor="inv-note">Who is it for?</label>
        <input id="inv-note" className="field" maxLength={60} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Nan" />
        <div className="row wrap">
          <div className="grow">
            <label className="label" htmlFor="inv-role">They’ll be</label>
            <select id="inv-role" className="field" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="adult">An adult</option>
              <option value="child">A child</option>
              {admin && <option value="admin">An admin</option>}
            </select>
          </div>
          <div className="grow">
            <label className="label" htmlFor="inv-house">Household</label>
            <select id="inv-house" className="field" value={household} onChange={(e) => setHousehold(e.target.value)}>
              <option value="">Extended family</option>
              {households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
          </div>
        </div>
        <button className="primary wide" disabled={busy}>Create invite link</button>
      </form>
      <Message tone="error">{error}</Message>
      {fresh && <InviteLink link={inviteLink(fresh.code)} name={fresh.forName} />}

      {list.filter((i) => i.code !== fresh?.code).length > 0 && (
        <>
          <h4>Waiting to be used</h4>
          <ul className="plain">
            {list.filter((i) => i.code !== fresh?.code).map((i) => (
              <li key={i.code} className="person-row">
                <div className="grow">
                  <strong>{i.note || 'Unnamed invite'}</strong>
                  <small>{ROLE_LABEL[i.role]} · {daysLeft(i.expires_at)} days left</small>
                </div>
                <button className="mini" onClick={() => setFresh({ ...i, forName: i.note })}>Show link</button>
                <button className="mini danger" onClick={() => revoke(i.code)}>Cancel</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function MemberRow({ member, admin, isMe, households, onChanged }) {
  const [error, setError] = useState('');

  async function change(role, household) {
    setError('');
    const { error: err } = await updateMember(member.id, role, household);
    if (err) return setError(err.message);
    onChanged();
    return undefined;
  }

  async function remove() {
    if (!window.confirm(`Remove ${member.display_name} from the family? Their posts and replies will be deleted too.`)) return;
    const { error: err } = await removeMember(member.id);
    if (err) return setError(err.message);
    onChanged();
    return undefined;
  }

  const houseName = households.find((h) => h.id === member.household_id)?.name;

  return (
    <li className="person-col">
      <div className="person-row">
        <PersonAvatar person={member} size={40} />
        <div className="grow">
          <strong>{member.display_name}{isMe ? ' (you)' : ''}</strong>
          <small>{ROLE_LABEL[member.role]}{houseName ? ` · ${houseName}` : ' · Extended family'}</small>
        </div>
      </div>
      {admin && (
        <div className="row wrap admin-row">
          <select className="field" aria-label={`Role for ${member.display_name}`} value={member.role} onChange={(e) => change(e.target.value, member.household_id)}>
            <option value="adult">Adult</option><option value="child">Child</option><option value="admin">Admin</option>
          </select>
          <select className="field" aria-label={`Household for ${member.display_name}`} value={member.household_id || ''} onChange={(e) => change(member.role, e.target.value)}>
            <option value="">Extended family</option>
            {households.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <button className="mini danger" onClick={remove}>Remove</button>
        </div>
      )}
      <Message tone="error">{error}</Message>
    </li>
  );
}

export default function People({ onClose }) {
  const { profile } = useAuth();
  const { members, households, reload } = useMembers();
  const admin = profile.role === 'admin';
  const [house, setHouse] = useState('');
  const [error, setError] = useState('');

  async function addHousehold(e) {
    e.preventDefault();
    const { error: err } = await createHousehold(house.trim());
    if (err) return setError(err.message);
    setHouse(''); setError(''); reload();
    return undefined;
  }

  return (
    <Sheet title="Our family" onClose={onClose}>
      <ul className="plain">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} admin={admin} isMe={m.id === profile.id} households={households} onChanged={reload} />
        ))}
      </ul>

      {profile.role !== 'child' && <Invites onChange={reload} />}

      {admin && (
        <section>
          <h3>Households</h3>
          <p className="hint">Group people who live together. Used later to share plans with HomeQuest.</p>
          <form className="row" onSubmit={addHousehold}>
            <input className="field" aria-label="New household name" placeholder="Household name" maxLength={60} value={house} onChange={(e) => setHouse(e.target.value)} />
            <button className="primary" disabled={!house.trim()}>Add</button>
          </form>
          <Message tone="error">{error}</Message>
        </section>
      )}
    </Sheet>
  );
}
