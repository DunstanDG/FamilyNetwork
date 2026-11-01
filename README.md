# Family Network

A private, invite-only space where family share updates, photos and the things they're watching or
listening to, and agree when to get together. A React PWA on GitHub Pages, with Supabase for sign-in,
data and live updates, and photos kept on the family's own server.

**Status: all four phases built.** Sign-in, invites and roles; a home timeline with a "since you last
looked" line, replies, reactions and @mentions; push notifications; offline reading and writing;
shared links, videos and podcast episodes with previews; followed shows and channels gathered into a
daily "New from your shows" card; a podcast player that remembers where you were; the Android share
target and an iOS Shortcut; photo albums kept on the home server; and calendar voting that hands
confirmed plans to HomeQuest for those who want it.

## What is in the box

| Area | Where | Notes |
| --- | --- | --- |
| Database, security rules | `supabase/migrations/0001…0005` | Own `family` schema, row-level security on every table. Run in order |
| First admin | `supabase/bootstrap_admin.sql` | Edit placeholders, run once |
| Scheduled jobs | `supabase/schedule.sql` | Feed polling, closing votes, reminders (pg_cron) |
| HomeQuest connection | `supabase/homequest_adapter.sql` | Template; edit for HomeQuest's tables when its schema is settled |
| Family Feed import | `supabase/import_family_feed.sql` | Follows become sources, likes become hearts |
| Push sender | `supabase/functions/send-push/` | Edge Function called by a database webhook |
| Feed poller | `supabase/functions/poll-feeds/` | Edge Function called by pg_cron; ETags, quiet YouTube retries |
| Lookups | `supabase/functions/lookup/` | Link previews, YouTube channel ids, Podcast Index search |
| Photo gateway | `gateway/` | Node container + Cloudflare Tunnel on the Proxmox box, in front of Immich |
| Backups | `ops/backup/` | Nightly database dump, Immich copy to second disk and offsite, restore test |
| App | `src/` | React + Vite + vite-plugin-pwa (custom service worker in `src/sw.js`) |
| Tests | `tests/` | Database rules on a real Postgres (PGlite); feed, preview, gateway and app logic; browser smoke test |

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

1. SQL editor: paste and run each file in `supabase/migrations/` in order (0001 to 0005). 0005 locks
   down who can call which database function; always run it last.
   0002 to 0005 are safe to run again. If one stops part-way (for example with "relation … already
   exists"), run that file again, then every file after it, in order: a later file sometimes updates
   something an earlier one created, so re-running only an earlier one would undo that.
2. **Project Settings → Data API → Exposed schemas**: add `family` (keep `public` and `graphql_public`,
   which HomeQuest needs), save, and allow a minute. Until this is done the app says
   "Invalid schema: family". If it still does after saving, run
   `notify pgrst, 'reload config'; notify pgrst, 'reload schema';` in the SQL editor.
3. Check the function permissions really are locked down (Supabase can grant functions to signed-in
   users by default, which the tests here can't see):

   ```sql
   select routine_name, grantee from information_schema.routine_privileges
   where routine_schema = 'family' and grantee in ('anon', 'authenticated', 'PUBLIC') order by 1, 2;
   ```

   Only these should be listed: `peek_invite` (anon and authenticated), and for authenticated
   `admin_remove_member`, `admin_update_member`, `cancel_event`, `cast_votes`, `confirm_event`,
   `household_busy`, `import_family_feed`, `is_admin`, `is_member`, `my_role`, `propose_event`,
   `publish_album`, `redeem_invite`, `register_push`, `rsvp`. Anything else (for example
   `confirm_choice` or `homequest_sync`): run 0005 again.
4. Sign in to the app once (it will say you need an invite), then edit and run `supabase/bootstrap_admin.sql`
   to make yourself the first admin. Keep your edited copy out of the repo.

### 3. Sign-in

- **Authentication → Providers → Google**: enable, with your Google OAuth client.
- **Authentication → URL Configuration → Redirect URLs**: add
  `https://<your-github-username>.github.io/FamilyNetwork/` (and `http://localhost:5173/` for local work).
- **Email sign-in** works out of the box with Supabase's built-in email, with two limits:
  - Supabase's built-in email only sends to members of your Supabase organisation, a few an hour.
    For relatives to sign in by email, connect your own sender under **Authentication → Emails →
    SMTP Settings** (a Gmail address with an app password is enough for a family; Brevo and Resend
    have free tiers). Until then, relatives should use **Continue with Google**.
  - The built-in email contains a sign-in **link**, which works when opened on the same device and
    browser the person asked from (Android and Chromebooks, including the installed app, and Safari
    on iPhone). It can't sign in the installed iPhone app, because email links open in Safari; the
    app says so and points iPhone users to Google. Once you have your own sender you can also edit
    **Authentication → Emails → Templates → Magic Link** to add `Your code: {{ .Token }}`; the app
    then accepts the 6-digit code too, which works everywhere. The template is shared with HomeQuest,
    so keep its existing link.

### 4. Push notifications

```bash
npx web-push generate-vapid-keys        # a new pair for this app
supabase secrets set PUSH_WEBHOOK_SECRET=<a long random string> \
  FAMILY_VAPID_PUBLIC_KEY=<public> FAMILY_VAPID_PRIVATE_KEY=<private> FAMILY_VAPID_SUBJECT=mailto:you@example.com
supabase functions deploy send-push --no-verify-jwt
```

Then **Database → Webhooks → Create**: table `family.notifications`, event **Insert**, type
*Supabase Edge Functions* → `send-push`, with an HTTP header `x-webhook-secret` set to the same secret.

### 5. Feeds, previews and podcast search

```bash
supabase secrets set CRON_SECRET=<another long random string> \
  PODCAST_INDEX_KEY=<key> PODCAST_INDEX_SECRET=<secret>     # free at https://api.podcastindex.org
supabase functions deploy poll-feeds --no-verify-jwt
supabase functions deploy lookup
```

Then **Database → Extensions**: enable `pg_cron` and `pg_net`, and run `supabase/schedule.sql` (fill
in the two values at the top; they go into Vault, not the file, and the script stops if you leave the
placeholders in). Fifteen minutes later, run the check queries at the bottom of that file: a wrong
secret shows up there as a 403, not as an error anywhere else. Without Podcast Index keys,
people can still follow a show by pasting its RSS link.

To bring Family Feed across, follow `supabase/import_family_feed.sql` (export two CSVs, upload, run).

### 6. Photos (on the Proxmox box)

1. Update Immich to the latest release (versions up to 3.1.0 leak locked assets through shared links;
   the gateway never makes shared links, but keep it patched anyway).
2. In Immich: **Account settings → API keys → New**, with only `asset.upload`, `asset.read`,
   `asset.view`, `asset.download`, `asset.delete`.
3. In Cloudflare Zero Trust: **Networks → Tunnels → Create**, copy the token, and add **one** public
   hostname (e.g. `photos.example.com`) pointing at `http://gateway:8080`. Never add one for Immich.
4. On the box: copy `gateway/` across, `cp .env.example .env`, fill it in, then `docker compose up -d`.
   `ALLOWED_ORIGINS` must be the app's exact address, e.g. `https://dunstandg.github.io` (the gateway
   refuses to start with `*`).
   `curl https://photos.example.com/health` should answer `{"ok":true}`.
5. Add `VITE_PHOTO_GATEWAY_URL=https://photos.example.com` to the GitHub Actions variables (step 8).
6. Upload a few real photos from an Android phone and an iPhone, download the originals from the
   viewer, and check `exiftool -gps:all -xmp:all <file>` prints nothing.

What the gateway does: checks the Supabase sign-in and family membership on every request; accepts
uploads only to your own album or update; strips location (EXIF GPS and XMP) from JPEG, PNG and WebP
before anything reaches Immich, and refuses formats it can't clean (HEIC); serves thumbnails, large
previews and originals by Family Network's own photo id only, so it can't be used to browse the rest
of the Immich library; zips up a person's own photos for "Download my photos"; and every ten minutes
moves photos whose posts were deleted into Immich's bin.

**Backups** (the Phase 3 gate): install `ops/backup/backup-db.sh` and `ops/backup/backup-photos.sh`
on the box with `/etc/family-backup.env` (see the top of each script), schedule them nightly, then do
the test restore in `ops/backup/RESTORE.md` and record it there. The photo backup mirrors, so it
refuses to run if the library disk isn't mounted, is empty, or has shrunk below 90% of last night's
copy (set `IMMICH_MOUNT` and `BACKUP_MOUNT` so it can check the mounts); run it once with `FORCE=1`
after a deliberate big clear-out.

### 7. Calendar and HomeQuest

Nothing to set up for voting itself. To connect HomeQuest:

1. 👪 → *Households*: tick **uses HomeQuest** for the home household (only one household can be linked).
2. Until the adapter is connected, events people add to HomeQuest are queued in
   `family.homequest_outbox`. When HomeQuest's schema is settled, edit
   `supabase/homequest_adapter.sql` (every guess is marked `REPLACE`), run it, then use the check
   and re-sync lines at its foot. The voting grid's "Busy at home" marks come from the same file.
   The adapter runs as a `family_bridge` role that can only write HomeQuest events and read their
   times, only for the HomeQuest household you name. If HomeQuest fails, the error is logged in
   `family.homequest_outbox` and voting, confirming and RSVPs carry on.

### 8. Deploy the app

In the GitHub repo: **Settings → Pages → Source: GitHub Actions**, then
**Settings → Secrets and variables → Actions → Variables** and add `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `VITE_VAPID_PUBLIC_KEY` and (once photos are running)
`VITE_PHOTO_GATEWAY_URL`. All are safe to expose; they end up in the built app. Pushing to `main`
builds, runs the tests and publishes.

### 9. Before inviting relatives: give the app its own address

On `github.io` the app shares an origin with HomeQuest, so HomeQuest's page code (or anything that
ever gets into it) could read this app's stored sign-in. Point a custom domain at GitHub Pages
(e.g. `family.example.com`: **Settings → Pages → Custom domain**), add an Actions variable `BASE_PATH` set to `/`, and update the Supabase redirect URL and the gateway's `ALLOWED_ORIGINS` to
match. Do this before the family signs in, so nobody has to sign in again.

### 10. Invite the family

Open the app → 👪 → *Invite someone*. Each link works once and expires after 7 days. People open it,
sign in with Google (or an emailed code), choose a name, and are walked through installing the app and
turning on notifications. On iPhone the app must be added to the Home Screen first; they'll sign in
once more from there.

## Develop

```bash
npm install
cp .env.example .env.local     # fill in the values
npm run dev                    # http://localhost:5173/FamilyNetwork/
npm test                       # database rules, feeds, gateway, app logic, push logic
npm run test:e2e               # browser smoke test with a mocked backend
```

## How it behaves

- **Roles.** Admins manage people and invites, pin and remove posts. Adults post, reply, react and can
  invite adults and children. Children can post, reply and react but cannot invite. Everyone is inside
  one family circle; there is no content outside it.
- **Edits.** Authors can edit their own posts and replies for 15 minutes; admins can delete or pin but
  never rewrite someone's words. All of this is enforced in the database, not just the interface.
- **Offline.** The last timeline is kept on the device. Posts and replies written offline wait in an
  outbox and send by themselves; each carries an id made on the device so nothing can post twice.
- **Notifications.** Mentions, replies, new albums, votes and plans, switchable per area. Muting is
  stored on the person's profile.
- **Sharing in.** On Android and Chromebooks, once the app is installed it appears in the share
  sheet: share a YouTube video, podcast episode or article and it opens ready to post. YouTube links
  become videos, podcast-app links and audio files become episodes, anything else becomes News.
- **iPhone Shortcut.** In the Shortcuts app: *New Shortcut* → turn on **Show in Share Sheet**
  (accepting URLs and text) → add **URL** with
  `https://<you>.github.io/FamilyNetwork/?share_url=` followed by the *Shortcut Input* variable → add
  **Open URLs**. Name it "Share to family". It then appears in the iPhone share sheet.
- **Feeds.** Shows and channels are followed by the whole family. Following one posts only its newest
  episode; after that, new ones (up to five a poll, from the last fortnight) are filed under that
  day's "New from your shows" card on Home, and listed individually in Podcasts and Videos, where
  each takes replies and reactions. Failing feeds back off; YouTube's intermittent 404s are retried
  quietly.
- **Podcasts.** One player for the whole app (it keeps playing as you change tabs, with lock-screen
  controls). Your place is saved on the device at once and to your account every 15 seconds.
- **Photos.** Albums, and single photos on updates. Uploads need a connection; thumbnails are kept on
  the device for offline viewing. Comments can be on the whole album or on one photo.
- **Calendar.** 2–6 dates and 1–4 places; Yes = 2, If needed = 1, No = 0; places scored by rank.
  Voting closes at the deadline or as soon as every adult has voted (children can vote but nobody
  waits for them), and the leader is confirmed; ties go the organiser's way, then the earliest date.
  The organiser can decide early, change the date later, or cancel; everyone is told. If nobody votes
  at all, the event is not confirmed: the organiser is told once and picks a date or cancels.
  Reminders go out from 9am the day before to everyone who hasn't said they can't come (not if the
  event was only confirmed after that point; the confirmation already said so). Everyone can add a
  confirmed event to their own calendar (.ics).

## Differences from the product spec

- Six tabs are Home, Photos, Podcasts, Videos, News, Calendar; **Updates** is a filter on Home rather
  than its own tab.
- Notification muting lives on `profiles.muted_kinds` (per person) instead of on each push subscription.
- Added a `notifications` table (written by triggers) so the 🔔 list and push share one source.
- Auto-posted episodes and videos are posts with no author, linked to a `digest` post through
  `posts.digest_id`, rather than living only in `feed_items`, so each can be replied to and resume
  positions attach to a post as the spec's `playback` table expects.
- `event_options` has a `kind` (slot or place); place votes store a `rank` instead of an answer.
  RSVPs are in `event_rsvps`; `events.homequest_event_id` holds the one household copy, with the
  people who opted in passed to HomeQuest as attendees.
- Shared links are sorted into Videos, Podcasts or News automatically; there is no separate "update
  with a link" any more (older ones still show).
- Confirmed events show in a "Coming up" list at the top of Home and Calendar rather than as a new
  post, so replies stay in one thread.
- HEIC photos are refused (the gateway can't promise to strip their location); iPhones send JPEG
  from the photo picker by default.
- **Not built:** the optional weekly email digest, and everything in the spec's "Later" column
  (polls, memories, face search, Shorts filter, listening-now, recurring events, travel times).

## Good to know

- The app shares the `github.io` address with HomeQuest. Its sign-in storage uses its own key, and the
  service worker is scoped to `/FamilyNetwork/`, so they don't interfere. A custom domain later would
  also isolate them completely (set `BASE_PATH=/`).
- The `anon` key is public by design; row-level security is what keeps data private. The service-role
  key lives only in Supabase's own functions and the gateway's `.env` on the box.
- Someone removed from the family loses photo access within 15 seconds (the gateway's sign-in cache),
  but photos their browser already downloaded stay on their device.
- The feed poller and link previews check every address, every redirect hop and, where the runtime
  supports it, what the name resolves to, so a link can't make them reach a private network.
- "Download my photos" builds each file in memory as it goes; fine for a family-sized library.

## Not yet checked against the live services

The database rules, feed parsing, location stripping, gateway checks and the whole app (against a
mocked backend) are tested here. These were written from the services' documentation and need a
first real run: PostgREST's embedding of the new tables (`src/data.js`), the Immich upload and
thumbnail API (`gateway/src/gateway.js`), the Podcast Index and YouTube lookups, and the
`schedule.sql` jobs.
