import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);

// Everything lives in the `family` schema. The storage key is deliberately our own: other apps on the
// same github.io address (HomeQuest) must never read or overwrite this app's sign-in.
export const supabase = configured
  ? createClient(url, key, {
      db: { schema: 'family' },
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'family-network-auth',
      },
    })
  : null;

export const appUrl = () => `${window.location.origin}${import.meta.env.BASE_URL}`;
