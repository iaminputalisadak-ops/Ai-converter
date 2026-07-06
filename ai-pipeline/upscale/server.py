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

import queue
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

app = FastAPI(title="Real-ESRGAN Upscale Service")

WEIGHTS_DIR = Path(__file__).parent / "weights"
MODEL_X4 = WEIGHTS_DIR / "RealESRGAN_x4plus.pth"
MODEL_X2 = WEIGHTS_DIR / "RealESRGAN_x2plus.pth"
USE_GPU = torch.cuda.is_available()

if USE_GPU:
    torch.backends.cudnn.benchmark = True
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True


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


def _pick_tile(width: int, height: int) -> int:
    """No tiling when VRAM allows — much faster on laptop GPUs."""
    if not USE_GPU:
        return 256
    pixels = width * height
    if pixels <= 1920 * 1080:
        return 0
    if pixels <= 1080 * 1920:
        return 0
    if pixels <= 2560 * 1440:
        return 512
    return 384


def _build_upsampler(scale: int):
    from realesrgan import RealESRGANer
    from basicsr.archs.rrdbnet_arch import RRDBNet

    if scale == 2 and MODEL_X2.exists():
        model = RRDBNet(
            num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2
        )
        upsampler = RealESRGANer(
            scale=2,
            model_path=str(MODEL_X2),
            model=model,
            tile=0,
            tile_pad=10,
            pre_pad=0,
            half=USE_GPU,
            gpu_id=0 if USE_GPU else None,
        )
        return upsampler, 2

    if not MODEL_X4.exists():
        raise HTTPException(
            status_code=503,
            detail=f"Model weights not found at {MODEL_X4}. See README for download instructions.",
        )

    model = RRDBNet(
        num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=4
    )
    native_scale = 4 if scale >= 4 else scale
    upsampler = RealESRGANer(
        scale=4,
        model_path=str(MODEL_X4),
        model=model,
        tile=512,
        tile_pad=10,
        pre_pad=0,
        half=USE_GPU,
        gpu_id=0 if USE_GPU else None,
    )
    return upsampler, native_scale


def upscale_with_realesrgan(input_path: Path, output_path: Path, scale: int) -> None:
    """Run Real-ESRGAN inference. Requires realesrgan package + model weights."""
    try:
        from realesrgan import RealESRGANer  # noqa: F401
        from basicsr.archs.rrdbnet_arch import RRDBNet  # noqa: F401
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail="Real-ESRGAN not installed. Run: pip install -r requirements.txt",
        ) from exc

    upsampler, native_scale = _build_upsampler(scale)

    if input_path.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv"}:
        _upscale_video_frames(input_path, output_path, upsampler, scale, native_scale)
        return

    import cv2

    image = cv2.imread(str(input_path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise HTTPException(status_code=400, detail="Could not read input file.")

    outscale = 1 if native_scale == scale else scale
    output, _ = upsampler.enhance(image, outscale=outscale)
    cv2.imwrite(str(output_path), output)


def _probe_video(input_path: Path) -> tuple[float, int, int, int]:
    import cv2

    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        raise HTTPException(status_code=400, detail="Could not open video.")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    cap.release()
    return fps, width, height, frame_count


def _open_decoder(input_path: Path, width: int, height: int):
    """FFmpeg decode pipe — faster than OpenCV for most codecs."""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "0",
        "-i",
        str(input_path),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "pipe:1",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.stdout is None:
        raise HTTPException(status_code=400, detail="Could not open video decoder.")

    frame_bytes = width * height * 3

    def read_frame():
        raw = proc.stdout.read(frame_bytes)
        if not raw or len(raw) < frame_bytes:
            proc.wait()
            return None
        return np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3))

    return proc, read_frame


def _open_encoder(output_path: Path, out_w: int, out_h: int, fps: float):
    use_nvenc = USE_GPU and _nvenc_available()
    if use_nvenc:
        proc = subprocess.Popen(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
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
                "p1",
                "-tune",
                "ll",
                "-crf",
                "19",
                "-pix_fmt",
                "yuv420p",
                str(output_path),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return proc, lambda frame: proc.stdin.write(frame.tobytes()), lambda: proc.stdin.close()

    import cv2

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(output_path), fourcc, fps, (out_w, out_h))
    return writer, writer.write, writer.release


def _upscale_video_frames(
    input_path: Path, output_path: Path, upsampler, scale: int, native_scale: int
) -> None:
    fps, width, height, frame_count = _probe_video(input_path)
    out_w, out_h = width * scale, height * scale
    tile = _pick_tile(width, height)
    if hasattr(upsampler, "tile"):
        upsampler.tile = tile

    outscale = 1 if native_scale == scale else scale
    decoder, read_fn = _open_decoder(input_path, width, height)
    encoder, write_fn, close_fn = _open_encoder(output_path, out_w, out_h, fps)

    frame_queue: queue.Queue = queue.Queue(maxsize=3)
    stop_sentinel = object()

    def _reader():
        while True:
            frame = read_fn()
            if frame is None:
                break
            frame_queue.put(frame)
        frame_queue.put(stop_sentinel)

    reader_thread = threading.Thread(target=_reader, daemon=True)
    reader_thread.start()

    frame_idx = 0
    try:
        with torch.inference_mode():
            while True:
                item = frame_queue.get()
                if item is stop_sentinel:
                    break
                upscaled, _ = upsampler.enhance(item, outscale=outscale)
                write_fn(upscaled)
                frame_idx += 1
                if frame_count and frame_idx % 15 == 0:
                    pct = round((frame_idx / frame_count) * 100)
                    print(f"Upscale progress: {frame_idx}/{frame_count} ({pct}%)", flush=True)
    finally:
        close_fn()
        if isinstance(encoder, subprocess.Popen):
            if encoder.wait() != 0:
                raise HTTPException(status_code=500, detail="FFmpeg NVENC encoding failed.")
        reader_thread.join(timeout=5)

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
            "-hide_banner",
            "-loglevel",
            "error",
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
        "model_exists": MODEL_X4.exists() or MODEL_X2.exists(),
        "model_x2": MODEL_X2.exists(),
        "model_x4": MODEL_X4.exists(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "gpu": USE_GPU,
        "device": torch.cuda.get_device_name(0) if USE_GPU else "cpu",
        "optimizations": ["x2plus", "no-tile", "nvdec", "nvenc", "pipelined"] if USE_GPU else [],
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
