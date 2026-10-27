"""
Browser video compressor core.
Runs through Pyodide and builds FFmpeg arguments.
"""

import json
import re
from pathlib import PurePath

PRESETS = {
    "best": "medium",
    "balanced": "fast",
    "small": "veryfast",
}

TIKTOK_DEFAULTS = {
    "resolution": "1080:1920",
    "aspect": "9:16",
    "fps": 30,
    "crf": 18,
    "preset": "medium",
    "audio_bitrate": 128,
}

ALLOWED_TIKTOK_PRESETS = {
    "ultrafast",
    "superfast",
    "veryfast",
    "faster",
    "fast",
    "medium",
    "slow",
    "slower",
    "veryslow",
}


def get_preset(compression_mode: str) -> str:
    return PRESETS.get(compression_mode, "fast")


def calculate_video_bitrate(
    duration: float,
    target_size_mb: float,
    audio_bitrate: int
) -> int:
    """Calculate video bitrate for an approximate target file size."""

    if duration <= 0:
        raise RuntimeError("Video duration is invalid.")

    if target_size_mb <= 0:
        raise RuntimeError("Target size must be greater than 0 MB.")

    target_bytes = target_size_mb * 1024 * 1024
    usable_bytes = target_bytes * 0.97
    total_bits_per_second = (usable_bytes * 8) / duration

    video_bits_per_second = total_bits_per_second - audio_bitrate * 1000
    video_bits_per_second = max(video_bits_per_second, 300_000)

    return max(300, int(video_bits_per_second / 1000))


def build_video_filter(resolution: str) -> str:
    """Scale standard output while preserving the source aspect ratio."""

    if resolution == "source":
        return "setsar=1,format=yuv420p"

    match = re.fullmatch(r"(\d+):(\d+)", resolution)

    if not match:
        raise ValueError("Invalid standard resolution.")

    width, height = map(int, match.groups())

    if width <= 0 or height <= 0:
        raise ValueError("Resolution must be positive.")

    return (
        f"scale={width}:{height}:"
        "force_original_aspect_ratio=decrease:"
        "force_divisible_by=2:"
        "flags=lanczos,"
        "setsar=1,"
        "format=yuv420p"
    )


def build_tiktok_filter(
    resolution: str = "1080:1920",
    aspect: str = "9:16"
) -> str:
    """Build the manually configured TikTok video filter."""

    if aspect not in ("9:16", "original"):
        raise ValueError("Invalid TikTok aspect ratio.")

    if resolution == "source":
        if aspect == "original":
            return "setsar=1,format=yuv420p"

        # Center-crop the source to a 9:16 frame without stretching it.
        return (
            "crop=w='min(iw,ih*9/16)':"
            "h='min(ih,iw*16/9)':"
            "x='(iw-ow)/2':y='(ih-oh)/2',"
            "scale=1080:1920:"
            "force_original_aspect_ratio=increase:"
            "force_divisible_by=2:"
            "flags=lanczos,"
            "crop=1080:1920,"
            "setsar=1,"
            "format=yuv420p"
        )

    match = re.fullmatch(r"(\d+):(\d+)", resolution)

    if not match:
        raise ValueError("Invalid TikTok resolution.")

    width, height = map(int, match.groups())

    if width <= 0 or height <= 0:
        raise ValueError("Resolution must be positive.")

    if aspect == "9:16":
        # Fill the vertical frame, then center-crop any excess.
        return (
            f"scale={width}:{height}:"
            "force_original_aspect_ratio=increase:"
            "force_divisible_by=2:"
            "flags=lanczos,"
            f"crop={width}:{height},"
            "setsar=1,"
            "format=yuv420p"
        )

    # Preserve the source aspect ratio within the chosen dimensions.
    return (
        f"scale={width}:{height}:"
        "force_original_aspect_ratio=decrease:"
        "force_divisible_by=2:"
        "flags=lanczos,"
        "setsar=1,"
        "format=yuv420p"
    )


def build_tiktok_command(
    input_name: str,
    output_name: str,
    resolution: str = "1080:1920",
    fps: int = 30,
    crf: int = 18,
    preset: str = "medium",
    audio_bitrate: int = 128,
    aspect: str = "9:16",
):
    """Build a quality-based MP4 export using the TikTok profile."""

    fps = int(fps)
    crf = int(crf)
    audio_bitrate = int(audio_bitrate)

    if preset not in ALLOWED_TIKTOK_PRESETS:
        raise ValueError("Invalid TikTok encoder preset.")

    if crf < 0 or crf > 51:
        raise ValueError("CRF must be between 0 and 51.")

    if fps not in (0, 24, 30, 60):
        raise ValueError("FPS must be 0, 24, 30, or 60.")

    if audio_bitrate not in (64, 96, 128, 192):
        raise ValueError("Audio bitrate must be 64, 96, 128, or 192.")

    video_filter = build_tiktok_filter(resolution, aspect)

    args = [
        "-i", input_name,
        "-map", "0:v:0",
        "-vf", video_filter,
    ]

    if fps > 0:
        args += ["-r", str(fps)]

    args += [
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-map", "0:a:0?",
        "-c:a", "aac",
        "-b:a", f"{audio_bitrate}k",
        "-ac", "2",
        "-sn",
        "-dn",
        "-movflags", "+faststart",
        "-max_muxing_queue_size", "1024",
        "-f", "mp4",
        "-y",
        output_name,
    ]

    if resolution == "source":
        resolution_label = "Source dimensions (vertical crop may resize to 1080x1920)"
    else:
        resolution_label = resolution.replace(":", "x")

    log = [
        "Profile: TikTok Maximum Quality",
        f"Resolution: {resolution_label}",
        f"Aspect ratio: {aspect}",
        "Video codec: H.264 (libx264)",
        f"Quality: CRF {crf}",
        f"Encoder preset: {preset}",
        f"Frame rate: {fps if fps > 0 else 'Original'}",
        f"Audio: AAC {audio_bitrate} kbps stereo",
        "Pixel format: yuv420p",
        "MP4 optimization: +faststart",
        "Encoding mode: Quality-based; target size is not fixed",
        "",
    ]

    return args, log


def build_command(
    input_name,
    output_name,
    duration,
    resolution,
    fps,
    codec,
    audio_bitrate,
    compression_mode,
    target_size_mb
):
    """Build standard target-size compression arguments."""

    audio_bitrate = int(audio_bitrate)

    video_bitrate = calculate_video_bitrate(
        float(duration),
        float(target_size_mb),
        audio_bitrate,
    )

    preset = get_preset(compression_mode)

    args = [
        "-i", input_name,
        "-map", "0:v:0",
        "-vf", build_video_filter(resolution),
    ]

    if int(fps) > 0:
        args += ["-r", str(int(fps))]

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
        args += [
            "-map", "0:a:0?",
            "-c:a", "aac",
            "-b:a", f"{audio_bitrate}k",
            "-ac", "2",
        ]
    else:
        args += ["-an"]

    args += ["-y", output_name]

    return args, video_bitrate, preset


def parse_duration(ffmpeg_log: str) -> float:
    """Read Duration: HH:MM:SS.xx from FFmpeg output."""

    match = re.search(
        r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)",
        ffmpeg_log or "",
    )

    if not match:
        return 0.0

    return (
        int(match.group(1)) * 3600
        + int(match.group(2)) * 60
        + float(match.group(3))
    )


def format_bytes(value: int) -> str:
    if not value:
        return "0 B"

    units = ["B", "KB", "MB", "GB", "TB"]
    size = float(value)
    index = 0

    while size >= 1024 and index < len(units) - 1:
        size /= 1024
        index += 1

    return (
        f"{int(size)} B"
        if index == 0
        else f"{size:.2f} {units[index]}"
    )


def format_duration(seconds) -> str:
    if seconds is None or seconds < 0:
        return "--:--"

    total = round(seconds)
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60

    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"

    return f"{minutes}:{secs:02d}"


def output_name(input_path: str) -> str:
    return f"{PurePath(input_path).stem}-compressed.mp4"


def build_plan(params_json: str) -> str:
    """Return an FFmpeg plan as JSON for the JavaScript frontend."""

    p = json.loads(params_json)

    if p.get("profile", "standard") == "tiktok":
        args, log = build_tiktok_command(
            input_name=p["input_name"],
            output_name=p["output_name"],
            resolution=p.get("tt_resolution", "1080:1920"),
            fps=int(p.get("tt_fps", 30)),
            crf=int(p.get("tt_crf", 18)),
            preset=p.get("tt_preset", "medium"),
            audio_bitrate=int(p.get("tt_audio", 128)),
            aspect=p.get("tt_aspect", "9:16"),
        )

        return json.dumps({
            "profile": "tiktok",
            "args": args,
            "log": log,
        })

    target_size_mb = float(p["target_size_mb"])

    args, video_bitrate, preset = build_command(
        input_name=p["input_name"],
        output_name=p["output_name"],
        duration=float(p["duration"]),
        resolution=p["resolution"],
        fps=int(p["fps"]),
        codec=p.get("codec", "libx264"),
        audio_bitrate=int(p["audio_bitrate"]),
        compression_mode=p["compression_mode"],
        target_size_mb=target_size_mb,
    )

    log = [
        "Profile: Standard Compression",
        f"Compression mode: {p['compression_mode']}",
        f"Target size: {target_size_mb:.1f} MB",
        f"Calculated video bitrate: {video_bitrate} kbps",
        f"Audio bitrate: {p['audio_bitrate']} kbps",
        f"Codec: {p.get('codec', 'libx264')}",
        f"Preset: {preset}",
        f"Resolution: {p['resolution']}",
        f"FPS: {p['fps'] if int(p['fps']) > 0 else 'Original'}",
        "",
    ]

    return json.dumps({
        "profile": "standard",
        "args": args,
        "log": log,
    })


def summarize(
    output_size: int,
    input_size: int,
    target_mb: float
) -> str:
    out_mb = output_size / (1024 * 1024)

    lines = [
        "",
        f"Final output size: {out_mb:.2f} MB",
    ]

    if target_mb > 0:
        lines.append(
            f"Difference from target: {out_mb - target_mb:+.2f} MB"
        )

    if input_size:
        ratio = output_size / input_size * 100
        lines.append(f"Output size is {ratio:.1f}% of original.")
        lines.append(f"Size reduction: {100 - ratio:.1f}%")

    return "\n".join(lines)


def describe_file(name: str, size: int, duration: float) -> str:
    return (
        f"Loaded: {name}\n"
        f"Size: {format_bytes(size)}\n"
        f"Duration: {format_duration(duration)}"
    )