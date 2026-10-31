-- Moving Family Feed's followed shows and likes into Family Network. Run once, after 0002_feeds.sql.
--
-- 1. Export from Family Feed two CSV files with these columns (headers must match):
--
--    follows.csv   kind,feed_url,title,email
--                  kind = podcast | youtube; email = who followed it (optional)
--                  For YouTube, feed_url must be https://www.youtube.com/feeds/videos.xml?channel_id=UC...
--
--    likes.csv     email,kind,item_url,title,feed_url,audio_url,published_at,liked
--                  kind = podcast | youtube | link; liked = true for a like, false for a dislike
--
-- 2. Supabase -> Table editor -> schema "family" -> ff_follows -> Insert -> Import data from CSV.
--    Same for ff_likes.
--
-- 3. Run the import. Follows become followed sources; each liked item becomes a post (no author,
--    dated when it came out, kept out of the daily digest) with a heart from everyone who liked it.
--    Dislikes are dropped. Running it again adds nothing twice.

select * from family.import_family_feed();

-- 4. Check, then empty the staging tables:
-- select kind, title, feed_url from family.sources order by created_at desc;
-- truncate family.ff_follows, family.ff_likes;
