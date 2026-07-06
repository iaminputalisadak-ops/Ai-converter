const PLATFORM_PATTERNS = [
  { id: 'youtube', pattern: /(?:youtube\.com|youtu\.be)/i, label: 'YouTube' },
  { id: 'tiktok', pattern: /(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)/i, label: 'TikTok' },
  { id: 'facebook', pattern: /facebook\.com|fb\.watch/i, label: 'Facebook' },
  { id: 'instagram', pattern: /instagram\.com/i, label: 'Instagram' },
  { id: 'twitter', pattern: /(?:twitter\.com|x\.com)/i, label: 'X (Twitter)' },
];

export function detectPlatform(url) {
  for (const platform of PLATFORM_PATTERNS) {
    if (platform.pattern.test(url)) {
      return platform;
    }
  }
  return { id: 'unknown', label: 'Unknown' };
}

export function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
