-- Run once, in the Supabase SQL editor, to make yourself the first admin.
--
-- 1. Open the app and sign in once (it will say you need an invite - that's expected).
--    If you already sign in to HomeQuest with the same Google account you can skip this.
-- 2. Replace the two placeholders below and run it.
--
-- Nothing in this file is committed with real details: keep your own copy of the edited version.

with hh as (
  insert into family.households (name) values ('REPLACE: household name') returning id
)
insert into family.profiles (id, display_name, role, household_id)
select u.id, 'REPLACE: your name', 'admin', hh.id
from auth.users u, hh
where u.email = 'REPLACE: your-google-email@example.com';

-- Check it worked: should return one row with role = admin.
select id, display_name, role from family.profiles;
