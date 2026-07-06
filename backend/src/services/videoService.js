import ytdl from 'ytdl-core';
import {
  fetchInstagramPost,
  resolveInstagramDownloadUrl,
} from './instagramService.js';
import {
  fetchTikTokVideo,
  resolveTikTokDownloadUrl,
} from './tiktokService.js';

function formatDuration(seconds) {
  if (!seconds || Number.isNaN(seconds)) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function mapYoutubeFormats(formats) {
  const videoFormats = formats
    .filter((f) => f.hasVideo && f.hasAudio && f.qualityLabel)
    .map((f) => ({
      itag: f.itag,
      quality: f.qualityLabel,
      container: f.container,
      codecs: f.codecs,
      bitrate: f.bitrate,
      fps: f.fps,
      hasAudio: f.hasAudio,
      hasVideo: f.hasVideo,
    }));

  const seen = new Set();
  return videoFormats.filter((f) => {
    if (seen.has(f.quality)) return false;
    seen.add(f.quality);
    return true;
  });
}

export async function fetchYoutubeMetadata(url) {
  if (!ytdl.validateURL(url)) {
    throw new Error('Invalid YouTube URL');
  }

  const info = await ytdl.getInfo(url);
  const details = info.videoDetails;

  return {
    platform: 'youtube',
    videoId: details.videoId,
    title: details.title,
    author: details.author?.name || details.ownerChannelName,
    duration: formatDuration(parseInt(details.lengthSeconds, 10)),
    durationSeconds: parseInt(details.lengthSeconds, 10),
    thumbnail: details.thumbnails?.[details.thumbnails.length - 1]?.url,
    description: details.description?.slice(0, 500),
    viewCount: details.viewCount,
    formats: mapYoutubeFormats(info.formats),
  };
}

export function getYoutubeDownloadUrl(url, itag) {
  if (!ytdl.validateURL(url)) {
    throw new Error('Invalid YouTube URL');
  }
  return ytdl.getURL(url, { quality: itag || 'highest' });
}

export async function fetchVideoMetadata(url, platformId) {
  switch (platformId) {
    case 'youtube':
      return fetchYoutubeMetadata(url);
    case 'instagram':
      return fetchInstagramPost(url);
    case 'tiktok':
      return fetchTikTokVideo(url);
    case 'facebook':
    case 'twitter':
      throw new Error(
        `${platformId} support is planned. Install the corresponding scraper package and extend videoService.js.`
      );
    default:
      throw new Error(
        'Unsupported platform. Currently YouTube, Instagram, and TikTok URLs are supported.'
      );
  }
}

export async function resolveDownloadUrl(url, platformId, itag) {
  switch (platformId) {
    case 'youtube':
      return getYoutubeDownloadUrl(url, itag);
    case 'instagram':
      return resolveInstagramDownloadUrl(url, itag);
    case 'tiktok':
      return resolveTikTokDownloadUrl(url, itag);
    default:
      throw new Error('Download not available for this platform yet.');
  }
}
