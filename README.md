# Family Network

A private, invite-only space where family share updates, reply to each other and (in later phases)
share photos, podcasts, videos and plans. A React PWA on GitHub Pages, with Supabase for sign-in, data
and live updates.

**Status: Phase 1 (foundation).** Done: sign-in, invites, roles, home timeline with a "since you last
looked" line, replies, reactions, @mentions, push notifications, offline reading and writing, and the
six-tab shell. Photos, podcasts, videos, news and calendar tabs are placeholders until their phases.

## What is in the box

| Area | Where | Notes |
| --- | --- | --- |
| Database, security rules | `supabase/migrations/0001_family_network.sql` | Own `family` schema, row-level security on every table |
| First admin | `supabase/bootstrap_admin.sql` | Edit placeholders, run once |
| Push sender | `supabase/functions/send-push/` | Edge Function called by a database webhook |
| App | `src/` | React + Vite + vite-plugin-pwa (custom service worker in `src/sw.js`) |
| Tests | `tests/` | Database rules on a real Postgres (PGlite), app logic, push logic, browser smoke test |

## Set it up

You need a Supabase project (the same one HomeQuest uses is fine: everything lives in its own schema).

### 1. Before you invite anyone: check HomeQuest's security

Everyone who signs in to Family Network gets an account in the **project's shared sign-in system**.
Family Network ignores accounts that haven't joined the family, but HomeQuest might not. In the SQL
editor run:

```sql
select tablename, policyname, roles, cmd, qual from pg_policies where schemaname = 'public';
```

If any policy reads `true` or `auth.role() = 'authenticated'` (rather than checking membership of your
household), a relative who signs in could read that table through HomeQuest's API. Tighten those first.

### 2. Database

1. SQL editor: paste and run `supabase/migrations/0001_family_network.sql`.
2. **Project Settings → API → Exposed schemas**: add `family`.
3. Sign in to the app once (it will say you need an invite), then edit and run `supabase/bootstrap_admin.sql`
   to make yourself the first admin. Keep your edited copy out of the repo.

### 3. Sign-in

- **Authentication → Providers → Google**: enable, with your Google OAuth client.
- **Authentication → URL Configuration → Redirect URLs**: add
  `https://<your-github-username>.github.io/FamilyNetwork/` (and `http://localhost:5173/` for local work).
- **Authentication → Email Templates → Magic Link**: make sure the template includes `{{ .Token }}`
  (the app asks people to type the code, which works inside an installed iPhone app where magic links
  don't). This template is shared by every app in the project, so keep any link you already have too.

### 4. Push notifications

```bash
npx web-push generate-vapid-keys        # a new pair for this app
supabase secrets set PUSH_WEBHOOK_SECRET=<a long random string> \
  FAMILY_VAPID_PUBLIC_KEY=<public> FAMILY_VAPID_PRIVATE_KEY=<private> FAMILY_VAPID_SUBJECT=mailto:you@example.com
supabase functions deploy send-push --no-verify-jwt
```

Then **Database → Webhooks → Create**: table `family.notifications`, event **Insert**, type
*Supabase Edge Functions* → `send-push`, with an HTTP header `x-webhook-secret` set to the same secret.

### 5. Deploy the app

In the GitHub repo: **Settings → Pages → Source: GitHub Actions**, then
**Settings → Secrets and variables → Actions → Variables** and add `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` and `VITE_VAPID_PUBLIC_KEY` (all three are safe to expose; they end up in the
built app). Pushing to `main` builds, runs the tests and publishes.

### 6. Invite the family

Open the app → 👪 → *Invite someone*. Each link works once and expires after 7 days. People open it,
sign in with Google (or an emailed code), choose a name, and are walked through installing the app and
turning on notifications. On iPhone the app must be added to the Home Screen first; they'll sign in
once more from there.

## Develop

```bash
npm install
cp .env.example .env.local     # fill in the values
npm run dev                    # http://localhost:5173/FamilyNetwork/
npm test                       # database rules, app logic, push logic
npx playwright install chromium && npm run test:e2e    # browser smoke test with a mocked backend
```

## How it behaves

- **Roles.** Admins manage people and invites, pin and remove posts. Adults post, reply, react and can
  invite adults and children. Children can post, reply and react but cannot invite. Everyone is inside
  one family circle; there is no content outside it.
- **Edits.** Authors can edit their own posts and replies for 15 minutes; admins can delete or pin but
  never rewrite someone's words. All of this is enforced in the database, not just the interface.
- **Offline.** The last timeline is kept on the device. Posts and replies written offline wait in an
  outbox and send by themselves; each carries an id made on the device so nothing can post twice.
- **Notifications.** Mentions and replies, switchable per area (Updates, Photos, Podcasts, Videos, News,
  Calendar). Muting is stored on the person's profile.

## Differences from the product spec

- Six tabs are Home, Photos, Podcasts, Videos, News, Calendar; **Updates** is a filter on Home rather
  than its own tab.
- Notification muting lives on `profiles.muted_kinds` (per person) instead of on each push subscription.
- Added a `notifications` table (written by triggers) so the 🔔 list and push share one source.
- Updates can carry a link now; **a photo on an update waits for Phase 3** (it needs the Immich gateway).
- The optional weekly email digest is not in Phase 1.
- Until Phase 2, the database only lets people create `update` posts; later migrations widen that.

## Good to know

- The app shares the `github.io` address with HomeQuest. Its sign-in storage uses its own key, and the
  service worker is scoped to `/FamilyNetwork/`, so they don't interfere. A custom domain later would
  also isolate them completely (set `BASE_PATH=/`).
- The `anon` key is public by design; row-level security is what keeps data private.

## Next: Phase 2

Feeds move in: sources and playback tables, the feed poller with ETag handling, Podcast Index search,
YouTube and news cards, the Android share target, then retiring Family Feed (spec, 14 Dec to 31 Jan).
