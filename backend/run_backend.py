"""Programmatic uvicorn entry point for frozen (PyInstaller) backends.

``python -m uvicorn`` is unavailable inside a frozen app — use this module
as the console script target instead.  The Electron supervisor invokes it as::

    notetaker-backend.exe          (packaged, ``backend/run_backend.py``)
    python run_backend.py          (dev, direct)

Environment variables honoured:
  ``MN_BACKEND_PORT``   override the default port (8787)
  ``MN_BACKEND_HOST``   override the bind address (127.0.0.1)
"""

import os

import uvicorn

HOST = os.environ.get("MN_BACKEND_HOST", "127.0.0.1")
PORT = int(os.environ.get("MN_BACKEND_PORT", "8787"))

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level="info")
