import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import { config } from '../config.js';
import { extractMetadata } from './ffmpegService.js';
import { buildAudioEnhanceFilters } from './videoEnhancementService.js';

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
    videoFilters: ['gblur=sigma=1.8'],
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

function resolveMusicPath(trackId) {
  if (!trackId) throw new Error('No background music track selected.');
  const safeName = path.basename(trackId);
  const musicPath = path.join(config.assetsDir, 'music', safeName);
  if (!existsSync(musicPath)) {
    throw new Error(`Music track not found: ${safeName}. Add MP3 files to backend/assets/music/`);
  }
  return musicPath;
}

function buildFilterGraph({
  videoFilters,
  hasWatermark,
  useTextWatermark,
  musicOptions,
  hasOriginalAudio,
  scaleTo = null,
  watermarkLabel = 'converter',
  audioEnhance = true,
}) {
  const filters = [];
  let videoOut = '0:v';
  let audioOut = null;

  if (scaleTo) {
    filters.push(
      `[0:v]scale=${scaleTo.width}:${scaleTo.height}:flags=lanczos[vscaled]`
    );
    videoOut = 'vscaled';
  }

  if (videoFilters.length > 0) {
    const input = videoOut === '0:v' ? '[0:v]' : `[${videoOut}]`;
    filters.push(`${input}${videoFilters.join(',')}[vfx]`);
    videoOut = 'vfx';
  }

  if (hasWatermark) {
    const wmIn = videoOut === '0:v' ? '[0:v]' : `[${videoOut}]`;
    filters.push(`${wmIn}[1:v]overlay=W-w-20:H-h-20[vout]`);
    videoOut = 'vout';
  } else if (useTextWatermark) {
    const wmIn = videoOut === '0:v' ? '[0:v]' : `[${videoOut}]`;
    const font =
      process.platform === 'win32'
        ? 'C\\\\:/Windows/Fonts/arial.ttf'
        : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    filters.push(
      `${wmIn}drawtext=fontfile='${font}':text='${watermarkLabel}':fontsize=22:fontcolor=white@0.8:x=W-tw-20:y=H-th-20[vout]`
    );
    videoOut = 'vout';
  }

  if (musicOptions?.enabled) {
    const musicInput = hasWatermark ? 2 : 1;
    const volume = Math.min(Math.max(musicOptions.volume ?? 0.25, 0), 1);
    const musicVol = volume.toFixed(2);
    const voiceChain = audioEnhance
      ? buildAudioEnhanceFilters()
      : 'anull';

    if (musicOptions.mixWithOriginal && hasOriginalAudio) {
      filters.push(
        `[0:a]${voiceChain}[vox]`,
        `[${musicInput}:a]volume=${musicVol},aloop=loop=-1:size=2e+09[bgm]`,
        `[vox][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]`
      );
    } else {
      filters.push(`[${musicInput}:a]volume=${musicVol},aloop=loop=-1:size=2e+09[aout]`);
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
  } = options;

  const preset = FILTER_PRESETS[filterPreset] || FILTER_PRESETS.none;
  const outputFilename = `processed-${fingerprintId}.mp4`;
  const outputPath = path.join(config.processedDir, outputFilename);
  const hasImageWatermark = applyWatermark && existsSync(watermarkPath);
  const useTextWatermark = applyWatermark && !existsSync(watermarkPath);
  const musicEnabled = Boolean(audio.enabled && audio.track);

  return new Promise((resolve, reject) => {
    extractMetadata(inputPath)
      .then((meta) => {
        const hasOriginalAudio = Boolean(meta.audio);
        const { filters, videoOut, audioOut } = buildFilterGraph({
          videoFilters: preset.videoFilters,
          hasWatermark: hasImageWatermark,
          useTextWatermark,
          musicOptions: musicEnabled ? audio : null,
          hasOriginalAudio,
          scaleTo,
          watermarkLabel: platformId,
          audioEnhance,
        });

        const runExport = (nvenc) => {
          let command = ffmpeg(inputPath);

          if (hasImageWatermark) {
            command = command.input(watermarkPath);
          }

          if (musicEnabled) {
            const musicPath = resolveMusicPath(audio.track);
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
            outputOptions.push('-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'vbr', '-cq', '23');
          } else {
            outputOptions.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23');
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
            outputOptions.push('-metadata', `artist=bgm:${path.basename(audio.track)}`);
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
                appliedMusic: musicEnabled ? audio.track : null,
                appliedWatermark: applyWatermark,
              })
            )
            .on('error', (err) => {
              if (nvenc) {
                runExport(false);
                return;
              }
              reject(new Error(`Video export failed: ${err.message}`));
            })
            .save(outputPath);
        };

        runExport(true);
      })
      .catch(reject);
  });
}
