// Sends a Web Push to a person when a row is added to family.notifications.
//
// Wire-up (see README): a Database Webhook on INSERT into family.notifications calls this function
// with an `x-webhook-secret` header. Deploy with:  supabase functions deploy send-push --no-verify-jwt
//
// Secrets: PUSH_WEBHOOK_SECRET, FAMILY_VAPID_PUBLIC_KEY, FAMILY_VAPID_PRIVATE_KEY, FAMILY_VAPID_SUBJECT
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { buildPayload, isMuted, safeEqual, type Notification } from './logic.ts';

const secret = Deno.env.get('PUSH_WEBHOOK_SECRET') ?? '';

Deno.serve(async (req) => {
  if (!secret || !safeEqual(req.headers.get('x-webhook-secret') ?? '', secret)) {
    return new Response('Forbidden', { status: 403 });
  }

  const event = await req.json().catch(() => null);
  if (event?.type !== 'INSERT' || event?.table !== 'notifications') return new Response('Ignored');
  const n = event.record as Notification & { id: number; user_id: string; actor_id: string | null };

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    db: { schema: 'family' },
    auth: { persistSession: false },
  });

  const [{ data: person }, { data: actor }, { data: subs }] = await Promise.all([
    db.from('profiles').select('muted_kinds').eq('id', n.user_id).maybeSingle(),
    n.actor_id ? db.from('profiles').select('display_name').eq('id', n.actor_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from('push_subscriptions').select('id, endpoint, keys').eq('user_id', n.user_id),
  ]);

  if (!person || !subs?.length || isMuted(person.muted_kinds, n.module)) return new Response('Nothing to send');

  webpush.setVapidDetails(
    Deno.env.get('FAMILY_VAPID_SUBJECT')!,
    Deno.env.get('FAMILY_VAPID_PUBLIC_KEY')!,
    Deno.env.get('FAMILY_VAPID_PRIVATE_KEY')!,
  );

  const body = JSON.stringify(buildPayload(n, actor?.display_name));
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 60 * 60 * 24 });
      sent += 1;
    } catch (e) {
      // 404/410 mean the device has unsubscribed or the app was uninstalled: forget it.
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from('push_subscriptions').delete().eq('id', s.id);
      else console.error('push failed', e?.statusCode, e?.body);
    }
  }));

  return new Response(`Sent ${sent}`);
});
