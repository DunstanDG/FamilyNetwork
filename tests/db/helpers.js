// A real Postgres (PGlite) with a stub of Supabase's `auth` schema and every migration applied in
// order. `as(uid, fn)` runs `fn` inside a transaction as that signed-in person.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { expect } from 'vitest';

export const ADMIN = '00000000-0000-4000-8000-000000000001';
export const ADULT = '00000000-0000-4000-8000-000000000002';
export const CHILD = '00000000-0000-4000-8000-000000000003';
export const STRANGER = '00000000-0000-4000-8000-000000000004';
export const HOME = '10000000-0000-4000-8000-000000000001';

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);

export async function makeDb({ upTo = Infinity } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    create publication supabase_realtime;
  `);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (Number.parseInt(f, 10) > upTo) break;
    await db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  }
  return db;
}

export async function seedPeople(db) {
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ADMIN}', 'admin@example.com', '{"avatar_url":"https://example.com/a.png"}'),
      ('${ADULT}', 'adult@example.com', '{}'),
      ('${CHILD}', 'child@example.com', '{}'),
      ('${STRANGER}', 'stranger@example.com', '{"avatar_url":"https://example.com/s.png"}');
    insert into family.households (id, name) values ('${HOME}', 'Home');
    insert into family.profiles (id, display_name, role, household_id) values
      ('${ADMIN}', 'Admin', 'admin', '${HOME}'),
      ('${ADULT}', 'Adult', 'adult', null),
      ('${CHILD}', 'Child', 'child', '${HOME}');
  `);
}

export function actor(db) {
  async function as(uid, fn, role = 'authenticated') {
    return db.transaction(async (tx) => {
      if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      await tx.exec(`set local role ${role}`);
      return fn(tx);
    });
  }
  const rows = async (uid, sql, params = []) => (await as(uid, (tx) => tx.query(sql, params))).rows;
  // The service role (Edge Functions, the gateway): no signed-in person, RLS bypassed by grants.
  const service = async (sql, params = []) => (await as(null, (tx) => tx.query(sql, params), 'service_role')).rows;
  return { as, rows, service };
}

export const denied = (promise) => expect(promise).rejects.toThrow();
