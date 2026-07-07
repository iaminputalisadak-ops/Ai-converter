import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { config } from '../config.js';
import { extractMetadata } from './ffmpegService.js';
import {
  buildAudioEnhanceFilters,
  buildVoiceMixFilters,
} from './videoEnhancementService.js';

export const FILTER_PRESETS = {
  none: { label: 'None', videoFilters: [] },
  cinematic: {
    label: 'Cinematic',
    videoFilters: ['eq=contrast=1.12:brightness=0.04:saturation=1.2'],
  },
  warm: {
    label: 'Warm',
    videoFilters: ['eq=gamma_r=1.08:gamma_g=1.02:gamma_b=0.92:saturation=1.1'],
  },
  cool: {
    label: 'Cool',
    videoFilters: ['eq=gamma_r=0.92:gamma_g=1.0:gamma_b=1.08:saturation=1.05'],
  },
  vintage: {
    label: 'Vintage',
    videoFilters: ['eq=saturation=0.75:contrast=1.08:brightness=0.02', 'hue=s=0.9'],
  },
  sharpen: {
    label: 'Sharpen',
    videoFilters: ['unsharp=5:5:0.9:5:5:0.0'],
  },
  blur: {
    label: 'Soft blur',
    videoFilters: ['gblur=sigma=1.0'],
  },
  tealOrange: {
    label: 'Teal & orange (film LUT)',
    videoFilters: [
      'eq=gamma_r=0.95:gamma_g=1.0:gamma_b=1.12:saturation=1.15',
      'curves=r=0/0 0.5/0.45 1/1:g=0/0 0.5/0.5 1/1:b=0/0 0.5/0.55 1/1',
    ],
  },
  film: {
    label: 'Film print (LUT-style)',
    videoFilters: ['eq=contrast=1.1:saturation=0.9:gamma=1.05', 'curves=vintage'],
  },
};

export function listMusicTracks() {
  const musicDir = path.join(config.assetsDir, 'music');
  if (!existsSync(musicDir)) return [];

  return readdirSync(musicDir)
    .filter((file) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(file))
    .map((file) => ({
      id: file,
      name:
        file === 'free-ambient.mp3'
          ? 'Free Ambient (royalty-free, loops)'
          : path.parse(file).name.replace(/[-_]/g, ' '),
      filename: file,
    }))
    .sort((a, b) => {
      if (a.id === 'free-ambient.mp3') return -1;
      if (b.id === 'free-ambient.mp3') return 1;
      return a.name.localeCompare(b.name);
    });
}

function getWatermarkFont() {
  return process.platform === 'win32'
    ? 'C\\:/Windows/Fonts/arial.ttf'
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
}

function escapeDrawtext(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

/** Semi-transparent pill behind text only — no full-width black bar. */
function buildTextWatermarkFilter(videoOut, watermarkLabel) {
  const wmIn = videoOut === '0:v' ? '[0:v]' : `[${videoOut}]`;
  const font = getWatermarkFont();
  const text = escapeDrawtext(watermarkLabel);
  return (
    `${wmIn}drawtext=fontfile='${font}':text='${text}'` +
    `:fontsize=22:fontcolor=white@0.92` +
    `:shadowcolor=black@0.65:shadowx=2:shadowy=2` +
    `:box=1:boxcolor=black@0.38:boxborderw=12` +
    `:x=W-tw-18:y=H-th-18[vout]`
  );
}

function resolveMusicPath(trackId) {
  if (!trackId) throw new Error('No background music track selected.');
  const safeName = path.basename(trackId);
  const musicPath = path.join(config.assetsDir, 'music', safeName);
  if (!existsSync(musicPath)) {
    throw new Error(`Music track not found: ${safeName}. Add MP3 files to backend/assets/music/`);
  }
  return musicPath;
}

/** Pick a random track from the library (server-side). */
export function pickRandomMusicTrack() {
  const tracks = listMusicTracks();
  if (tracks.length === 0) return null;
  return tracks[Math.floor(Math.random() * tracks.length)].id;
}

/** Resolve random-track flag and return concrete audio options for export. */
export function resolveAudioOptions(audio = {}) {
  if (!audio.enabled) return audio;
  if (audio.randomTrack) {
    const picked = pickRandomMusicTrack();
    if (!picked) throw new Error('Random music enabled but no tracks found in backend/assets/music/');
    return { ...audio, track: picked };
  }
  return audio;
}

function buildFadeFilters(durationSec, fadeIn = 0.5, fadeOut = 0.5) {
  if (!durationSec || durationSec <= fadeIn + fadeOut) return [];
  const fadeOutStart = Math.max(0, durationSec - fadeOut);
  return [`fade=t=in:st=0:d=${fadeIn}`, `fade=t=out:st=${fadeOutStart}:d=${fadeOut}`];
}

function buildFilterGraph({
  videoFilters,
  enhancementFilters = [],
  hasWatermark,
  useTextWatermark,
  musicOptions,
  hasOriginalAudio,
  scaleTo = null,
  watermarkLabel = 'converter',
  audioEnhance = true,
  durationSec = null,
  fadeTransitions = false,
  useGpuScale = false,
}) {
  const filters = [];
  let videoOut = '0:v';
  let audioOut = null;
  const allVideoFilters = [...enhancementFilters, ...videoFilters];

  if (scaleTo) {
    const scaleFilter = useGpuScale
      ? `scale_cuda=${scaleTo.width}:${scaleTo.height},hwdownload,format=yuv420p`
      : `scale=${scaleTo.width}:${scaleTo.height}:flags=fast_bilinear`;
    filters.push(`[0:v]${scaleFilter}[vscaled]`);
    videoOut = 'vscaled';
  }

  if (allVideoFilters.length > 0) {
    const input = videoOut === '0:v' ? '[0:v]' : `[${videoOut}]`;
    filters.push(`${input}${allVideoFilters.join(',')}[vfx]`);
    videoOut = 'vfx';
  }

  if (fadeTransitions && durationSec) {
    const fadeFilters = buildFadeFilters(durationSec);
    if (fadeFilters.length > 0) {
      const input = videoOut === '0:v' ? '[0:v]' : `[${videoOut}]`;
      filters.push(`${input}${fadeFilters.join(',')}[vfade]`);
      videoOut = 'vfade';
    }
  }

  if (hasWatermark) {
    const wmIn = videoOut === '0:v' ? '[0:v]' : `[${videoOut}]`;
    filters.push(`${wmIn}[1:v]overlay=W-w-20:H-h-20[vout]`);
    videoOut = 'vout';
  } else if (useTextWatermark) {
    filters.push(buildTextWatermarkFilter(videoOut, watermarkLabel));
    videoOut = 'vout';
  }

  if (musicOptions) {
    const musicInput = hasWatermark ? 2 : 1;
    const volume = Math.min(Math.max(musicOptions.volume ?? 0.25, 0), 1);
    // Boost BGM — default ambient track is quiet; stream_loop on input handles looping (no aloop).
    const musicVol = Math.min(volume * 2.5, 1.5).toFixed(2);
    const voiceChain = audioEnhance ? buildVoiceMixFilters() : 'anull';

    if (musicOptions.mixWithOriginal && hasOriginalAudio) {
      if (musicOptions.ducking !== false) {
        filters.push(
          `[0:a]asplit=2[voice][scside]`,
          `[voice]${voiceChain}[voicefx]`,
          `[${musicInput}:a]volume=${musicVol}[bgmraw]`,
          `[bgmraw][scside]sidechaincompress=threshold=0.02:ratio=5:attack=150:release=800[bgm]`,
          `[voicefx][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`
        );
      } else {
        filters.push(
          `[0:a]${voiceChain}[vox]`,
          `[${musicInput}:a]volume=${musicVol}[bgm]`,
          `[vox][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[aout]`
        );
      }
    } else {
      filters.push(`[${musicInput}:a]volume=${musicVol}[aout]`);
    }
    audioOut = 'aout';
  } else if (hasOriginalAudio && audioEnhance) {
    filters.push(`[0:a]${buildAudioEnhanceFilters()}[aout]`);
    audioOut = 'aout';
  }

  return { filters, videoOut, audioOut };
}

export function processVideoExport(inputPath, options = {}) {
  const {
    fingerprintId = uuidv4(),
    watermarkPath = config.watermarkPath,
    platformId = config.platformId,
    applyWatermark = true,
    filterPreset = 'none',
    audio = {},
    scaleTo = null,
    audioEnhance = true,
    fadeTransitions = false,
    enhancementFilters = [],
    useGpuScale = false,
  } = options;

  const resolvedAudio = resolveAudioOptions(audio);
  const preset = FILTER_PRESETS[filterPreset] || FILTER_PRESETS.none;
  const outputFilename = `processed-${fingerprintId}.mp4`;
  const outputPath = path.join(config.processedDir, outputFilename);
  const useImageWatermark =
    applyWatermark &&
    config.watermarkMode === 'image' &&
    existsSync(watermarkPath);
  const useTextWatermark = applyWatermark && !useImageWatermark;
  const hasImageWatermark = useImageWatermark;
  const musicEnabled = Boolean(resolvedAudio.enabled && resolvedAudio.track);

  return new Promise((resolve, reject) => {
    extractMetadata(inputPath)
      .then((meta) => {
        const hasOriginalAudio = Boolean(meta.audio);

        const runExport = (nvenc, gpuScale) => {
          const { filters, videoOut, audioOut } = buildFilterGraph({
            videoFilters: preset.videoFilters,
            enhancementFilters,
            hasWatermark: hasImageWatermark,
            useTextWatermark,
            musicOptions: musicEnabled ? resolvedAudio : null,
            hasOriginalAudio,
            scaleTo,
            watermarkLabel: platformId,
            audioEnhance,
            durationSec: meta.duration,
            fadeTransitions,
            useGpuScale: gpuScale && Boolean(scaleTo),
          });

          let command = ffmpeg(inputPath);

          if (hasImageWatermark) {
            command = command.input(watermarkPath);
          }

          if (musicEnabled) {
            const musicPath = resolveMusicPath(resolvedAudio.track);
            command = command.input(musicPath).inputOptions(['-stream_loop', '-1']);
          }

          if (filters.length > 0) {
            command = command.complexFilter(filters);
          }

          const outputOptions = [
            '-map',
            filters.length > 0 ? `[${videoOut}]` : '0:v',
            '-pix_fmt', 'yuv420p',
          ];

          if (nvenc) {
            outputOptions.push(
              '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'vbr', '-cq', '24'
            );
          } else {
            outputOptions.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24');
          }

          if (audioOut) {
            outputOptions.push('-map', `[${audioOut}]`, '-c:a', 'aac', '-b:a', '192k', '-shortest');
          } else if (hasOriginalAudio) {
            outputOptions.push('-map', '0:a?', '-c:a', 'copy');
          }

          outputOptions.push(
            '-metadata', `title=Processed by ${platformId}`,
            '-metadata', `comment=fingerprint:${fingerprintId}`,
            '-metadata', `encoded_by=${platformId}`,
            '-metadata', `copyright=${platformId}`
          );

          if (filterPreset !== 'none') {
            outputOptions.push('-metadata', `description=filter:${filterPreset}`);
          }

          if (scaleTo) {
            outputOptions.push(
              '-metadata',
              `synopsis=upscaled:${scaleTo.width}x${scaleTo.height}`
            );
          }

          if (musicEnabled) {
            outputOptions.push('-metadata', `artist=bgm:${path.basename(resolvedAudio.track)}`);
          }

          command
            .outputOptions(outputOptions)
            .on('end', () =>
              resolve({
                outputPath,
                outputFilename,
                fingerprintId,
                downloadUrl: `/api/video/file/${outputFilename}`,
                appliedFilter: filterPreset !== 'none' ? filterPreset : null,
                appliedMusic: musicEnabled ? resolvedAudio.track : null,
                appliedWatermark: applyWatermark,
                fadeTransitions: Boolean(fadeTransitions),
              })
            )
            .on('error', (err) => {
              if (gpuScale) {
                runExport(nvenc, false);
                return;
              }
              if (nvenc) {
                runExport(false, false);
                return;
              }
              reject(new Error(`Video export failed: ${err.message}`));
            })
            .save(outputPath);
        };

        runExport(true, useGpuScale && Boolean(scaleTo));
      })
      .catch(reject);
  });
}
