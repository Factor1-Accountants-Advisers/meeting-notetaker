# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Meeting Notetaker backend (onedir bundle).

Produces ``dist/notetaker-backend/`` containing the frozen backend and a
bundled ffmpeg.exe.  The Electron supervisor spawns
``notetaker-backend.exe`` from ``extraResources/backend/``.

Build (Windows only — PyInstaller produces host-platform artifacts)::

    cd backend
    pip install -r requirements-build.txt
    pyinstaller meeting-notetaker-backend.spec

The output lands in ``backend/dist/notetaker-backend/``.
"""

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all

a = Analysis(
    ["run_backend.py"],
    pathex=[],
    binaries=[],
    datas=[
        # Ship ffmpeg.exe alongside the frozen backend.
        # SPECPATH is the spec file's own directory (backend/), so third_party
        # is a direct child — no .parent hop.
        # Conditional: only included when the binary exists locally; the
        # prepackage.cjs gate rejects any bundle built without it.
        *(
            [(
                str(Path(SPECPATH) / "third_party" / "ffmpeg" / "ffmpeg.exe"),
                "ffmpeg",
            )]
            if (Path(SPECPATH) / "third_party" / "ffmpeg" / "ffmpeg.exe").exists()
            else []
        ),
    ],
    hiddenimports=[
        # pydantic v2 internals (often missed by auto-detection).
        "pydantic.deprecated.decorator",
        "pydantic.functional_validators",
        # uvicorn internals.
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.loops.asyncio",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        # FastAPI Starlette internals.
        "starlette.routing",
        # Application modules (ensure all are collected).
        "app",
        "app.main",
        "app.config",
        "app.paths",
        "app.schemas",
        "app.store",
        "app.access",
        "app.routers",
        "app.routers.meetings",
        "app.routers.health",
        "app.routers.people",
        "app.routers.search",
        "app.routers.action_items",
        "app.services",
        "app.services.audio_checks",
        "app.services.email",
        "app.services.llm",
        "app.services.pipeline",
        "app.services.retention",
        "app.services.sharepoint",
        "app.services.speaker_embeddings",
        "app.services.speaker_matching",
        "app.services.speech",
        "app.services.voiceprints",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tests",
        "tests.*",
        "unittest",
        "pytest",
        "pip",
        "setuptools",
        "wheel",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=None)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="notetaker-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # Keep console for supervisor stdout/stderr capture
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="notetaker-backend",
)
