"""Runtime tests for backend audio extraction."""

from unittest.mock import MagicMock, patch

import pytest


def test_extract_audio_uses_configured_ffmpeg_path_in_subprocess_command(monkeypatch):
    from app.core.config import settings
    from app.services.audio import extract_audio_from_video

    monkeypatch.setattr(settings, "ffmpeg_path", "C:/bundle/ffmpeg.exe")

    with patch("app.services.audio.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")

        extract_audio_from_video("C:/videos/demo.mp4")

    assert mock_run.call_args is not None
    command = mock_run.call_args.args[0]
    assert command[0] == "C:/bundle/ffmpeg.exe"


def test_extract_audio_raises_installer_error_when_bundled_ffmpeg_missing(monkeypatch):
    from app.core.config import settings
    from app.services.audio import extract_audio_from_video

    monkeypatch.setattr(settings, "ffmpeg_path", "C:/bundle/ffmpeg.exe")

    with patch("app.services.audio.subprocess.run", side_effect=FileNotFoundError):
        with pytest.raises(
            RuntimeError,
            match="Bundled FFmpeg not found — reinstall the app or contact support",
        ):
            extract_audio_from_video("C:/videos/demo.mp4")
