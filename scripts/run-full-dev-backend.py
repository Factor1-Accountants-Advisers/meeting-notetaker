"""Windows dev ownership wrapper; run the existing backend unchanged.

Assign this backend to a kill-on-close job whose ONLY surviving handle belongs
 to the validated Electron parent. Windows then kills the backend and its
children even if Electron crashes or is force-terminated without JS exit hooks.
No service/port sweep, no persisted-PID recovery, no new dependency.
"""
import argparse
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import runpy
import sys


def bind_to_parent(parent_pid: int, parent_exe: str) -> None:
    if os.name != "nt":
        raise RuntimeError("Full-dev ownership requires Windows")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = wintypes.HANDLE
    kernel.GetCurrentProcess.restype = handle
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = handle
    kernel.CloseHandle.argtypes = [handle]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.QueryFullProcessImageNameW.argtypes = [handle, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = [handle] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = handle
    kernel.SetInformationJobObject.argtypes = [handle, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [handle, handle]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.DuplicateHandle.argtypes = [handle, handle, handle, ctypes.POINTER(handle), wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.DuplicateHandle.restype = wintypes.BOOL

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    def require(result):
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())
        return result

    def created(process):
        values = [wintypes.FILETIME() for _ in range(4)]
        require(kernel.GetProcessTimes(process, *(ctypes.byref(value) for value in values)))
        return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime

    # Query rights validate identity/start order; duplication transfers ownership.
    parent = require(kernel.OpenProcess(0x0040 | 0x1000, False, parent_pid))
    job = None
    try:
        name = ctypes.create_unicode_buffer(32768)
        length = wintypes.DWORD(len(name))
        require(kernel.QueryFullProcessImageNameW(parent, 0, name, ctypes.byref(length)))
        if os.path.normcase(os.path.realpath(name.value)) != os.path.normcase(os.path.realpath(parent_exe)):
            raise RuntimeError("Dev parent executable identity mismatch")
        current = kernel.GetCurrentProcess()
        if parent_pid == os.getpid() or created(parent) > created(current):
            raise RuntimeError("Dev parent ownership/start-time mismatch")
        job = require(kernel.CreateJobObjectW(None, None))
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        require(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        require(kernel.AssignProcessToJobObject(job, current))
        remote = handle()
        require(kernel.DuplicateHandle(current, job, parent, ctypes.byref(remote), 0, False, 2))
        # Non-inheritable remote handle survives only in the Electron parent.
        # Closing our last local handle leaves the kernel to enforce its lifetime.
    finally:
        kernel.CloseHandle(parent)
        if job:
            kernel.CloseHandle(job)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-pid", type=int, required=True)
    parser.add_argument("--parent-exe", required=True)
    parser.add_argument("--backend", required=True)
    args = parser.parse_args()
    entry = Path(args.backend).resolve(strict=True)
    bind_to_parent(args.parent_pid, args.parent_exe)
    sys.argv = [str(entry)]
    runpy.run_path(str(entry), run_name="__main__")


if __name__ == "__main__":
    main()
