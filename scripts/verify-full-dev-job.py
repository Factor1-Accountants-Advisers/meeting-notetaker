"""Real Windows kill-on-parent-close regression; fixture only, no app/providers."""
import ctypes
from ctypes import wintypes
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def parent_fixture(directory):
    directory = Path(directory)
    backend = directory / "fixture-backend.py"
    backend.write_text("from pathlib import Path\nimport os,time\nPath(__file__+'.started').write_text(str(os.getpid()))\ntime.sleep(180)\n")
    with (directory / "fixture-backend.log").open("w") as log:
        child = subprocess.Popen([sys.executable, str(ROOT / "scripts/run-full-dev-backend.py"),
                                  "--parent-pid", str(os.getpid()), "--parent-exe", sys.executable,
                                  "--backend", str(backend)], stdout=log, stderr=log)
    (directory / "parent.json").write_text(json.dumps({"parent": os.getpid(), "child": child.pid}))
    time.sleep(180)


def main():
    if "--parent-fixture" in sys.argv:
        parent_fixture(sys.argv[-1]); return
    if os.name != "nt":
        print(json.dumps({"mode": "windows-job-fixture", "skipped": "requires Windows"})); return
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    scratch = os.environ.get("TMPDIR") or os.environ.get("RUNNER_TEMP")
    with tempfile.TemporaryDirectory(prefix="full-dev-job-fixture-", dir=scratch) as folder:
        directory = Path(folder)
        # A Windows venv executable is a shim; its interpreter child has a
        # different image path. Use the base interpreter for this fake parent.
        parent = subprocess.Popen([getattr(sys, '_base_executable', sys.executable), __file__, "--parent-fixture", str(directory)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        parent_handle = child_handle = None
        try:
            started = directory / "fixture-backend.py.started"
            deadline = time.monotonic() + 15
            while not started.exists() and parent.poll() is None and time.monotonic() < deadline:
                time.sleep(.05)
            metadata = directory / "parent.json"
            if metadata.exists():
                parent_pid = json.loads(metadata.read_text())["parent"]
                parent_handle = kernel.OpenProcess(0x100000 | 1, False, parent_pid)
            log = directory / "fixture-backend.log"
            assert started.exists(), "owned backend did not start: " + (log.read_text() if log.exists() else "no fixture log")
            child_pid = int(started.read_text())
            child_handle = kernel.OpenProcess(0x100000, False, child_pid)
            assert parent_handle and child_handle
            assert kernel.WaitForSingleObject(child_handle, 0) == 258, "fixture child is running"
            assert kernel.TerminateProcess(parent_handle, 77), "terminate only the owned fixture parent"
            assert kernel.WaitForSingleObject(child_handle, 5000) == 0, "job must kill the owned backend without parent exit hooks"
            parent.wait(timeout=5)
            print(json.dumps({"mode": "windows-job-fixture", "parentForcedExit": True,
                              "ownedBackendTerminatedByKernel": True, "noAppOrProviderRequests": True}))
        finally:
            if parent_handle:
                if kernel.WaitForSingleObject(parent_handle, 0) == 258:
                    kernel.TerminateProcess(parent_handle, 77)
                kernel.CloseHandle(parent_handle)
            if child_handle: kernel.CloseHandle(child_handle)
            if parent.poll() is None: parent.kill(); parent.wait(timeout=5)


if __name__ == "__main__":
    main()
