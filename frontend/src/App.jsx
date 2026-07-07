import { useState, useEffect } from 'react';
import {
  fetchMetadata,
  getDownloadUrl,
  processVideo,
  waitForJob,
  fetchUpscaleStatus,
  fetchMusicTracks,
  fetchFilterPresets,
} from './api';
import './App.css';

const AI_QUALITY_OPTIONS = [
  {
    itag: 'ai-8k',
    target: '8k',
    label: '8K AI Upscale (7680×4320)',
    hint: 'AI-enhanced — not native platform quality',
  },
  {
    itag: 'ai-4k',
    target: '4k',
    label: '4K AI Upscale (3840×2160)',
    hint: 'AI-enhanced — not native platform quality',
  },
  {
    itag: 'ai-2x',
    target: '2x',
    label: '2× AI Upscale (double resolution)',
    hint: 'AI-enhanced from source',
  },
];

function isAiQuality(itag) {
  return String(itag).startsWith('ai-');
}

function aiTargetFromItag(itag) {
  return String(itag).replace(/^ai-/, '');
}

const DEFAULT_MUSIC_TRACK = 'free-ambient.mp3';

function pickDefaultTrack(tracks) {
  if (!tracks?.length) return null;
  return tracks.find((t) => t.id === DEFAULT_MUSIC_TRACK) || tracks[0];
}

function formatElapsed(ms) {
  if (!ms) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function App() {
  const [url, setUrl] = useState('');
  const [metadata, setMetadata] = useState(null);
  const [selectedItag, setSelectedItag] = useState('');
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const [modifications, setModifications] = useState({
    styleTransfer: false,
    frameInterpolation: false,
    objectDetection: false,
    stabilize: false,
    hdrTone: false,
    denoiseSharpen: true,
    audioEnhance: true,
    generateThumbnail: true,
    upscale: { enabled: false, target: '4k', mode: 'fast' },
    filters: { preset: 'none' },
    audio: {
      enabled: true,
      track: DEFAULT_MUSIC_TRACK,
      volume: 0.25,
      mixWithOriginal: true,
      ducking: true,
      randomTrack: false,
    },
    fadeTransitions: false,
  });
  const [applyWatermark, setApplyWatermark] = useState(true);
  const [upscaleStatus, setUpscaleStatus] = useState(null);
  const [musicTracks, setMusicTracks] = useState([]);
  const [filterPresets, setFilterPresets] = useState([]);

  useEffect(() => {
    fetchUpscaleStatus().then(setUpscaleStatus).catch(() => null);
    fetchMusicTracks()
      .then((tracks) => {
        setMusicTracks(tracks);
        const defaultTrack = pickDefaultTrack(tracks);
        if (!defaultTrack) return;
        setModifications((prev) => ({
          ...prev,
          audio: {
            ...prev.audio,
            enabled: true,
            track: defaultTrack.id,
          },
        }));
      })
      .catch(() => []);
    fetchFilterPresets().then(setFilterPresets).catch(() => []);
  }, []);

  async function handleFetchMetadata(e) {
    e.preventDefault();
    setError('');
    setResult(null);
    setMetadata(null);
    setLoading(true);

    try {
      const data = await fetchMetadata(url.trim());
      resetForNewMetadata(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDirectDownload() {
    if (aiQualitySelected) {
      setError('AI upscale (4K/8K) requires processing. Use “Upscale & Download” instead.');
      return;
    }
    setError('');
    try {
      const { downloadUrl } = await getDownloadUrl(url.trim(), selectedItag);
      window.open(downloadUrl, '_blank');
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleProcess() {
    setError('');

    if (modifications.audio.enabled && musicTracks.length === 0) {
      setError(
        'Background music is on, but no MP3 files were found. Add tracks to backend/assets/music/ and click Get Info again.'
      );
      return;
    }

    if (modifications.audio.enabled && !modifications.audio.track && !modifications.audio.randomTrack) {
      setError('Select a music track from the dropdown, or enable random track.');
      return;
    }

    setResult(null);
    setJobStatus(null);
    setProcessing(true);

    try {
      const { jobId } = await processVideo({
        url: url.trim(),
        itag: getSourceItag(),
        modifications: getProcessModifications(),
        applyWatermark,
      });

      const data = await waitForJob(jobId, {
        onUpdate: setJobStatus,
        pollMs: 1000,
      });

      setResult(data);
      setJobStatus((prev) => (prev ? { ...prev, status: 'completed', progress: 100 } : prev));
    } catch (err) {
      setError(err.message);
    } finally {
      setProcessing(false);
    }
  }

  function toggleModification(key) {
    setModifications((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function setFilterPreset(preset) {
    setModifications((prev) => ({
      ...prev,
      filters: { preset },
    }));
  }

  function setAudioOption(key, value) {
    setModifications((prev) => ({
      ...prev,
      audio: { ...prev.audio, [key]: value },
    }));
  }

  function toggleBackgroundMusic() {
    setModifications((prev) => {
      const enabled = !prev.audio.enabled;
      return {
        ...prev,
        audio: {
          ...prev.audio,
          enabled,
          track: enabled && !prev.audio.track && musicTracks[0] ? musicTracks[0].id : prev.audio.track,
        },
      };
    });
  }

  function getSourceItag() {
    if (!isAiQuality(selectedItag)) return selectedItag;
    return metadata?.formats?.[0]?.itag || selectedItag;
  }

  function getProcessModifications() {
    if (!isAiQuality(selectedItag)) {
      return {
        ...modifications,
        upscale: { enabled: false, target: '4k', mode: modifications.upscale.mode || 'fast' },
      };
    }
    return {
      ...modifications,
      upscale: {
        enabled: true,
        target: aiTargetFromItag(selectedItag),
        mode: modifications.upscale.mode || 'fast',
      },
    };
  }

  function handleQualityChange(itag) {
    setSelectedItag(itag);
    if (isAiQuality(itag)) {
      setModifications((prev) => ({
        ...prev,
        upscale: { enabled: true, target: aiTargetFromItag(itag), mode: prev.upscale.mode || 'fast' },
      }));
    } else {
      setModifications((prev) => ({
        ...prev,
        upscale: { enabled: false, target: '4k', mode: prev.upscale.mode || 'fast' },
      }));
    }
  }

  function resetForNewMetadata(data) {
    setMetadata(data);
    setResult(null);
    setJobStatus(null);
    if (data.formats?.length) {
      setSelectedItag(String(data.formats[0].itag));
    }
    const defaultTrack = pickDefaultTrack(musicTracks);
    setModifications((prev) => ({
      ...prev,
      upscale: { enabled: false, target: '4k', mode: prev.upscale.mode || 'fast' },
      audio: {
        ...prev.audio,
        enabled: true,
        track: defaultTrack?.id || DEFAULT_MUSIC_TRACK,
      },
    }));
  }

  const aiQualitySelected = isAiQuality(selectedItag);
  const selectedAiOption = AI_QUALITY_OPTIONS.find((o) => o.itag === selectedItag);

  return (
    <div className="app">
      <header className="header">
        <h1>Video Converter</h1>
        <p>Download, process, and attribute video content you own or have rights to use.</p>
      </header>

      <div className="legal-notice">
        <strong>Legal notice:</strong> Only download and modify content you own or are
        authorized to use. Downloading copyrighted material without permission may violate
        platform terms of service and intellectual property law. Consult legal counsel before
        launching a public service.
      </div>

      <form className="form-card" onSubmit={handleFetchMetadata}>
        <div className="url-row">
          <input
            className="url-input"
            type="url"
            placeholder="Paste video URL (YouTube, Instagram, or TikTok)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <button className="btn-primary" type="submit" disabled={loading || !url.trim()}>
            {loading ? 'Loading…' : 'Get Info'}
          </button>
        </div>
      </form>

      {error && <div className="error-banner">{error}</div>}

      {processing && jobStatus && (
        <div className="progress-card">
          <div className="progress-header">
            <h3>Processing video</h3>
            <span className="progress-pct">{jobStatus.progress}%</span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${jobStatus.progress}%` }} />
          </div>
          <p className="progress-message">{jobStatus.message}</p>
          <div className="progress-times">
            <span>Elapsed: {formatElapsed(jobStatus.elapsedMs)}</span>
            {jobStatus.status === 'running' && (
              <span>Est. remaining: {jobStatus.etaLabel}</span>
            )}
          </div>
          <ul className="progress-steps">
            {jobStatus.steps?.map((step) => (
              <li key={step.id} className={`progress-step progress-step--${step.status}`}>
                <span className="step-icon">
                  {step.status === 'completed' ? '✓' : step.status === 'running' ? '●' : '○'}
                </span>
                <span>{step.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {processing && !jobStatus && (
        <div className="loading">Starting processing job…</div>
      )}

      {loading && <div className="loading">Fetching video metadata…</div>}

      {metadata && (
        <div className="metadata-card">
          <div className="metadata-header">
            {metadata.thumbnail && (
              <img className="thumbnail" src={metadata.thumbnail} alt={metadata.title} />
            )}
            <div className="metadata-info">
              <span className="platform-badge">{metadata.platform || 'Video'}</span>
              <h2>{metadata.title}</h2>
              <div className="meta-row">
                {metadata.author && <span>By {metadata.author}</span>}
                {metadata.duration && <span>{metadata.duration}</span>}
                {metadata.viewCount && (
                  <span>{Number(metadata.viewCount).toLocaleString()} views</span>
                )}
              </div>
              {metadata.qualityNote && (
                <p className="quality-note">{metadata.qualityNote}</p>
              )}
            </div>
          </div>

          {metadata.formats?.length > 0 && (
            <div className="quality-section">
              <label htmlFor="quality">Download quality</label>
              <select
                id="quality"
                className="quality-select"
                value={selectedItag}
                onChange={(e) => handleQualityChange(e.target.value)}
              >
                <optgroup label="Source quality (native from platform)">
                  {metadata.formats.map((f) => (
                    <option key={f.itag} value={f.itag}>
                      {f.quality} — {f.container}
                      {f.fps ? ` (${f.fps}fps)` : ''}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="AI enhanced — 4K / 8K (requires processing)">
                  {AI_QUALITY_OPTIONS.map((o) => (
                    <option key={o.itag} value={o.itag}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              </select>

              {!aiQualitySelected && (
                <p className="quality-note">
                  Source quality selected — no upscaling. Output stays at the resolution you picked
                  (e.g. 1080p). Only filters, music, and watermark are applied.
                </p>
              )}

              {aiQualitySelected && (
                <div className="ai-quality-banner">
                  <strong>{selectedAiOption?.label}</strong>
                  <p>
                    Instagram/TikTok don&apos;t offer native 8K. This downloads the best source
                    ({metadata.formats[0]?.quality}) then upscales to your target.
                  </p>
                  <div className="speed-mode">
                    <label htmlFor="upscale-mode">Upscale speed</label>
                    <select
                      id="upscale-mode"
                      className="quality-select"
                      value={modifications.upscale.mode}
                      onChange={(e) =>
                        setModifications((prev) => ({
                          ...prev,
                          upscale: { ...prev.upscale, mode: e.target.value },
                        }))
                      }
                    >
                      <option value="fast">Fast — GPU FFmpeg (~10–30 sec)</option>
                      <option value="ai">AI Quality — Real-ESRGAN + GPU (best detail, ~1–2 min)</option>
                    </select>
                  </div>
                  <p className="quality-note">
                    {modifications.upscale.mode === 'fast'
                      ? 'Fast mode uses GPU-accelerated FFmpeg scaling — near-instant, not AI-enhanced.'
                      : upscaleStatus?.gpu
                        ? `GPU optimized (${upscaleStatus.device}) — 2× AI model + GPU encode. Typical reels: ~1–2 min.`
                        : 'No GPU detected — AI Quality can take 10–30+ min for short reels on CPU. Use Fast mode to finish quickly.'}
                  </p>
                </div>
              )}

              <div className="options-grid">
                <div className="option-block">
                  <label htmlFor="filter-preset">Video filter</label>
                  <select
                    id="filter-preset"
                    className="quality-select"
                    value={modifications.filters.preset}
                    onChange={(e) => setFilterPreset(e.target.value)}
                  >
                    {filterPresets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={modifications.audio.enabled}
                    onChange={toggleBackgroundMusic}
                    disabled={musicTracks.length === 0}
                  />
                  Add background music
                </label>
                {modifications.audio.enabled && musicTracks.length === 0 && (
                  <p className="quality-note error-note">
                    No music files found. Add MP3s to <code>backend/assets/music/</code> and click
                    Get Info to refresh.
                  </p>
                )}
                {modifications.audio.enabled && (
                  <div className="audio-options">
                    {musicTracks.length > 0 ? (
                      <>
                        <label htmlFor="music-track">Music track</label>
                        <select
                          id="music-track"
                          className="quality-select"
                          value={modifications.audio.randomTrack ? '__random__' : modifications.audio.track}
                          onChange={(e) => {
                            if (e.target.value === '__random__') {
                              setAudioOption('randomTrack', true);
                            } else {
                              setModifications((prev) => ({
                                ...prev,
                                audio: {
                                  ...prev.audio,
                                  randomTrack: false,
                                  track: e.target.value,
                                },
                              }));
                            }
                          }}
                        >
                          <option value="__random__">Random from library</option>
                          {musicTracks.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <p className="quality-note">
                        Add MP3 files to <code>backend/assets/music/</code> and refresh.
                      </p>
                    )}
                    <label htmlFor="music-volume">
                      Music volume ({Math.round(modifications.audio.volume * 100)}%)
                    </label>
                    <input
                      id="music-volume"
                      type="range"
                      min="0.05"
                      max="1"
                      step="0.05"
                      value={modifications.audio.volume}
                      onChange={(e) => setAudioOption('volume', parseFloat(e.target.value))}
                    />
                    <label className="option-item">
                      <input
                        type="checkbox"
                        checked={modifications.audio.mixWithOriginal}
                        onChange={(e) => setAudioOption('mixWithOriginal', e.target.checked)}
                      />
                      Mix with original audio
                    </label>
                    {modifications.audio.mixWithOriginal && (
                      <label className="option-item">
                        <input
                          type="checkbox"
                          checked={modifications.audio.ducking !== false}
                          onChange={(e) => setAudioOption('ducking', e.target.checked)}
                        />
                        Auto-duck music when speech is loud
                      </label>
                    )}
                  </div>
                )}

                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={applyWatermark}
                    onChange={(e) => setApplyWatermark(e.target.checked)}
                  />
                  Apply watermark &amp; digital fingerprint
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={modifications.styleTransfer}
                    onChange={() => toggleModification('styleTransfer')}
                  />
                  Cinematic color grade (LUT-style)
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={modifications.frameInterpolation}
                    onChange={() => toggleModification('frameInterpolation')}
                  />
                  Frame smoothing (fast, single-pass)
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={modifications.stabilize}
                    onChange={() => toggleModification('stabilize')}
                  />
                  Video stabilization
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={modifications.hdrTone}
                    onChange={() => toggleModification('hdrTone')}
                  />
                  HDR-style tone mapping
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={modifications.fadeTransitions}
                    onChange={() => toggleModification('fadeTransitions')}
                  />
                  Fade in / fade out (0.5s)
                </label>
                <label className="option-item">
                  <input
                    type="checkbox"
                    checked={modifications.objectDetection}
                    onChange={() => toggleModification('objectDetection')}
                  />
                  Advanced object detection (GPU — planned)
                </label>
                <p className="quality-note">
                  All effects run in <strong>one GPU encode</strong> — typical reels finish in 15–45 sec.
                  Use native 1080p + Fast upscale for best speed. Turn off blur/stabilize for even faster jobs.
                </p>
              </div>

              <div className="actions">
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={handleDirectDownload}
                  disabled={aiQualitySelected}
                  title={aiQualitySelected ? 'Use Upscale & Download for AI quality' : undefined}
                >
                  Direct Download
                </button>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={handleProcess}
                  disabled={processing}
                >
                  {processing
                    ? 'Processing…'
                    : aiQualitySelected
                      ? 'Upscale & Download'
                      : 'Process & Download'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="result-card">
          <h3>Processing complete</h3>
          <dl className="result-details">
            {result.appliedFilter && result.appliedFilter !== 'none' && (
              <>
                <dt>Filter</dt>
                <dd>{result.appliedFilter}</dd>
              </>
            )}
            {result.appliedWatermark && (
              <>
                <dt>Watermark</dt>
                <dd>Applied</dd>
              </>
            )}
            {result.appliedMusic && (
              <>
                <dt>Background music</dt>
                <dd>{result.appliedMusic}</dd>
              </>
            )}
            {result.enhancements?.length > 0 && (
              <>
                <dt>Enhancements</dt>
                <dd>
                  {result.enhancements.map((s) => (
                    <div key={s.step}>{s.message}</div>
                  ))}
                </dd>
              </>
            )}
            {result.thumbnail?.url && (
              <>
                <dt>Auto thumbnail</dt>
                <dd>
                  <img
                    className="result-thumb"
                    src={result.thumbnail.url}
                    alt="Auto-selected video thumbnail"
                  />
                </dd>
              </>
            )}
            {result.fingerprintId && (
              <>
                <dt>Fingerprint ID</dt>
                <dd>{result.fingerprintId}</dd>
              </>
            )}
            {result.upscale && !result.upscale.skipped && (
              <>
                <dt>Upscale</dt>
                <dd>{result.upscale.label}</dd>
              </>
            )}
            {result.upscale?.skipped && (
              <>
                <dt>Upscale</dt>
                <dd>{result.upscale.reason}</dd>
              </>
            )}
            {(result.outputMetadata?.video || result.fileMetadata?.video) && (
              <>
                <dt>Resolution</dt>
                <dd>
                  {result.outputMetadata?.video
                    ? `${result.outputMetadata.video.width}×${result.outputMetadata.video.height}`
                    : `${result.fileMetadata.video.width}×${result.fileMetadata.video.height}`}{' '}
                  @{' '}
                  {(result.outputMetadata?.video?.fps || result.fileMetadata.video.fps)?.toFixed(1)} fps
                  {result.outputMetadata?.video && result.fileMetadata?.video && (
                    <span className="resolution-source">
                      {' '}
                      (source: {result.fileMetadata.video.width}×{result.fileMetadata.video.height})
                    </span>
                  )}
                </dd>
              </>
            )}
          </dl>
          {result.downloadUrl && (
            <a
              className="btn-primary"
              href={result.downloadUrl}
              download
              style={{ display: 'inline-block', textDecoration: 'none' }}
            >
              Download Processed File
            </a>
          )}
        </div>
      )}
    </div>
  );
}
