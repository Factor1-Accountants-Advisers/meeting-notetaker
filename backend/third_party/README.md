# Third-party binaries

## ffmpeg (LGPL)

- **Source**: BtbN / gyan.dev FFmpeg essentials build (LGPL, no GPL components)
- **URL**: https://www.gyan.dev/ffmpeg/builds/ffmpeg-git-essentials.7z
- **Expected version**: ffmpeg version git-2026-07-01-* (or any recent essentials build)
- **sha256**: computed at download time; record below:

  ```
  <paste sha256 here after download>
  ```

- **Extract to**: `third_party/ffmpeg/ffmpeg.exe` (the `bin/ffmpeg.exe` from the 7z)
- **License**: LGPL v2.1+. Distributed unmodified alongside the app — acceptable
  for internal tooling without source redistribution obligations.
- **Discovery order** (see `backend/app/services/audio_checks.py:find_ffmpeg`):
  1. `MN_FFMPEG_PATH` env var
  2. Bundled `ffmpeg/ffmpeg.exe` sibling (PyInstaller onedir)
  3. `shutil.which("ffmpeg")` (system PATH)
