import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { captureInvite } from './auth.jsx';
import './styles.css';

// The browser offers its install prompt once; keep it so our own button can trigger it.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__fnInstallEvent = e;
  window.dispatchEvent(new Event('fn:installable'));
});

captureInvite();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
