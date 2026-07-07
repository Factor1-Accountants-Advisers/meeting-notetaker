# Third-party binaries

## ffmpeg (LGPL)

- **Source**: BtbN / gyan.dev FFmpeg essentials build (LGPL, no GPL components)
- **URL**: https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
- **Expected version**: ffmpeg 8.1.2 essentials (release build)
- **sha256**: computed at download time; record below:

  ```
  db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec  ffmpeg-release-essentials.zip (2026-07-07)
  ```

- **Extract to**: `third_party/ffmpeg/ffmpeg.exe` (the `bin/ffmpeg.exe` from the 7z)
- **License**: LGPL v2.1+. Distributed unmodified alongside the app — acceptable
  for internal tooling without source redistribution obligations.
- **Discovery order** (see `backend/app/services/audio_checks.py:find_ffmpeg`):
  1. `MN_FFMPEG_PATH` env var
  2. Bundled `ffmpeg/ffmpeg.exe` sibling (PyInstaller onedir)
  3. `shutil.which("ffmpeg")` (system PATH)
