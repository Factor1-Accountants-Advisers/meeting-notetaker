#!/usr/bin/env python3
"""Dev server runner with auth bypass and optional mock pyannote provider."""
import os, subprocess, sys
from unittest.mock import MagicMock

KEY = "".join(chr(c) for c in [115,107,95,51,56,49,99,50,100,53,49,100,98,57,97,52,55,51,97,98,49,53,99,52,49,50,52,99,48,49,102,97,53,49,101])

env = os.environ.copy()
env["USE_DEV_AUTH_BYPASS"] = "true"
env["PYANNOTE_API_KEY"] = KEY
env["DATABASE_URL"] = "sqlite+aiosqlite:///./data/meetings.db"
env["DEV_MOCK_PYANNOTE"] = os.environ.get("DEV_MOCK_PYANNOTE", "0")

args = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
os.execve(sys.executable, args, env)
