import { isIos, isStandalone } from './push.js';
import { useState } from 'react';
import { useAuth } from './auth.jsx';
import { Ico, Message } from './components/ui.jsx';
import { Lock, Mail } from 'lucide-react';

// Google's own "G", so the button is instantly recognisable.
const GoogleG = () => (
  <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

const Private = () => <p className="fineprint"><Ico as={Lock} size={14} />Private to invited family. No ads, no tracking.</p>;

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
  <main className="center"><Brand /><div className="auth-card" aria-busy="true"><span className="sk sk-line" style={{ display: 'block', width: '70%', margin: '6px auto' }} /><span className="sk sk-line" style={{ display: 'block', width: '45%', margin: '12px auto 6px' }} /></div></main>
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
      <div className="auth-card">
        <p className="msg error" role="alert">Couldn’t load your profile. {error}</p>
        {schemaHint && <p className="hint">In Supabase, open Project Settings → Data API and add <code>family</code> to “Exposed schemas” (keep <code>public</code> there too), save, and reload in a minute. If it’s already there, check the migrations have all been run.</p>}
        <button className="primary wide" onClick={() => window.location.reload()}>Try again</button>
        <button className="mini wide" onClick={signOut}>Sign out</button>
      </div>
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
      <div className="auth-card">
      <InviteBanner />
      {step === 'choose' && (
        <>
          <button className="primary wide google" onClick={google} disabled={busy}><GoogleG />Continue with Google</button>
          <div className="or">or</div>
          <button className="mini wide" onClick={() => setStep('email')}><Ico as={Mail} />Use my email instead</button>
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
          <button type="button" className="mini wide" onClick={google}><GoogleG />Continue with Google instead</button>
        </div>
      )}
      <Message tone="error">{error || (step === 'choose' ? linkError : '')}</Message>
      </div>
      <Private />
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
      <div className="auth-card">
      {usable ? (
        <form onSubmit={submit}>
          <p className="msg ok" role="status">You’re invited! What should the family call you?</p>
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
      </div>
      <Private />
    </main>
  );
}
