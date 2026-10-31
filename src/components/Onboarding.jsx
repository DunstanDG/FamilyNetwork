import { useMemo, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useInstallPrompt } from '../hooks.js';
import { enablePush, isIos, isStandalone, pushSupported } from '../push.js';
import ModuleToggles from './NotificationSettings.jsx';
import { Message } from './ui.jsx';

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY;

// The first-run walkthrough: put the app on the home screen, then switch on notifications.
// iPhone only allows notifications for apps on the Home Screen, so there the order matters.
export default function Onboarding({ onDone }) {
  const { profile, updateProfile } = useAuth();
  const { canInstall, install } = useInstallPrompt();
  const ios = isIos();
  const standalone = isStandalone();

  const steps = useMemo(() => {
    const s = [];
    if (!standalone) s.push('install');
    if (pushSupported() && VAPID && !(ios && !standalone)) s.push('alerts');
    s.push('done');
    return s;
  }, [ios, standalone]);

  const [i, setI] = useState(0);
  const [muted, setMuted] = useState(profile.muted_kinds || []);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const step = steps[i];
  const next = () => setI((n) => Math.min(n + 1, steps.length - 1));

  async function turnOn() {
    setBusy(true); setNote('');
    await updateProfile({ muted_kinds: muted });
    const res = await enablePush();
    setBusy(false);
    if (res.ok) return next();
    setNote(res.reason === 'denied'
      ? 'Notifications are blocked for this app. You can allow them later in your browser or phone settings.'
      : 'No problem, you can switch them on later in Settings.');
    return undefined;
  }

  return (
    <div className="scrim onboarding" role="dialog" aria-modal="true" aria-label="Welcome">
      <div className="sheet">
        <p className="step-count">Step {i + 1} of {steps.length}</p>

        {step === 'install' && ios && (
          <>
            <h2>Add Family Network to your Home Screen</h2>
            <ol className="big-steps">
              <li>Tap the <strong>Share</strong> button at the bottom of Safari (a square with an arrow).</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
              <li>Open <strong>Family</strong> from your Home Screen. You’ll sign in once more there, and then we’ll set up notifications.</li>
            </ol>
            <button className="primary wide" onClick={() => { next(); }}>I’ve done it</button>
          </>
        )}

        {step === 'install' && !ios && (
          <>
            <h2>Install Family Network</h2>
            <p>Put it on your {/cros/i.test(navigator.userAgent) ? 'shelf' : 'home screen'} so it opens like any other app.</p>
            {canInstall
              ? <button className="primary wide" onClick={async () => { await install(); next(); }}>Install the app</button>
              : <p className="hint">Use your browser’s menu and choose “Install app” or “Add to Home screen”.</p>}
            <button className="mini wide" onClick={next}>{canInstall ? 'Not now' : 'Continue'}</button>
          </>
        )}

        {step === 'alerts' && (
          <>
            <h2>Stay in the loop</h2>
            <p>Get a notification when someone mentions you or replies to you. Choose what you’d like to hear about:</p>
            <ModuleToggles muted={muted} onChange={setMuted} />
            <button className="primary wide" onClick={turnOn} disabled={busy}>Turn on notifications</button>
            <button className="mini wide" onClick={next}>Not now</button>
            <Message>{note}</Message>
          </>
        )}

        {step === 'done' && (
          <>
            <h2>You’re all set{profile.display_name ? `, ${profile.display_name}` : ''}!</h2>
            <p>Share an update, say hello, or react to what others have posted.</p>
            <button className="primary wide" onClick={onDone}>Go to the family timeline</button>
          </>
        )}
      </div>
    </div>
  );
}
