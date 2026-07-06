# Converter — Video Download & AI Processing Platform

A full-stack video downloader with FFmpeg-based watermarking, digital fingerprinting, and an extensible AI modification pipeline.

## Architecture

```
┌─────────────┐     REST API      ┌──────────────────┐
│  React UI   │ ────────────────► │  Express Backend │
│  (Vite)     │                   │  Node.js         │
└─────────────┘                   └────────┬─────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
             ytdl-core              FFmpeg (fluent)        AI Stubs
             (YouTube)               watermark/fingerprint   (StyleGAN3,
                                    metadata extraction      DAIN, YOLO)
```

## Prerequisites

- **Node.js** 18+
- **FFmpeg** installed and on your PATH ([download](https://ffmpeg.org/download.html))
- Windows: `winget install FFmpeg` or add ffmpeg to PATH manually

## Quick Start

```bash
# Install dependencies
npm install

# Configure backend
cp backend/.env.example backend/.env

# Optional: add your logo for watermarking
# Place a PNG at backend/assets/watermark.png

# Run both frontend and backend
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/video/metadata` | Extract title, duration, quality options |
| POST | `/api/video/download-url` | Resolve direct download URL |
| POST | `/api/video/process` | Download → AI pipeline → watermark → fingerprint |
| GET | `/api/video/file/:filename` | Download processed file |
| GET | `/api/video/health` | Health check |

## Supported Platforms

| Platform | Status |
|----------|--------|
| YouTube | ✅ Working (ytdl-core, up to source max — often 4K for some uploads) |
| Instagram | ✅ Working (GraphQL API, up to ~1080p) |
| TikTok | ✅ Working (page metadata + playAddr, up to ~1080p) |
| Facebook | 🔲 Planned |
| X (Twitter) | 🔲 Planned |

### Getting higher than native quality (honest path)

None of these platforms serve native 8K for typical short-form content. To reach 4K/8K **legitimately**:

1. Download the **highest native quality** the platform provides
2. Enable **AI upscale** in the UI (Real-ESRGAN service in `ai-pipeline/upscale/`)
3. Output is labeled **"AI-upscaled from WxH to WxH"** — not fake native 8K

We do **not** support thumbnail-to-video tricks, metadata stripping, or fingerprint evasion.

## AI Upscaling (Legitimate Higher Resolution)

To increase resolution beyond what platforms provide:

1. Start the Real-ESRGAN service: see `ai-pipeline/upscale/README.md`
2. Set `AI_UPSCALE_URL=http://localhost:8002` in `backend/.env`
3. Enable **AI upscale** in the UI when processing

| Method | Quality | Requirement |
|--------|---------|-------------|
| Real-ESRGAN (Python service) | True AI super-resolution | GPU + model weights |
| Real-ESRGAN CLI | True AI super-resolution | `REALESRGAN_BIN` path |
| FFmpeg Lanczos (fallback) | Traditional upscale | Always available |

Output is always **honestly labeled** — e.g. "AI-upscaled from 1080×1920 to 2160×3840", never presented as native platform quality.

## AI Pipeline (Extension Points)

The backend includes stub hooks in `backend/src/services/ffmpegService.js` for:

1. **Style transfer** — deploy StyleGAN3 as an AWS Lambda / Cloud Function with GPU
2. **Frame interpolation** — deploy DAIN model as a separate inference service
3. **Object detection** — run YOLOv7 via a Python microservice

See `ai-pipeline/README.md` for the recommended deployment architecture.

## Ownership Attribution

- **Watermark**: FFmpeg overlay of `backend/assets/watermark.png` (bottom-right)
- **Digital fingerprint**: UUID embedded in video metadata (`comment`, `encoded_by`, `copyright` tags)

## Legal Notice

**Only use this tool on content you own or have explicit rights to download and modify.** Downloading copyrighted videos without permission may violate platform Terms of Service and intellectual property law. Consult an attorney before launching a public-facing service.

## Production Deployment

1. Deploy backend to a cloud provider (AWS ECS, Railway, Render)
2. Use S3/GCS for `uploads/` and `processed/` storage
3. Move heavy AI inference to serverless GPU functions (Lambda + EFS, Cloud Run + GPU)
4. Add job queue (BullMQ + Redis) for async processing
5. Deploy frontend to Vercel/Netlify with API proxy

## Project Structure

```
converter/
├── backend/
│   ├── src/
│   │   ├── index.js           # Express entry
│   │   ├── routes/video.js    # API routes
│   │   └── services/
│   │       ├── videoService.js    # Platform scrapers
│   │       └── ffmpegService.js   # FFmpeg + AI stubs
│   └── assets/watermark.png   # Your platform logo (add this)
├── frontend/
│   └── src/
│       ├── App.jsx            # Main UI
│       └── api.js             # API client
└── ai-pipeline/               # AI service architecture docs
```
