import { isIos, isStandalone } from './push.js';
import { useState } from 'react';
import { useAuth } from './auth.jsx';
import { Message } from './components/ui.jsx';

function Brand() {
  return (
    <div className="brand">
      <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width="72" height="72" />
      <h1>Family Network</h1>
      <p className="hello">A private place for the family</p>
    </div>
  );
}

export const Splash = () => (
  <main className="center"><Brand /><p className="notice">Loading…</p></main>
);

export const Unconfigured = () => (
  <main className="center">
    <Brand />
    <p className="msg error" role="alert">
      This copy of the app has no database connection yet. Set <code>VITE_SUPABASE_URL</code> and{' '}
      <code>VITE_SUPABASE_ANON_KEY</code> and rebuild. See the README.
    </p>
  </main>
);

export function ErrorScreen() {
  const { error, signOut } = useAuth();
  const schemaHint = /schema|relation|does not exist|PGRST106|406/i.test(error);
  return (
    <main className="center">
      <Brand />
      <p className="msg error" role="alert">Couldn’t load your profile. {error}</p>
      {schemaHint && <p className="hint">Check that the <code>family</code> schema has been added to “Exposed schemas” in Supabase (Project Settings → API), and that the migration has been run.</p>}
      <button className="primary wide" onClick={() => window.location.reload()}>Try again</button>
      <button className="mini wide" onClick={signOut}>Sign out</button>
    </main>
  );
}

function InviteBanner() {
  const { invite } = useAuth();
  if (!invite.code) return null;
  if (invite.valid === false) {
    return <p className="msg error" role="alert">This invite link has expired or has already been used. If you’ve joined before, sign in below. Otherwise ask for a new link.</p>;
  }
  if (invite.valid === true) return <p className="msg ok" role="status">You’ve been invited to join. Sign in to continue.</p>;
  return null;
}

export function SignIn() {
  const { signInGoogle, sendCode, verifyCode, error: linkError } = useAuth();
  const [step, setStep] = useState('choose'); // choose | email | sent
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Email links open in Safari, never inside an iPhone home-screen app, so they can't sign it in.
  const iosApp = isIos() && isStandalone();

  async function google() {
    setBusy(true); setError('');
    const { error: err } = await signInGoogle();
    if (err) { setError(err.message); setBusy(false); }
  }

  async function email_(e) {
    e.preventDefault();
    setBusy(true); setError('');
    const { error: err } = await sendCode(email.trim());
    setBusy(false);
    if (err) {
      return setError(/rate limit|too many/i.test(err.message)
        ? 'Too many emails have been sent for now. Wait a while and try again, or continue with Google.'
        : err.message);
    }
    setStep('sent');
    return undefined;
  }

  async function verify(e) {
    e.preventDefault();
    setBusy(true); setError('');
    const { error: err } = await verifyCode(email.trim(), code.replace(/\s/g, ''));
    setBusy(false);
    if (err) setError('That code didn’t work. Check it and try again, or ask for a new email.');
  }

  return (
    <main className="center">
      <Brand />
      <InviteBanner />
      {step === 'choose' && (
        <>
          <button className="primary wide" onClick={google} disabled={busy}>Continue with Google</button>
          <button className="mini wide" onClick={() => setStep('email')}>Use my email instead</button>
          {iosApp && <p className="hint">On iPhone, Google is easiest here: links in emails open in Safari, not in this app.</p>}
        </>
      )}
      {step === 'email' && (
        <form onSubmit={email_}>
          <label className="label" htmlFor="email">Your email address</label>
          <input id="email" className="field" type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="primary wide" disabled={busy || !email.trim()}>Email me a sign-in link</button>
          <button type="button" className="mini wide" onClick={() => setStep('choose')}>Back</button>
        </form>
      )}
      {step === 'sent' && (
        <div>
          <p className="msg ok" role="status">We’ve emailed {email}. It can take a minute to arrive.</p>
          {iosApp ? (
            <p className="hint">On iPhone, the link in the email opens in Safari rather than in this app, so it can’t sign you in here. Continue with Google below, or use the code if the email has one.</p>
          ) : (
            <ol className="big-steps">
              <li>Open the email <strong>on this device</strong>, in the same browser.</li>
              <li>Tap the sign-in link. It brings you straight back here, signed in.</li>
            </ol>
          )}
          {!showCode
            ? <button type="button" className="linkish" onClick={() => setShowCode(true)}>The email has a 6-digit code instead</button>
            : (
              <form onSubmit={verify}>
                <label className="label" htmlFor="code">The code from the email</label>
                <input id="code" className="field code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
                <button className="primary wide" disabled={busy || code.replace(/\s/g, '').length < 6}>Sign in</button>
              </form>
            )}
          <button type="button" className="mini wide" onClick={() => { setStep('email'); setCode(''); setShowCode(false); }}>Send it again, or use a different email</button>
          <button type="button" className="mini wide" onClick={google}>Continue with Google instead</button>
        </div>
      )}
      <Message tone="error">{error || (step === 'choose' ? linkError : '')}</Message>
    </main>
  );
}

export function Join() {
  const { session, invite, redeem, signOut } = useAuth();
  const meta = session.user.user_metadata || {};
  const [name, setName] = useState(meta.full_name || meta.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const usable = invite.code && invite.valid !== false;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    const res = await redeem(name);
    if (res.error) { setError(res.error); setBusy(false); }
  }

  return (
    <main className="center">
      <Brand />
      {usable ? (
        <form onSubmit={submit}>
          <p className="hint">Welcome! What should the family call you?</p>
          <label className="label" htmlFor="name">Your name</label>
          <input id="name" className="field" maxLength={40} required autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary wide" disabled={busy || !name.trim()}>{busy ? 'Joining…' : 'Join the family'}</button>
        </form>
      ) : (
        <>
          <p className="msg error" role="alert">
            {invite.valid === false
              ? 'That invite link has expired or has already been used.'
              : 'This is a private family space, and you’ll need an invite link to join.'}
          </p>
          <p className="hint">Ask the person who invited you for a new link, then open it on this device. You’re signed in as {session.user.email}.</p>
        </>
      )}
      <Message tone="error">{error}</Message>
      <button className="mini wide" onClick={signOut}>Sign out</button>
    </main>
  );
}
