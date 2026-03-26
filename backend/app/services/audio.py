"""Audio extraction utility for video files.

Uses FFmpeg to extract audio from MP4 and other video formats,
converting them to WAV for the processing pipeline.
"""
import logging
import subprocess
import tempfile
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def extract_audio_from_video(input_path: str) -> str:
    """Extract audio track from a video file using FFmpeg.

    Converts to 16kHz mono WAV (optimal for Whisper transcription).

    Args:
        input_path: Path to the input video file

    Returns:
        Path to the extracted WAV file (in temp directory)

    Raises:
        RuntimeError: If FFmpeg fails
    """
    output_path = os.path.join(
        tempfile.gettempdir(),
        f"{Path(input_path).stem}_extracted.wav"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-vn",                # Strip video
        "-acodec", "pcm_s16le",  # 16-bit PCM
        "-ar", "16000",       # 16kHz sample rate (Whisper optimal)
        "-ac", "1",           # Mono
        output_path
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,  # 5 min timeout
        )
        if result.returncode != 0:
            logger.error(f"FFmpeg failed: {result.stderr}")
            raise RuntimeError(f"Audio extraction failed: {result.stderr[:200]}")

        logger.info(f"Extracted audio: {input_path} -> {output_path}")
        return output_path

    except subprocess.TimeoutExpired:
        raise RuntimeError("Audio extraction timed out (>5 minutes)")
    except FileNotFoundError:
        raise RuntimeError("FFmpeg not found — install FFmpeg to process video files")
