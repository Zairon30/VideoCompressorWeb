"""
Core compression logic, ported from the desktop app (core/compressor.py,
core/video_info.py, utils/formatters.py) with all PySide6 / subprocess code removed.

It runs in the browser via Pyodide. It builds the FFmpeg argument list and does
the size/bitrate math; ffmpeg.wasm then executes the arguments.
"""
import json
import re
from pathlib import PurePath

PRESETS = {"best": "medium", "balanced": "fast", "small": "veryfast"}


def get_preset(compression_mode: str) -> str:
    return PRESETS.get(compression_mode, "fast")


def calculate_video_bitrate(duration: float, target_size_mb: float, audio_bitrate: int) -> int:
    """Video bitrate (kbps) needed to land near the requested final size."""
    if duration <= 0:
        raise RuntimeError("Video duration is invalid.")
    if target_size_mb <= 0:
        raise RuntimeError("Target size must be greater than 0 MB.")

    target_bytes = target_size_mb * 1024 * 1024
    usable_bytes = target_bytes * 0.97  # reserve ~3% for container/metadata
    total_bits_per_second = (usable_bytes * 8) / duration
    video_bits_per_second = total_bits_per_second - audio_bitrate * 1000
    video_bits_per_second = max(video_bits_per_second, 300_000)
    return max(300, int(video_bits_per_second / 1000))


def build_video_filter(resolution: str) -> str:
    if resolution == "source":
        return "format=yuv420p"
    return (
        f"scale={resolution}:force_original_aspect_ratio=decrease:"
        "flags=lanczos,format=yuv420p"
    )


def build_command(input_name, output_name, duration, resolution, fps, codec,
                  audio_bitrate, compression_mode, target_size_mb):
    video_bitrate = calculate_video_bitrate(duration, target_size_mb, audio_bitrate)
    preset = get_preset(compression_mode)

    args = [
        "-i", input_name,
        "-map", "0:v:0",
        "-vf", build_video_filter(resolution),
    ]
    if fps and fps > 0:  # 0 = keep original frame rate
        args += ["-r", str(fps)]
    args += [
        "-c:v", codec,
        "-preset", preset,
        "-b:v", f"{video_bitrate}k",
        "-maxrate", f"{video_bitrate}k",
        "-bufsize", f"{video_bitrate * 2}k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
    ]
    if audio_bitrate > 0:
        args += ["-map", "0:a:0?", "-c:a", "aac", "-b:a", f"{audio_bitrate}k", "-ac", "2"]
    else:
        args += ["-an"]
    args.append(output_name)
    return args, video_bitrate, preset


def parse_duration(ffmpeg_log: str) -> float:
    """Replaces ffprobe: read 'Duration: HH:MM:SS.xx' from `ffmpeg -i` output."""
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", ffmpeg_log or "")
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def format_bytes(value: int) -> str:
    if not value:
        return "0 B"
    units = ["B", "KB", "MB", "GB", "TB"]
    size, index = float(value), 0
    while size >= 1024 and index < len(units) - 1:
        size /= 1024
        index += 1
    return f"{int(size)} B" if index == 0 else f"{size:.2f} {units[index]}"


def format_duration(seconds) -> str:
    if seconds is None or seconds < 0:
        return "--:--"
    total = round(seconds)
    hours, minutes, secs = total // 3600, (total % 3600) // 60, total % 60
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def output_name(input_path: str) -> str:
    return f"{PurePath(input_path).stem}-compressed.mp4"


# ---- JSON entry points called from JavaScript --------------------------------

def build_plan(params_json: str) -> str:
    p = json.loads(params_json)
    args, video_bitrate, preset = build_command(
        input_name=p["input_name"],
        output_name=p["output_name"],
        duration=float(p["duration"]),
        resolution=p["resolution"],
        fps=int(p["fps"]),
        codec=p.get("codec", "libx264"),
        audio_bitrate=int(p["audio_bitrate"]),
        compression_mode=p["compression_mode"],
        target_size_mb=float(p["target_size_mb"]),
    )
    log = [
        f"Compression mode: {p['compression_mode']}",
        f"Target size: {float(p['target_size_mb']):.1f} MB",
        f"Calculated video bitrate: {video_bitrate} kbps",
        f"Audio bitrate: {p['audio_bitrate']} kbps",
        f"Codec: {p.get('codec', 'libx264')}",
        f"Preset: {preset}",
        f"Resolution: {p['resolution']}",
        f"FPS: {p['fps'] or 'original'}",
        "",
    ]
    return json.dumps({"args": args, "log": log})


def summarize(output_size: int, input_size: int, target_mb: float) -> str:
    out_mb = output_size / (1024 * 1024)
    lines = [
        "",
        f"Final output size: {out_mb:.2f} MB",
        f"Difference from target: {out_mb - target_mb:+.2f} MB",
    ]
    if input_size:
        ratio = output_size / input_size * 100
        lines.append(f"Output size is {ratio:.1f}% of original.")
        lines.append(f"Size reduction: {100 - ratio:.1f}%")
    return "\n".join(lines)


def describe_file(name: str, size: int, duration: float) -> str:
    return f"Loaded: {name}\nSize: {format_bytes(size)}\nDuration: {format_duration(duration)}"
