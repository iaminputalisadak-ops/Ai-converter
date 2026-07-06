const IG_APP_ID = '936619743392459';
const POST_DOC_ID = '27128499623469141';
const ALT_POST_DOC_ID = '24368985919464652';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SHORTCODE_PATTERN =
  /instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

const INSTAGRAM_PROFILE_PATTERN = /^https?:\/\/(?:www\.)?instagram\.com\/[^/?#]+\/?(?:\?.*)?$/i;

export function extractInstagramShortcode(url) {
  const cleaned = url.split('?')[0].split('#')[0];

  if (INSTAGRAM_PROFILE_PATTERN.test(cleaned)) {
    throw new Error(
      'This is a profile link, not a post. Open a specific reel or post and copy that link.'
    );
  }

  const match = cleaned.match(SHORTCODE_PATTERN);
  if (!match) {
    throw new Error(
      'Invalid Instagram URL. Paste a link to a specific post or reel (e.g. instagram.com/reel/ABC123/).'
    );
  }
  return match[1];
}

function parseSetCookies(setCookieHeaders) {
  const jar = {};
  for (const header of setCookieHeaders) {
    const [pair] = header.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function initInstagramSession() {
  const response = await fetch('https://www.instagram.com/', {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const jar = parseSetCookies(response.headers.getSetCookie?.() || []);

  if (!jar.csrftoken) {
    const html = await response.text();
    const tokenMatch = html.match(/"csrf_token":"([^"]+)"/);
    if (tokenMatch) jar.csrftoken = tokenMatch[1];
  }

  return jar;
}

async function graphqlRequest(jar, docId, variables) {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    doc_id: docId,
    server_timestamps: 'true',
  });

  const response = await fetch(`https://www.instagram.com/graphql/query?${params}`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRFToken': jar.csrftoken || '',
      'X-IG-App-ID': IG_APP_ID,
      'X-Instagram-AJAX': '1',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.instagram.com',
      Referer: 'https://www.instagram.com/',
      Cookie: cookieHeader(jar),
    },
  });

  if (!response.ok) {
    throw new Error(`Instagram API returned ${response.status}. Try again in a moment.`);
  }

  return response.json();
}

function collectVideoVersions(media) {
  const versions = [];

  if (Array.isArray(media.video_versions) && media.video_versions.length) {
    versions.push(...media.video_versions);
  }

  const carousel = media.carousel_media || [];
  for (const item of carousel) {
    if (Array.isArray(item.video_versions) && item.video_versions.length) {
      versions.push(...item.video_versions);
    }
  }

  return versions;
}

function mapGraphqlMedia(media) {
  const mediaType = media.media_type;
  const videoVersions = collectVideoVersions(media);

  if (!videoVersions.length) {
    if (mediaType === 1) {
      throw new Error('This Instagram post is an image, not a video.');
    }
    if (mediaType === 8) {
      throw new Error('This carousel post has no video slides.');
    }
    throw new Error('No video found in this Instagram post.');
  }

  const candidates = media.image_versions2?.candidates || [];
  const caption = media.caption;
  const captionText = typeof caption === 'object' ? caption?.text : caption;

  return {
    video_versions: videoVersions,
    title: media.accessibility_caption || captionText || `Instagram post ${media.code}`,
    owner: { username: media.user?.username },
    user: media.user,
    video_duration: media.video_duration,
    display_url: candidates[0]?.url,
    thumbnail_src: candidates[0]?.url,
    caption: captionText ? { text: captionText } : null,
    video_view_count: media.view_count,
    play_count: media.play_count,
    code: media.code,
  };
}

async function fetchViaGraphQL(shortcode) {
  const jar = await initInstagramSession();
  const variables = {
    shortcode,
    __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false,
  };

  for (const docId of [POST_DOC_ID, ALT_POST_DOC_ID]) {
    const json = await graphqlRequest(jar, docId, variables);
    const items = json?.data?.xdt_api__v1__media__shortcode__web_info?.items;

    if (items?.length) {
      return mapGraphqlMedia(items[0]);
    }

    if (json?.errors?.length) {
      const critical = json.errors.some((e) => e.severity === 'CRITICAL');
      if (critical) continue;
    }
  }

  throw new Error(
    'Could not load this Instagram post. It may be private, deleted, age-restricted, or the link may be invalid.'
  );
}

function findMediaNode(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return null;

  if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) {
    return obj;
  }

  if (obj.xdt_shortcode_media?.video_versions) {
    return obj.xdt_shortcode_media;
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = findMediaNode(value, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

async function fetchViaHtml(shortcode) {
  const response = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Instagram returned ${response.status}.`);
  }

  const html = await response.text();
  const jsonScripts = html.matchAll(
    /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const [, raw] of jsonScripts) {
    try {
      const parsed = JSON.parse(raw);
      const media = findMediaNode(parsed);
      if (media) return media;
    } catch {
      // try next block
    }
  }

  throw new Error(
    'Could not parse Instagram page. The post may be private or require login.'
  );
}

function mapVideoVersions(versions) {
  const sorted = [...versions].sort((a, b) => (b.width || 0) - (a.width || 0));

  return sorted.map((v) => {
    const width = v.width || 0;
    const height = v.height || 0;
    const label =
      height >= 1080 ? '1080p' : height >= 720 ? '720p' : height >= 480 ? '480p' : `${height}p`;

    return {
      itag: `${width}x${height}`,
      quality: `${label} (${width}×${height})`,
      container: 'mp4',
      width,
      height,
      url: v.url,
      hasAudio: true,
      hasVideo: true,
    };
  });
}

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return null;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function fetchMedia(shortcode) {
  try {
    return await fetchViaGraphQL(shortcode);
  } catch (graphqlError) {
    try {
      return await fetchViaHtml(shortcode);
    } catch {
      throw graphqlError;
    }
  }
}

export async function fetchInstagramPost(url) {
  const shortcode = extractInstagramShortcode(url);
  const media = await fetchMedia(shortcode);
  const formats = mapVideoVersions(media.video_versions);
  const best = formats[0];

  return {
    platform: 'instagram',
    videoId: shortcode,
    title: media.title || media.accessibility_caption || `Instagram post ${shortcode}`,
    author: media.owner?.username || media.user?.username || null,
    duration: formatDuration(media.video_duration),
    durationSeconds: media.video_duration || null,
    thumbnail: media.display_url || media.thumbnail_src || best?.url,
    description: media.caption?.text || media.edge_media_to_caption?.edges?.[0]?.node?.text || null,
    viewCount: media.video_view_count || media.play_count || null,
    formats,
    qualityNote:
      'Instagram serves video up to ~1080p. There is no native 8K video stream — only the highest available encode is offered.',
  };
}

export async function resolveInstagramDownloadUrl(url, itag) {
  const post = await fetchInstagramPost(url);
  const format = post.formats.find((f) => f.itag === itag) || post.formats[0];

  if (!format?.url) {
    throw new Error('No download URL found for the selected quality.');
  }

  return format.url;
}
