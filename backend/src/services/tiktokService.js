const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const TIKTOK_URL_PATTERN =
  /tiktok\.com\/(?:@[\w.-]+\/video\/|v\/|t\/)([\d]+)/i;

const TIKTOK_SHORT_PATTERN = /(?:vm|vt)\.tiktok\.com\/([\w]+)/i;

export function extractTikTokVideoId(url) {
  const cleaned = url.split('?')[0].split('#')[0];

  const direct = cleaned.match(TIKTOK_URL_PATTERN);
  if (direct) return { videoId: direct[1], canonicalUrl: cleaned };

  const short = cleaned.match(TIKTOK_SHORT_PATTERN);
  if (short) return { videoId: null, canonicalUrl: cleaned, isShort: true };

  throw new Error(
    'Invalid TikTok URL. Use a link like tiktok.com/@user/video/1234567890 or vm.tiktok.com/...'
  );
}

async function resolveShortUrl(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': MOBILE_UA },
    redirect: 'follow',
  });
  return response.url;
}

function findInObject(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 15) return null;
  if (key in obj) return obj[key];

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findInObject(value, key, depth + 1);
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}

function parseHydrationData(html) {
  const universalMatch = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (universalMatch) {
    try {
      return JSON.parse(universalMatch[1]);
    } catch {
      // fall through
    }
  }

  const sigiMatch = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (sigiMatch) {
    try {
      return JSON.parse(sigiMatch[1]);
    } catch {
      // fall through
    }
  }

  return null;
}

function extractVideoFromHydration(data) {
  const detail =
    data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct ||
    findInObject(data, 'itemStruct') ||
    findInObject(data, 'videoData');

  if (!detail) return null;

  const video = detail.video || detail;
  const playAddr = video.playAddr || video.downloadAddr;
  const playUrl = typeof playAddr === 'string' ? playAddr : playAddr?.url_list?.[0];

  if (!playUrl) return null;

  const bitrateInfo = video.bitrateInfo || video.bit_rate || [];
  const formats = [];

  if (Array.isArray(bitrateInfo) && bitrateInfo.length) {
    for (const br of bitrateInfo) {
      const url = br.PlayAddr?.UrlList?.[0] || br.play_addr?.url_list?.[0];
      if (!url) continue;
      formats.push({
        url,
        width: br.PlayAddr?.Width || br.play_addr?.width || video.width,
        height: br.PlayAddr?.Height || br.play_addr?.height || video.height,
        bitrate: br.Bitrate || br.bit_rate,
      });
    }
  }

  if (!formats.length && playUrl) {
    formats.push({
      url: playUrl,
      width: video.width,
      height: video.height,
      bitrate: video.bitrate,
    });
  }

  return {
    videoId: detail.id || detail.aweme_id || video.id,
    title: detail.desc || detail.title || 'TikTok video',
    author: detail.author?.uniqueId || detail.author?.nickname || null,
    duration: detail.video?.duration || video.duration,
    thumbnail: detail.video?.cover || detail.video?.originCover || video.cover,
    viewCount: detail.stats?.playCount || detail.playCount,
    formats,
  };
}

async function fetchViaPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`TikTok returned ${response.status}. The video may be private or unavailable.`);
  }

  const html = await response.text();
  const data = parseHydrationData(html);
  if (!data) {
    throw new Error('Could not parse TikTok page data. The video may be private or region-restricted.');
  }

  const media = extractVideoFromHydration(data);
  if (!media?.formats?.length) {
    throw new Error('No video stream found. This post may be a slideshow or unavailable in your region.');
  }

  return media;
}

async function fetchViaOembed(url) {
  const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const response = await fetch(oembedUrl, {
    headers: { 'User-Agent': UA },
  });

  if (!response.ok) return null;

  const data = await response.json();
  return {
    title: data.title,
    author: data.author_name,
    thumbnail: data.thumbnail_url,
  };
}

function mapFormats(formats) {
  const sorted = [...formats].sort((a, b) => (b.height || 0) - (a.height || 0));

  return sorted.map((f, i) => {
    const width = f.width || 0;
    const height = f.height || 0;
    const label =
      height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 480 ? '480p' : `${height || 'best'}p`;

    return {
      itag: `tiktok-${i}-${width}x${height}`,
      quality: `${label} (${width}×${height})`,
      container: 'mp4',
      width,
      height,
      url: f.url,
      hasAudio: true,
      hasVideo: true,
    };
  });
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return null;
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

export async function fetchTikTokVideo(url) {
  let { videoId, canonicalUrl, isShort } = extractTikTokVideoId(url);

  if (isShort) {
    canonicalUrl = await resolveShortUrl(canonicalUrl);
    ({ videoId } = extractTikTokVideoId(canonicalUrl));
  }

  const [media, oembed] = await Promise.all([
    fetchViaPage(canonicalUrl),
    fetchViaOembed(canonicalUrl).catch(() => null),
  ]);

  const formats = mapFormats(media.formats);

  return {
    platform: 'tiktok',
    videoId: media.videoId || videoId,
    title: oembed?.title || media.title,
    author: oembed?.author || media.author,
    duration: formatDuration(media.duration),
    durationSeconds: media.duration || null,
    thumbnail: oembed?.thumbnail || media.thumbnail,
    description: media.title,
    viewCount: media.viewCount,
    formats,
    qualityNote:
      'TikTok typically serves up to 1080p. For higher resolution, enable AI upscale (Real-ESRGAN) — output is labeled as AI-enhanced, not native 8K.',
  };
}

export async function resolveTikTokDownloadUrl(url, itag) {
  const post = await fetchTikTokVideo(url);
  const format = post.formats.find((f) => f.itag === itag) || post.formats[0];

  if (!format?.url) {
    throw new Error('No download URL found for the selected quality.');
  }

  return format.url;
}
