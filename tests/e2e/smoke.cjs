// Browser smoke test: builds the app against a fake Supabase address, serves it, and drives the real
// UI in Chromium while this script plays the part of Supabase's REST API.
//
//   npx playwright install chromium     (once)
//   npm run test:e2e
//
// Screenshots land in test-results/screenshots.
// Drives the built app in Chromium against a mocked Supabase REST API.
const { chromium } = require('playwright');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const SHOTS = path.join(__dirname, '..', '..', 'test-results', 'screenshots');
require('fs').mkdirSync(SHOTS, { recursive: true });

const HOST = 'https://fake.supabase.test';
const PORT = 4179;
const APP = `http://localhost:${PORT}/FamilyNetwork/`;
const ME = { id: '00000000-0000-4000-8000-000000000001', display_name: 'Alex Morgan', avatar_url: null, role: 'admin', household_id: 'h1' };
const JAN = { id: '00000000-0000-4000-8000-000000000002', display_name: 'Jan', avatar_url: null, role: 'adult', household_id: null };
const JANE = { id: '00000000-0000-4000-8000-000000000003', display_name: 'Jane Smith', avatar_url: null, role: 'adult', household_id: null };
const ZOE = { id: '00000000-0000-4000-8000-000000000004', display_name: 'Zoë', avatar_url: null, role: 'child', household_id: 'h1' };
const members = [ME, JAN, JANE, ZOE];
const who = (p) => ({ id: p.id, display_name: p.display_name, avatar_url: p.avatar_url });
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

const profileRow = { ...ME, muted_kinds: [], last_seen_at: ago(120), created_at: ago(99999) };
let nextId = 100;
const cm = (id, post_id, by, body, min, parent_id = null) => ({ id, post_id, parent_id, author_id: by.id, body, mentions: [], created_at: ago(min), edited_at: null, author: who(by), reactions: [] });
const posts = [
  { id: 'p-pinned', author_id: ME.id, kind: 'update', body: 'Welcome to our new family space! Be kind, post often.', payload: {}, mentions: [], pinned: true, created_at: ago(60 * 24 * 9), edited_at: null, author: who(ME), reactions: [], comments: [] },
  { id: 'p-new1', author_id: JANE.id, kind: 'update', body: 'Photos from the beach are coming soon. Check https://example.com/trip for the plan.', payload: { link: { url: 'https://example.com/trip' } }, mentions: [], pinned: false, created_at: ago(30), edited_at: null, author: who(JANE), reactions: [{ id: 1, emoji: 'heart', user_id: JAN.id }], comments: [cm('c1', 'p-new1', JAN, 'Cannot wait!', 20), cm('c2', 'p-new1', ME, 'Same here', 10), cm('c2r', 'p-new1', JANE, 'See you there', 5, 'c1')] },
  { id: 'p-new2', author_id: JAN.id, kind: 'update', body: 'Anyone fancy Sunday lunch?', payload: {}, mentions: [], pinned: false, created_at: ago(90), edited_at: null, author: who(JAN), reactions: [], comments: ['a', 'b', 'c', 'd', 'e'].map((x, i) => cm(`m${x}`, 'p-new2', i % 2 ? JANE : ZOE, `Reply number ${i + 1}`, 80 - i)) },
  { id: 'p-old', author_id: ZOE.id, kind: 'update', body: 'Old news from last week.', payload: {}, mentions: [], pinned: false, created_at: ago(60 * 24 * 7), edited_at: null, author: who(ZOE), reactions: [], comments: [] },
];
const day = (d, h = 13) => { const t = new Date(); t.setUTCDate(t.getUTCDate() + d); t.setUTCHours(h, 0, 0, 0); return t.toISOString(); };
const VID = 'dQw4w9WgXcQ';
const base = (o) => ({ mentions: [], pinned: false, edited_at: null, digest_id: null, reactions: [], comments: [], playback: [], photos: [], event: null, ...o });
posts.forEach((p, i) => { posts[i] = base(p); });
posts.push(
  base({ id: 'p-digest', author_id: null, kind: 'digest', body: '', payload: { day: new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) }, created_at: ago(45), author: null }),
  base({ id: 'p-ep', author_id: null, kind: 'podcast_episode', body: '', digest_id: 'p-digest', created_at: ago(44), author: null,
    payload: { title: 'Roses in winter', source_title: 'Garden Hour', audio_url: 'https://cdn.fake.test/ep.mp3', duration_seconds: 1800, auto: true } }),
  base({ id: 'p-autovid', author_id: null, kind: 'video', body: '', digest_id: 'p-digest', created_at: ago(43), author: null,
    payload: { title: 'Making a chair', source_title: 'Woodwork Weekly', video_id: VID, auto: true } }),
  base({ id: 'p-vid', author_id: JAN.id, kind: 'video', body: 'You have to see this', created_at: ago(50), author: who(JAN),
    payload: { url: `https://youtu.be/${VID}`, video_id: VID, title: 'A classic', source_title: 'Rick' } }),
  base({ id: 'p-album', author_id: JANE.id, kind: 'photo_album', body: 'What a day', created_at: ago(55), author: who(JANE),
    payload: { title: 'Beach day' }, photos: [1, 2, 3].map((n) => ({ id: `60000000-0000-4000-8000-00000000000${n}`, width: 800, height: 600, taken_at: null, position: n, uploaded_by: JANE.id })) }),
  base({ id: 'p-vote', author_id: JANE.id, kind: 'event', body: 'Who is in?', created_at: ago(58), author: who(JANE), payload: { title: 'Sunday lunch' },
    event: { post_id: 'p-vote', title: 'Sunday lunch', deadline: day(4), status: 'voting', chosen_option_id: null, chosen_place_id: null, confirmed_at: null, rsvps: [],
      options: [
        { id: 'o-s1', kind: 'slot', starts_at: day(8), ends_at: null, place_name: null, place_url: null, position: 0, votes: [{ user_id: JAN.id, answer: 'yes' }] },
        { id: 'o-s2', kind: 'slot', starts_at: day(9), ends_at: null, place_name: null, place_url: null, position: 1, votes: [] },
        { id: 'o-p1', kind: 'place', starts_at: null, ends_at: null, place_name: "Nan's", place_url: null, position: 0, votes: [] },
        { id: 'o-p2', kind: 'place', starts_at: null, ends_at: null, place_name: 'The Swan', place_url: 'https://swan.fake.test', position: 1, votes: [] },
      ] } }),
  base({ id: 'p-party', author_id: ME.id, kind: 'event', body: '', created_at: ago(60 * 30), author: who(ME), payload: { title: 'Birthday tea' },
    event: { post_id: 'p-party', title: 'Birthday tea', deadline: ago(60), status: 'confirmed', chosen_option_id: 'q-s1', chosen_place_id: 'q-p1', confirmed_at: ago(60), rsvps: [{ user_id: JAN.id, answer: 'going', add_to_homequest: false }],
      options: [
        { id: 'q-s1', kind: 'slot', starts_at: day(3, 15), ends_at: day(3, 17), place_name: null, place_url: null, position: 0, votes: [] },
        { id: 'q-s2', kind: 'slot', starts_at: day(4, 15), ends_at: null, place_name: null, place_url: null, position: 1, votes: [] },
        { id: 'q-p1', kind: 'place', starts_at: null, ends_at: null, place_name: 'Our house', place_url: null, position: 0, votes: [] },
      ] } }),
);
const invites = [];
let netDown = false;
let profileMissing = false;
let inviteValid = true;
const log = [];
const gatewayAuth = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const failures = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); if (!ok) failures.push(name); };

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, body, status = 200, extra = {}) => route.fulfill({ status, contentType: 'application/json', headers: { ...cors, ...extra }, body: JSON.stringify(body) });

async function handle(route) {
  if (netDown) return route.abort('internetdisconnected');
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname;
  const q = url.searchParams;
  const method = req.method();
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const wantsObject = (req.headers().accept || '').includes('vnd.pgrst.object');
  const one = (rows) => (wantsObject ? (rows[0] ?? null) : rows);
  const body = () => { try { return JSON.parse(req.postData() || 'null'); } catch { return null; } };

  if (path.startsWith('/auth/v1/')) return json(route, {});
  if (path === '/rest/v1/profiles' && method === 'GET') {
    if (q.get('id')) return json(route, one(profileMissing ? [] : [profileRow]));
    return json(route, members);
  }
  if (path === '/rest/v1/profiles' && method === 'PATCH') { log.push({ m: 'PATCH profiles', b: body() }); return route.fulfill({ status: 204, headers: cors }); }
  if (path === '/rest/v1/rpc/peek_invite') return json(route, inviteValid);
  if (path === '/rest/v1/rpc/redeem_invite') {
    const b = body(); log.push({ m: 'RPC redeem', b });
    profileMissing = false; profileRow.display_name = b.p_display_name.trim(); profileRow.role = 'adult';
    return json(route, profileRow);
  }
  if (path === '/rest/v1/households') return json(route, [{ id: 'h1', name: 'Home', homequest_linked: true }]);
  if (path === '/functions/v1/lookup') {
    const b = body(); log.push({ m: 'lookup', b });
    if (b.action === 'preview') return json(route, { title: 'A classic', site: 'Rick', image: `https://i.ytimg.com/vi/${VID}/hqdefault.jpg`, video_id: VID });
    return json(route, { shows: [] });
  }
  if (path === '/rest/v1/sources') return json(route, [{ id: 's1', kind: 'podcast', feed_url: 'https://pod.fake.test/rss', title: 'Garden Hour', image_url: null, added_by: JAN.id, created_at: ago(9000), failures: 0 }]);
  if (path === '/rest/v1/events') {
    return json(route, posts.filter((p) => p.event?.status === 'confirmed').map((p) => ({ post_id: p.id, title: p.event.title,
      chosen: p.event.options.find((o) => o.id === p.event.chosen_option_id), place: p.event.options.find((o) => o.id === p.event.chosen_place_id) })));
  }
  if (path.startsWith('/rest/v1/rpc/')) {
    const b = body(); log.push({ m: `RPC ${path.slice(13)}`, b });
    if (path.endsWith('/cast_votes')) return json(route, 'voting');
    if (path.endsWith('/household_busy')) return json(route, [{ starts_at: day(9, 12), ends_at: day(9, 16) }]);
    return json(route, null);
  }
  if (path === '/rest/v1/notifications') {
    if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...cors, 'content-range': '*/2' } });
    return json(route, [{ id: 1, kind: 'mention', module: 'update', post_id: 'p-new1', comment_id: null, snippet: 'hello there', created_at: ago(5), read_at: null, actor: who(JANE) }]);
  }
  if (path === '/rest/v1/notifications' && method === 'PATCH') return route.fulfill({ status: 204, headers: cors });
  if (path === '/rest/v1/posts' && method === 'GET') {
    let rows = posts.filter((p) => {
      if (q.get('id')) return p.id === q.get('id').replace('eq.', '');
      if (q.get('digest_id')?.startsWith('in.')) return Boolean(p.digest_id) && q.get('digest_id').includes(p.digest_id);
      if (q.get('digest_id') === 'is.null' && p.digest_id) return false;
      if (q.get('pinned') === 'eq.true' && !p.pinned) return false;
      if (q.get('pinned') === 'eq.false' && p.pinned) return false;
      if (q.get('kind') && p.kind !== q.get('kind').replace('eq.', '')) return false;
      return true;
    }).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    if (q.get('limit')) rows = rows.slice(0, Number(q.get('limit')));
    return json(route, q.get('id') ? one(rows) : rows);
  }
  if (path === '/rest/v1/posts' && method === 'POST') {
    const b = body(); log.push({ m: 'POST posts', b });
    posts.push(base({ ...b, author_id: ME.id, created_at: new Date().toISOString(), author: who(ME) }));
    return route.fulfill({ status: 201, headers: cors });
  }
  if (path === '/rest/v1/comments' && method === 'POST') {
    const b = body(); log.push({ m: 'POST comments', b });
    const post = posts.find((p) => p.id === b.post_id);
    post.comments.push({ ...b, author_id: ME.id, created_at: new Date().toISOString(), edited_at: null, author: who(ME), reactions: [] });
    return route.fulfill({ status: 201, headers: cors });
  }
  if (path === '/rest/v1/reactions' && method === 'POST') {
    const b = body(); log.push({ m: 'POST reactions', b });
    posts.find((p) => p.id === b.post_id)?.reactions.push({ id: ++nextId, emoji: b.emoji, user_id: ME.id });
    return route.fulfill({ status: 201, headers: cors });
  }
  if (path === '/rest/v1/reactions' && method === 'DELETE') {
    log.push({ m: 'DELETE reactions', q: url.search });
    const post = posts.find((p) => p.id === q.get('post_id')?.replace('eq.', ''));
    if (post) post.reactions = post.reactions.filter((r) => !(r.user_id === ME.id && r.emoji === q.get('emoji').replace('eq.', '')));
    return route.fulfill({ status: 204, headers: cors });
  }
  if (path === '/rest/v1/invites' && method === 'POST') {
    const b = body(); log.push({ m: 'POST invites', b });
    const row = { code: 'abc123def456abc123def456abc123de', created_by: ME.id, role: b.role, household_id: b.household_id, note: b.note, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(), used_by: null, used_at: null };
    invites.push(row);
    return json(route, wantsObject ? row : [row], 201);
  }
  if (path === '/rest/v1/invites' && method === 'GET') return json(route, invites);
  return json(route, []);
}

(async () => {
  const env = { ...process.env, VITE_SUPABASE_URL: HOST, VITE_SUPABASE_ANON_KEY: 'anon-key', VITE_VAPID_PUBLIC_KEY: 'BPlaceholderKey', VITE_PHOTO_GATEWAY_URL: 'https://photos.fake.test' };
  const build = spawnSync('npx', ['vite', 'build', '--outDir', 'dist-e2e'], { env, encoding: 'utf8', cwd: path.join(__dirname, '..', '..') });
  if (build.status !== 0) { console.error(build.stdout, build.stderr); process.exit(2); }
  const server = spawn('npx', ['vite', 'preview', '--outDir', 'dist-e2e', '--port', String(PORT), '--strictPort'], { cwd: path.join(__dirname, '..', '..'), stdio: 'ignore', env });
  const stop = () => { try { server.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fetch(APP)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  await context.route(`${HOST}/**`, handle);
  await context.route('https://photos.fake.test/**', (route) => {
    gatewayAuth.push(route.request().headers().authorization || '');
    route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: PNG });
  });
  await context.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await context.route('https://cdn.fake.test/**', (route) => route.fulfill({ status: 404, body: '' }));
  await context.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>player</p>' }));
  const jwt = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: ME.id, exp: 4102444800, role: 'authenticated' })).toString('base64url')}.sig`;
  const session = { access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: { id: ME.id, aud: 'authenticated', email: 'alex@example.com', app_metadata: {}, user_metadata: { full_name: 'Alex Morgan' }, created_at: ago(1) } };
  await context.addInitScript(([s]) => {
    localStorage.setItem('family-network-auth', JSON.stringify(s));
    localStorage.setItem('fn-onboarded-v1', '1');
  }, [session]);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|websocket|ERR_NAME|net::|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

  await page.goto(APP);
  await page.waitForSelector('.post', { timeout: 15000 });

  // --- first render
  check('header shows the app name', await page.locator('.top h1').innerText() === 'Family Network');
  check('six tabs in the bottom nav', await page.locator('.tabs button').count() === 6);
  check('pinned post comes first', (await page.locator('.post').first().getAttribute('class')).includes('pinned'));
  check('posts are newest first after the pin', (await page.locator('.post').nth(1).innerText()).includes('beach'));
  check('unread line is shown with the right count', (await page.locator('.unread-line').innerText()).startsWith('6 new'), await page.locator('.unread-line').innerText());
  const idx = await page.evaluate(() => [...document.querySelectorAll('.timeline > .post, .timeline > div > .post, .unread-line')].map((e) => (e.classList.contains('unread-line') ? 'LINE' : e.id)).join(','));
  check('unread line sits above the first post already seen', idx.startsWith('p-p-pinned,p-p-new1,') && idx.endsWith('p-p-new2,LINE,p-p-party,p-p-old'), idx);
  check('auto-posted episodes stay inside the daily digest on Home', idx.includes('p-p-digest') && !idx.includes('p-p-ep') && !idx.includes('p-p-autovid'), idx);
  check('link in a post becomes a clickable link', await page.locator('#p-p-new1 .text a[href="https://example.com/trip"]').count() === 1);
  check('link card is shown for an attached link', await page.locator('#p-p-new1 .linkcard').count() === 1);
  check('short thread opens by itself', await page.locator('#p-p-new1 .comment').count() === 3);
  check('long thread (5 replies) is collapsed', await page.locator('#p-p-new2 .comment').count() === 0 && (await page.locator('#p-p-new2 .post-actions .mini').innerText()).includes('5 replies'));
  check('reply is nested under its parent', await page.locator('#p-p-new1 .comments.nested .comment').count() === 1);
  check('notification bell shows unread count', (await page.locator('.dot').innerText()) === '2');
  await page.screenshot({ path: `${SHOTS}/1-home.png` });

  // --- expand a long thread
  await page.locator('#p-p-new2 .post-actions .mini').click();
  check('expanding shows all 5 replies', await page.locator('#p-p-new2 .comment').count() === 5);

  // --- reactions
  const heart = page.locator('#p-p-new2 > .post-actions .react').first();
  await heart.click();
  await page.waitForTimeout(200);
  check('reaction toggles on immediately', (await heart.getAttribute('aria-pressed')) === 'true');
  check('reaction was sent to the server', log.some((l) => l.m === 'POST reactions' && l.b.post_id === 'p-new2' && l.b.emoji === 'heart'));
  await heart.click();
  await page.waitForTimeout(300);
  check('tapping again removes it', log.some((l) => l.m === 'DELETE reactions') && (await heart.getAttribute('aria-pressed')) === 'false');

  // --- composing with a mention (keyboard only)
  const box = page.locator('.composer textarea');
  await box.click();
  await box.type('Lunch sounds great @Ja');
  check('typing @ suggests matching family members', await page.locator('.mention-list button').count() === 2, `${await page.locator('.mention-list button').count()}`);
  check('suggestions exclude yourself', !(await page.locator('.mention-list').innerText()).includes('Alex'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  check('Enter completes the mention', (await box.inputValue()) === 'Lunch sounds great @Jane Smith ', await box.inputValue());
  await box.type('and @Jan!');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  const before5 = await page.locator('.post').count();
  await page.waitForFunction((n) => document.querySelectorAll('.post').length === n + 1, before5, { timeout: 8000 });
  const sent = log.find((l) => l.m === 'POST posts');
  check('post sent as an update with a client id', sent?.b.kind === 'update' && /^[0-9a-f-]{36}$/.test(sent.b.id));
  check('mentions were worked out from the text', JSON.stringify(sent.b.mentions.sort()) === JSON.stringify([JAN.id, JANE.id].sort()), JSON.stringify(sent.b.mentions));
  check('author is not sent by the client', !('author_id' in sent.b));
  check('composer clears after posting', (await box.inputValue()) === '');
  check('new post appears in the timeline with highlighted mentions', await page.locator('.post .mention').count() >= 2);

  // --- reply on a post
  const replyBox = page.locator('#p-p-new1 .reply-box textarea');
  await replyBox.click();
  await replyBox.fill('Looking forward to it');
  await page.locator('#p-p-new1 .reply-box .primary').click();
  await page.waitForFunction(() => document.querySelectorAll('#p-p-new1 .comment').length === 4, null, { timeout: 8000 });
  const c = log.find((l) => l.m === 'POST comments');
  check('reply sent to the right post, top-level', c?.b.post_id === 'p-new1' && c.b.parent_id === null);

  // --- reply to a specific comment
  await page.locator('#p-p-new1 .comment-group').first().locator('button:has-text("Reply")').first().click();
  check('replying to someone pre-fills their @name', (await page.locator('#p-p-new1 .reply-box textarea').inputValue()).startsWith('@Jan '), await page.locator('#p-p-new1 .reply-box textarea').inputValue());
  await page.locator('#p-p-new1 .reply-box textarea').type('me too');
  await page.locator('#p-p-new1 .reply-box .primary').click();
  await page.waitForFunction(() => document.querySelectorAll('#p-p-new1 .comments.nested .comment').length === 2, null, { timeout: 8000 });
  const c2 = log.filter((l) => l.m === 'POST comments')[1];
  check('nested reply carries its parent id', c2?.b.parent_id === 'c1', JSON.stringify(c2?.b));
  await page.screenshot({ path: `${SHOTS}/2-thread.png`, fullPage: false });

  // --- offline: write, queue, come back, send
  const before = log.filter((l) => l.m === 'POST posts').length;
  netDown = true; await context.setOffline(true);
  await page.waitForFunction(() => document.querySelector('.offline'));
  check('offline banner appears', true);
  await box.fill('Written with no signal');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForSelector('.post.pending', { timeout: 8000 });
  check('offline post shows as sending', (await page.locator('.post.pending').innerText()).includes('Written with no signal'));
  check('offline user is told it is saved', (await page.locator('.composer .msg').innerText()).toLowerCase().includes('offline'));
  check('nothing was sent while offline', log.filter((l) => l.m === 'POST posts').length === before);
  await page.screenshot({ path: `${SHOTS}/3-offline.png` });
  netDown = false; await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('.post.pending'), null, { timeout: 10000 });
  check('queued post is sent automatically on reconnect', log.filter((l) => l.m === 'POST posts').length === before + 1);
  check('and shows as a normal post', (await page.locator('.timeline').innerText()).includes('Written with no signal'));

  // --- saved copy of the timeline is used while offline
  await page.locator('.tabs button', { hasText: 'News' }).click();
  netDown = true; await context.setOffline(true);
  await page.locator('.tabs button', { hasText: 'Home' }).click();
  await page.waitForSelector('.post', { timeout: 8000 });
  await page.waitForFunction(() => document.body.innerText.includes('Showing what was saved on this device'), null, { timeout: 8000 });
  check('offline: timeline still readable from the saved copy', (await page.locator('.timeline').innerText()).includes('Anyone fancy Sunday lunch'));
  check('offline: person is told it is a saved copy', true);
  netDown = false; await context.setOffline(false);
  await page.waitForFunction(() => !document.body.innerText.includes('Showing what was saved on this device'), null, { timeout: 8000 });
  check('back online: notice goes away', true);

  // --- phase 2: digest, videos, podcasts, sharing a link
  check('digest card lists what the shows put out', (await page.locator('#p-p-digest').innerText()).includes('New from your shows')
    && await page.locator('#p-p-digest .digest-item').count() === 2);
  await page.locator('#p-p-vid .video-poster').click();
  check('a shared video plays in place (privacy-friendly embed)', (await page.locator('#p-p-vid iframe').getAttribute('src')).startsWith(`https://www.youtube-nocookie.com/embed/${VID}`));
  await page.locator('#p-p-digest .digest-item .play').first().click();
  await page.waitForSelector('.mini-player');
  check('tapping play on an episode opens the mini player', (await page.locator('.mini-player').innerText()).includes('Roses in winter'));
  check('the player is loading the episode', (await page.evaluate(() => document.querySelector('audio').src)) === 'https://cdn.fake.test/ep.mp3');
  await page.screenshot({ path: `${SHOTS}/2b-feeds.png` });
  await page.locator('.mini-player button[aria-label="Stop and close player"]').click();
  await page.waitForFunction(() => !document.querySelector('.mini-player'), null, { timeout: 5000 }).catch(() => {});
  check('the player can be closed', await page.locator('.mini-player').count() === 0);

  await page.locator('.tabs button', { hasText: 'Videos' }).click();
  await page.waitForSelector('.composer input[type=url]');
  check('Videos tab lists every video, including auto-posted ones', await page.locator('#p-p-autovid').count() === 1 && await page.locator('#p-p-vid').count() === 1);
  await page.locator('.composer input[type=url]').fill(`https://www.youtube.com/watch?v=${VID}`);
  await page.waitForSelector('.composer .linkcard-title', { timeout: 8000 });
  check('pasting a link fetches a preview', (await page.locator('.composer-preview').innerText()).includes('A classic') && (await page.locator('.composer-preview .badge').innerText()) === 'Video');
  await page.locator('.composer textarea').fill('Another one');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.post').length >= 3, null, { timeout: 8000 });
  const shared = log.filter((l) => l.m === 'POST posts').pop();
  check('a YouTube link is posted as a video with its id and title', shared?.b.kind === 'video' && shared.b.payload.video_id === VID && shared.b.payload.title === 'A classic', JSON.stringify(shared?.b));
  await page.getByRole('button', { name: /Channels we follow/ }).click();
  check('Videos tab offers following a channel', (await page.locator('.sheet h2').innerText()) === 'Channels we follow');
  await page.keyboard.press('Escape');

  await page.locator('.tabs button', { hasText: 'Podcasts' }).click();
  await page.waitForSelector('#p-p-ep');
  check('Podcasts tab shows episodes with a play button', await page.locator('#p-p-ep .play').count() === 1);
  await page.getByRole('button', { name: /Shows we follow/ }).click();
  await page.waitForSelector('.sheet .source-row');
  check('followed shows are listed with who added them', (await page.locator('.sheet .source-row').first().innerText()).includes('Garden Hour'));
  await page.keyboard.press('Escape');
  check('composer is only a link box away from Home', await page.locator('.composer input[type=url]').count() === 1);

  // --- phase 3: photos
  await page.locator('.tabs button', { hasText: 'Photos' }).click();
  await page.waitForSelector('#p-p-album .album-cell img', { timeout: 8000 });
  check('album shows its photos through the gateway', await page.locator('#p-p-album .album-cell').count() === 3);
  check('every photo request carries the sign-in', gatewayAuth.length >= 3 && gatewayAuth.every((a) => a.startsWith('Bearer ')));
  check('Photos tab offers a new album', await page.getByRole('button', { name: /New album/ }).count() === 1);
  await page.locator('#p-p-album .album-cell').nth(1).click();
  await page.waitForSelector('.viewer');
  check('viewer opens on the photo tapped', (await page.locator('.viewer-top').innerText()).startsWith('2 / 3'));
  await page.keyboard.press('ArrowRight');
  check('arrow keys move between photos', (await page.locator('.viewer-top').innerText()).startsWith('3 / 3'));
  await page.locator('.viewer textarea').fill('Gorgeous');
  await page.locator('.viewer button', { hasText: 'Send' }).click();
  await page.waitForTimeout(400);
  const pc = log.filter((l) => l.m === 'POST comments').pop();
  check('a comment in the viewer is about that one photo', pc?.b.photo_asset_id === '60000000-0000-4000-8000-000000000003', JSON.stringify(pc?.b));
  await page.screenshot({ path: `${SHOTS}/2c-viewer.png` });
  await page.keyboard.press('Escape');
  check('Escape closes the viewer', await page.locator('.viewer').count() === 0);

  // --- phase 4: calendar
  await page.locator('.tabs button', { hasText: 'Calendar' }).click();
  await page.waitForSelector('#p-p-vote .vote-row');
  check('coming-up list shows the confirmed event', (await page.locator('.upcoming').innerText()).includes('Birthday tea'));
  check('voting grid lists the dates and places', await page.locator('#p-p-vote .vote-row').count() === 4);
  check('the leading date is marked', (await page.locator('#p-p-vote .vote-row.best').first().innerText()).includes('Leading'));
  check('household busy times are shown on the grid', await page.locator('#p-p-vote .busy-chip').count() === 1);
  await page.locator('#p-p-vote .vote-row').nth(1).getByRole('button', { name: /Yes/ }).click();
  await page.locator('#p-p-vote .vote-row').nth(0).getByRole('button', { name: /If needed/ }).click();
  await page.locator('#p-p-vote .rank-btn', { hasText: 'The Swan' }).click();
  await page.locator('#p-p-vote .rank-btn', { hasText: "Nan's" }).click();
  check('tapping places ranks them in order', (await page.locator('#p-p-vote .rank-btn', { hasText: 'The Swan' }).innerText()).startsWith('1'));
  await page.locator('#p-p-vote').getByRole('button', { name: 'Save my votes' }).click();
  await page.waitForTimeout(300);
  const votes = log.filter((l) => l.m === 'RPC cast_votes').pop()?.b;
  const byOpt = Object.fromEntries((votes?.p_votes || []).map((v) => [v.option_id, v.answer || v.rank]));
  check('votes are sent together', votes?.p_event === 'p-vote' && byOpt['o-s1'] === 'if_needed' && byOpt['o-s2'] === 'yes' && byOpt['o-p2'] === 1 && byOpt['o-p1'] === 2, JSON.stringify(votes));
  await page.screenshot({ path: `${SHOTS}/2d-voting.png`, fullPage: true });

  await page.locator('#p-p-party').getByRole('button', { name: /Going/ }).click();
  await page.waitForTimeout(300);
  const r = log.filter((l) => l.m === 'RPC rsvp').pop()?.b;
  check('RSVP is sent, not added to HomeQuest by default', r?.p_event === 'p-party' && r.p_answer === 'going' && r.p_add_to_homequest === false, JSON.stringify(r));
  check('a child in the household can be answered for', await page.locator('#p-p-party .kid-row', { hasText: 'Zoë' }).count() === 1);
  check('confirmed events offer an .ics invite', await page.locator('#p-p-party').getByRole('button', { name: /Add to my calendar/ }).count() === 1);
  await page.getByRole('button', { name: /Plan something/ }).click();
  check('Calendar tab offers planning something', (await page.locator('.sheet h2').innerText()) === 'Plan something');
  await page.keyboard.press('Escape');
  check('composer only on Home', await page.locator('.composer').count() === 0);
  await page.locator('.tabs button', { hasText: 'Home' }).click();

  // --- family sheet and invites
  await page.getByRole('button', { name: 'Our family' }).click();
  await page.waitForSelector('.sheet');
  check('family sheet lists members', await page.locator('.sheet .person-col').count() === 4);
  check('admin sees role controls and remove', await page.locator('.sheet .admin-row').count() === 4);
  await page.locator('#inv-note').fill('Nan');
  await page.locator('#inv-role').selectOption('child');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await page.waitForSelector('.invite input');
  const link = await page.locator('.invite input').inputValue();
  check('invite link points at the app with the code', link === `${APP}?invite=abc123def456abc123def456abc123de`, link);
  check('invite request carried role and label', log.some((l) => l.m === 'POST invites' && l.b.role === 'child' && l.b.note === 'Nan'));
  check('WhatsApp share link is offered', await page.locator('.invite a[href^="https://wa.me/"]').count() === 1);
  await page.screenshot({ path: `${SHOTS}/4-family.png` });
  await page.keyboard.press('Escape');
  check('Escape closes the sheet', await page.locator('.sheet').count() === 0);

  // --- notifications sheet
  await page.getByRole('button', { name: /Notifications/ }).click();
  await page.waitForSelector('.alert-row');
  check('notifications list who did what', (await page.locator('.alert-row').first().innerText()).includes('Jane Smith mentioned you'), await page.locator('.alert-row').first().innerText());
  await page.locator('.alert-row').first().click();
  await page.waitForSelector('.sheet #p-p-new1');
  check('tapping a notification opens that post', true);
  await page.keyboard.press('Escape');

  // --- settings
  await page.getByRole('button', { name: 'Your settings' }).click();
  check('settings shows name and role', (await page.locator('.me').innerText()).includes('Alex Morgan'));
  await page.screenshot({ path: `${SHOTS}/5-settings.png` });


  // ================= a brand-new relative =================
  // 1. Opens the invite link while signed out.
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await anon.route(`${HOST}/**`, handle);
  const p1 = await anon.newPage();
  await p1.goto(`${APP}?invite=abc123`);
  await p1.waitForSelector('.center');
  check('signed-out screen offers Google sign-in', await p1.getByRole('button', { name: 'Continue with Google' }).count() === 1);
  await p1.waitForSelector('.msg.ok');
  check('a valid invite is acknowledged', (await p1.locator('.msg.ok').innerText()).includes('invited'));
  check('invite code is kept and removed from the address bar', !p1.url().includes('invite=') && (await p1.evaluate(() => localStorage.getItem('fn-invite'))) === 'abc123');
  await p1.getByRole('button', { name: 'Use my email instead' }).click();
  check('email option asks for an address', await p1.locator('#email').count() === 1);
  await p1.screenshot({ path: `${SHOTS}/6-signin.png` });
  const expired = await anon.newPage();
  inviteValid = false;
  await expired.goto(`${APP}?invite=old`);
  await expired.waitForSelector('.msg.error');
  check('an expired invite is explained', (await expired.locator('.msg.error').innerText()).includes('expired'));
  inviteValid = true;
  await expired.close();
  await anon.close();

  // 2. Signs in (Google), has no profile yet, joins, and is walked through setup.
  profileMissing = true;
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await fresh.route(`${HOST}/**`, handle);
  await fresh.addInitScript(([s]) => { localStorage.setItem('family-network-auth', JSON.stringify(s)); localStorage.setItem('fn-invite', 'abc123'); }, [session]);
  const p2 = await fresh.newPage();
  await p2.goto(APP);
  await p2.waitForSelector('#name');
  check('join screen suggests the name from their Google account', (await p2.locator('#name').inputValue()) === 'Alex Morgan');
  await p2.locator('#name').fill('  Nan  ');
  await p2.getByRole('button', { name: 'Join the family' }).click();
  await p2.waitForSelector('.onboarding');
  check('joining sends the invite code and trimmed name', log.some((l) => l.m === 'RPC redeem' && l.b.p_code === 'abc123' && l.b.p_display_name.trim() === 'Nan'));
  check('invite code is cleared once used', (await p2.evaluate(() => localStorage.getItem('fn-invite'))) === null);
  check('onboarding starts with installing', (await p2.locator('.onboarding h2').innerText()).includes('Install'));
  await p2.getByRole('button', { name: 'Continue' }).click();
  check('then offers notifications with per-area choices', (await p2.locator('.onboarding h2').innerText()).includes('Stay in the loop') && await p2.locator('.onboarding .toggle').count() === 6);
  await p2.screenshot({ path: `${SHOTS}/7-onboarding.png` });
  await p2.getByRole('button', { name: 'Not now' }).click();
  check('and finishes with a welcome', (await p2.locator('.onboarding h2').innerText()).includes('all set, Nan'));
  await p2.getByRole('button', { name: 'Go to the family timeline' }).click();
  await p2.waitForSelector('.post');
  check('onboarding is not shown again on this device', (await p2.evaluate(() => localStorage.getItem('fn-onboarded-v1'))) === '1' && await p2.locator('.onboarding').count() === 0);
  await fresh.close();

  // 3. Someone signed in but never invited.
  profileMissing = true; inviteValid = false;
  const stranger = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await stranger.route(`${HOST}/**`, handle);
  await stranger.addInitScript(([s]) => { localStorage.setItem('family-network-auth', JSON.stringify(s)); }, [session]);
  const p3 = await stranger.newPage();
  await p3.goto(APP);
  await p3.waitForSelector('.msg.error');
  check('uninvited people are told it is private and cannot see anything', (await p3.locator('.msg.error').innerText()).includes('invite') && await p3.locator('.post').count() === 0 && await p3.locator('#name').count() === 0);
  await stranger.close();

  // ================= sharing from another app =================
  const sharer = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await sharer.route(`${HOST}/**`, handle);
  profileMissing = false;
  await sharer.addInitScript(([s]) => { localStorage.setItem('family-network-auth', JSON.stringify(s)); localStorage.setItem('fn-onboarded-v1', '1'); }, [session]);
  const p4 = await sharer.newPage();
  await p4.goto(`${APP}?share_title=Video&share_text=${encodeURIComponent(`Look at this https://youtu.be/${VID}`)}`);
  await p4.waitForSelector('.sheet .composer');
  check('a link shared from another app opens ready to post', (await p4.locator('.sheet .composer input[type=url]').inputValue()) === `https://youtu.be/${VID}`
    && (await p4.locator('.sheet .composer textarea').inputValue()) === 'Look at this');
  check('and the address bar is tidied', !p4.url().includes('share_'));
  await sharer.close();

  check('no page errors or unexpected console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
