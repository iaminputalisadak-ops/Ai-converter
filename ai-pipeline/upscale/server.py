"""
Real-ESRGAN upscaling microservice.

Setup:
  pip install -r requirements.txt
  # Download model weights to ai-pipeline/upscale/weights/

Run:
  uvicorn server:app --host 0.0.0.0 --port 8002

Set in backend/.env:
  AI_UPSCALE_URL=http://localhost:8002
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

app = FastAPI(title="Real-ESRGAN Upscale Service")

WEIGHTS_DIR = Path(__file__).parent / "weights"
DEFAULT_MODEL = WEIGHTS_DIR / "RealESRGAN_x4plus.pth"
USE_GPU = torch.cuda.is_available()

if USE_GPU:
    torch.backends.cudnn.benchmark = True


def _nvenc_available() -> bool:
    if not shutil.which("ffmpeg"):
        return False
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            check=False,
        )
        return "h264_nvenc" in result.stdout
    except OSError:
        return False


def upscale_with_realesrgan(input_path: Path, output_path: Path, scale: int) -> None:
    """Run Real-ESRGAN inference. Requires realesrgan package + model weights."""
    try:
        from realesrgan import RealESRGANer
        from basicsr.archs.rrdbnet_arch import RRDBNet
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="Real-ESRGAN not installed. Run: pip install -r requirements.txt",
        ) from exc

    if not DEFAULT_MODEL.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Model weights not found at {DEFAULT_MODEL}. See README for download instructions.",
        )

    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4)
    upsampler = RealESRGANer(
        scale=4,
        model_path=str(DEFAULT_MODEL),
        model=model,
        tile=384 if USE_GPU else 256,
        tile_pad=10,
        pre_pad=0,
        half=USE_GPU,
        gpu_id=0 if USE_GPU else None,
    )

    import cv2

    if input_path.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv"}:
        _upscale_video_frames(input_path, output_path, upsampler, scale)
        return

    image = cv2.imread(str(input_path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise HTTPException(status_code=400, detail="Could not read input file.")

    output, _ = upsampler.enhance(image, outscale=scale)
    cv2.imwrite(str(output_path), output)


def _upscale_video_frames(input_path: Path, output_path: Path, upsampler, scale: int) -> None:
    import cv2

    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail="Could not open video.")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    out_w, out_h = width * scale, height * scale

    use_nvenc = USE_GPU and _nvenc_available()
    if use_nvenc:
        encoder = subprocess.Popen(
            [
                "ffmpeg",
                "-y",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "bgr24",
                "-s",
                f"{out_w}x{out_h}",
                "-r",
                str(fps),
                "-i",
                "pipe:0",
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p4",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                str(output_path),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        encoder = cv2.VideoWriter(str(output_path), fourcc, fps, (out_w, out_h))

    frame_idx = 0
    with torch.inference_mode():
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            upscaled, _ = upsampler.enhance(frame, outscale=scale)
            if use_nvenc:
                encoder.stdin.write(upscaled.tobytes())
            else:
                encoder.write(upscaled)
            frame_idx += 1
            if frame_count and frame_idx % 30 == 0:
                pct = round((frame_idx / frame_count) * 100)
                print(f"Upscale progress: {frame_idx}/{frame_count} ({pct}%)", flush=True)

    cap.release()
    if use_nvenc:
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise HTTPException(status_code=500, detail="FFmpeg NVENC encoding failed.")
    else:
        encoder.release()

    _mux_audio(input_path, output_path)


def _mux_audio(video_path: Path, source_path: Path) -> None:
    """Copy original audio track onto upscaled video via FFmpeg."""
    if not shutil.which("ffmpeg"):
        return

    temp = video_path.with_suffix(".tmp.mp4")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(source_path),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0?",
            "-shortest",
            str(temp),
        ],
        check=True,
        capture_output=True,
    )
    temp.replace(video_path)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_exists": DEFAULT_MODEL.exists(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "gpu": USE_GPU,
        "device": torch.cuda.get_device_name(0) if USE_GPU else "cpu",
    }


@app.post("/upscale")
async def upscale(
    file: UploadFile = File(...),
    scale: int = Form(4),
):
    if scale not in (2, 4):
        raise HTTPException(status_code=400, detail="Scale must be 2 or 4.")

    suffix = Path(file.filename or "input.mp4").suffix or ".mp4"
    work_dir = Path(tempfile.mkdtemp(prefix="upscale-"))
    input_path = work_dir / f"input{suffix}"
    output_path = work_dir / f"output-{uuid.uuid4().hex}.mp4"

    try:
        with open(input_path, "wb") as f:
            shutil.copyfileobj(file.file, f)

        upscale_with_realesrgan(input_path, output_path, scale)

        if not output_path.exists():
            raise HTTPException(status_code=500, detail="Upscaling produced no output.")

        return FileResponse(
            output_path,
            media_type="video/mp4",
            filename="upscaled.mp4",
            background=None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
