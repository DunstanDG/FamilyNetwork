// The body of each kind of post. PostCard picks one; header, reactions and replies are shared.
import { useState } from 'react';
import { usePlayer } from '../player.jsx';
import { openPost } from '../hooks.js';
import { dayLabel, length, progressLabel } from '../lib/media.js';
import { normaliseLink } from '../lib/timeline.js';
import { safeImage, youtubeEmbed, youtubeThumb } from '../lib/links.js';

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

// A link with its preview (title, picture, site). Falls back to just the address.
export function LinkPreview({ url, preview }) {
  const safe = normaliseLink(url);
  if (!safe) return null;
  const image = safeImage(preview?.image);
  const site = preview?.site || hostOf(safe);
  return (
    <a className={`linkcard ${image ? 'has-image' : ''}`} href={safe} target="_blank" rel="noopener noreferrer">
      {image && <img className="linkcard-img" src={image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      <span className="linkcard-text">
        <span className="linkcard-host">{preview?.title ? site : `🔗 ${site}`}</span>
        {preview?.title && <span className="linkcard-title">{preview.title}</span>}
        {preview?.description && <span className="linkcard-desc">{preview.description}</span>}
        {!preview?.title && <span className="linkcard-url">{safe}</span>}
      </span>
    </a>
  );
}

// YouTube: a thumbnail first (nothing loads from YouTube until you tap), then the player.
export function VideoBlock({ payload }) {
  const [on, setOn] = useState(false);
  const id = payload?.video_id;
  const title = payload?.title || payload?.preview?.title;
  const channel = payload?.source_title || payload?.preview?.site;
  if (!id) return <LinkPreview url={payload?.url} preview={payload?.preview} />;
  return (
    <div className="video">
      <div className="video-frame">
        {on ? (
          <iframe
            src={youtubeEmbed(id)} title={title || 'YouTube video'} allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button className="video-poster" onClick={() => setOn(true)} aria-label={`Play ${title || 'video'}`}>
            <img src={safeImage(payload?.image) || youtubeThumb(id)} alt="" loading="lazy" referrerPolicy="no-referrer" />
            <span className="play-badge" aria-hidden="true">▶</span>
          </button>
        )}
      </div>
      {(title || channel) && (
        <p className="media-caption">
          {title && <strong>{title}</strong>}
          {channel && <span>{channel}</span>}
        </p>
      )}
    </div>
  );
}

function PlayButton({ post, compact = false }) {
  const player = usePlayer();
  const playingThis = player?.current?.postId === post.id;
  if (!post.payload?.audio_url) return null;
  return (
    <button
      className={`primary play ${compact ? 'compact' : ''}`}
      onClick={() => (playingThis ? player.toggle() : player.play(post))}
      aria-label={playingThis && player.playing ? 'Pause' : `Play ${post.payload?.title || 'episode'}`}
    >
      {playingThis && player.playing ? '❚❚' : '▶'}{!compact && (playingThis && player.playing ? ' Pause' : ' Play')}
    </button>
  );
}

export function EpisodeBlock({ post }) {
  const p = post.payload || {};
  const [more, setMore] = useState(false);
  const image = safeImage(p.image || p.preview?.image);
  const title = p.title || p.preview?.title;
  const show = p.source_title || p.preview?.site;
  const where = progressLabel(post.playback?.[0], p.duration_seconds);
  const description = p.description || p.preview?.description;
  return (
    <div className="episode">
      <div className="episode-row">
        {image ? <img className="episode-art" src={image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="episode-art" aria-hidden="true">🎧</span>}
        <div className="episode-text">
          {title && <strong>{title}</strong>}
          <span className="when">{[show, length(p.duration_seconds), where].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      {description && (
        <p className={`episode-desc ${more ? 'open' : ''}`}>
          {description}{' '}
          {description.length > 140 && <button className="linkish" onClick={() => setMore((m) => !m)}>{more ? 'Less' : 'More'}</button>}
        </p>
      )}
      <div className="row wrap">
        <PlayButton post={post} />
        {p.url && normaliseLink(p.url) && (
          <a className="mini" href={normaliseLink(p.url)} target="_blank" rel="noopener noreferrer">
            {p.audio_url ? 'Show notes' : 'Listen in your podcast app'}
          </a>
        )}
      </div>
    </div>
  );
}

// "New from your shows": one card a day listing what the shows and channels the family follows put out.
export function DigestBlock({ post }) {
  const items = post.items || [];
  return (
    <div className="digest">
      <p className="digest-day">{dayLabel(post.payload?.day)}</p>
      {items.length === 0 && <p className="hint">Nothing new yet.</p>}
      <ul className="plain digest-list">
        {items.map((it) => {
          const p = it.payload || {};
          const image = safeImage(p.image) || (p.video_id ? youtubeThumb(p.video_id) : null);
          const replies = it.comments?.length || 0;
          const meta = [p.source_title, it.kind === 'podcast_episode' ? length(p.duration_seconds) : 'Video', progressLabel(it.playback?.[0], p.duration_seconds)]
            .filter(Boolean).join(' · ');
          return (
            <li key={it.id} className="digest-item">
              <button className="digest-open" onClick={() => openPost(it.id)}>
                {image
                  ? <img className={`digest-art ${it.kind === 'video' ? 'wide' : ''}`} src={image} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  : <span className="digest-art" aria-hidden="true">{it.kind === 'video' ? '▶️' : '🎧'}</span>}
                <span className="digest-text">
                  <strong>{p.title || 'Untitled'}</strong>
                  <small>{meta}{replies ? ` · 💬 ${replies}` : ''}</small>
                </span>
              </button>
              {it.kind === 'podcast_episode' && <PlayButton post={it} compact />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The face on a post with no author: the show's artwork, or an icon.
export function SourceFace({ post, size = 44 }) {
  const image = safeImage(post.payload?.source_image || (post.kind === 'podcast_episode' ? post.payload?.image : null));
  const style = { width: size, height: size };
  if (image) return <img className="avatar source" style={style} src={image} alt="" loading="lazy" referrerPolicy="no-referrer" />;
  const icon = post.kind === 'video' ? '▶️' : post.kind === 'digest' ? '📬' : '🎧';
  return <span className="avatar source icon" style={{ ...style, fontSize: size * 0.5 }} aria-hidden="true">{icon}</span>;
}
