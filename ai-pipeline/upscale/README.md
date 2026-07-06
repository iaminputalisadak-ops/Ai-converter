# Real-ESRGAN Upscale Service

Legitimate AI super-resolution for video — upscales lower-resolution source material with honest labeling.

## What this does

- Takes a video file (e.g. 1080p from Instagram)
- Runs **Real-ESRGAN** neural upscaling frame-by-frame
- Outputs a higher-resolution file (2× or up to 4K/8K targets)
- Labels output as **AI-upscaled** — not native platform quality

## Setup

```bash
cd ai-pipeline/upscale
python -m venv .venv

# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### Download model weights

```bash
mkdir -p weights
# Download RealESRGAN_x4plus.pth from:
# https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth
# Place at: ai-pipeline/upscale/weights/RealESRGAN_x4plus.pth
```

Requires **FFmpeg** on PATH for audio muxing, and a **CUDA GPU** is strongly recommended for reasonable speed.

## Run

```bash
uvicorn server:app --host 0.0.0.0 --port 8002
```

## Connect to backend

In `backend/.env`:

```
AI_UPSCALE_URL=http://localhost:8002
```

Restart the Node backend. The upscale service is tried first; if unavailable, FFmpeg Lanczos upscaling is used as fallback (clearly labeled in the UI).

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service status + model availability |
| `/upscale` | POST | `file` (video) + `scale` (2 or 4) → upscaled MP4 |

## Performance notes

- 1080p → 4K on a 60s clip can take several minutes on GPU, much longer on CPU
- For production, deploy on a GPU Cloud Run / Lambda container with job queue
- Consider processing short clips only, or charge per minute of upscaled video

## Honest labeling

The backend always returns an `upscale.label` string such as:

- `AI-upscaled (Real-ESRGAN) from 1080×1920 to 2160×3840`
- `Enhanced upscale (FFmpeg Lanczos) from 1080×1920 to 2160×3840 — not true AI super-resolution`

Never present upscaled output as "native 8K" from the source platform.
