import { useEffect, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useInstallPrompt } from '../hooks.js';
import { disablePush, enablePush, isIos, isStandalone, pushState } from '../push.js';
import ModuleToggles from './NotificationSettings.jsx';
import { Message, PersonAvatar, Sheet } from './ui.jsx';

export function PushControls() {
  const { profile, updateProfile } = useAuth();
  const [state, setState] = useState('checking');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { pushState().then(setState); }, []);

  async function turnOn() {
    setBusy(true); setNote('');
    const res = await enablePush();
    setBusy(false);
    if (res.ok) { setState('on'); return; }
    setState(await pushState());
    setNote(res.reason === 'denied'
      ? 'Notifications are blocked for this app. You can allow them in your browser or phone settings.'
      : res.reason === 'dismissed' ? 'No problem. You can turn them on any time.' : `Couldn’t turn them on. ${res.message || ''}`);
  }

  async function turnOff() {
    setBusy(true);
    await disablePush();
    setBusy(false);
    setState(await pushState());
  }

  return (
    <div>
      {state === 'checking' && <p className="hint">Checking…</p>}
      {state === 'unsupported' && <p className="hint">Notifications aren’t available in this browser.</p>}
      {state === 'needs-install' && (
        <p className="hint">On iPhone, notifications only work once Family Network is on your Home Screen. Tap Share, then “Add to Home Screen”, then open it from there.</p>
      )}
      {state === 'denied' && <p className="hint">Notifications are blocked for this app. You can allow them in your browser or phone settings.</p>}
      {state === 'off' && <button className="primary wide" onClick={turnOn} disabled={busy}>Turn on notifications</button>}
      {state === 'on' && (
        <>
          <p className="msg ok">Notifications are on for this device.</p>
          <ModuleToggles muted={profile.muted_kinds || []} onChange={(muted_kinds) => updateProfile({ muted_kinds })} />
          <button className="mini wide" onClick={turnOff} disabled={busy}>Turn off on this device</button>
        </>
      )}
      <Message>{note}</Message>
    </div>
  );
}

export default function Settings({ onClose }) {
  const { profile, session, updateProfile, signOut } = useAuth();
  const { canInstall, install } = useInstallPrompt();
  const [name, setName] = useState(profile.display_name);
  const [note, setNote] = useState({ text: '', tone: '' });

  async function saveName(e) {
    e.preventDefault();
    const res = await updateProfile({ display_name: name.trim() });
    setNote(res.error ? { text: res.error, tone: 'error' } : { text: 'Saved.', tone: 'ok' });
  }

  return (
    <Sheet title="Your settings" onClose={onClose}>
      <div className="me">
        <PersonAvatar person={profile} size={56} />
        <div>
          <strong>{profile.display_name}</strong>
          <p className="hint">{profile.role === 'admin' ? 'Admin' : profile.role === 'child' ? 'Child account' : 'Adult'} · {session.user.email}</p>
        </div>
      </div>

      <form onSubmit={saveName}>
        <label className="label" htmlFor="myname">Your name</label>
        <div className="row">
          <input id="myname" className="field" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!name.trim() || name.trim() === profile.display_name}>Save</button>
        </div>
        <Message tone={note.tone}>{note.text}</Message>
      </form>

      <h3>Notifications</h3>
      <PushControls />

      {!isStandalone() && (
        <>
          <h3>Install</h3>
          {canInstall
            ? <button className="mini wide" onClick={install}>Add Family Network to this device</button>
            : <p className="hint">{isIos()
              ? 'Tap Share, then “Add to Home Screen”.'
              : 'Use your browser’s menu and choose “Install app” or “Add to Home screen”.'}</p>}
        </>
      )}

      <button className="mini wide signout" onClick={signOut}>Sign out</button>
    </Sheet>
  );
}
