use std::{
    ffi::c_void,
    io::{self, Write},
    path::Path,
    thread,
    time::Duration,
};

use notetaker_audio_endpoints::{
    classify_window_process, is_teams_process_basename, AudioEndpoint, AudioEndpointSet,
    SnapshotEmitter, TeamsCallObservation, TeamsObservationEmitter, WindowProcessIdentity,
};
use windows::{
    core::{Interface, Result as WindowsResult, BOOL, BSTR, PWSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Foundation::{CloseHandle, ERROR_NO_MORE_FILES, HWND, LPARAM},
        Media::Audio::{
            eCapture, eCommunications, eConsole, eRender, AudioSessionStateActive, EDataFlow,
            ERole, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
            MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
            COINIT_MULTITHREADED, STGM_READ,
        },
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        },
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(750);
const MAX_TEAM_WINDOW_TITLES: usize = 16;
const MAX_TEAM_WINDOW_TITLE_LENGTH: usize = 256;

struct ComGuard;

impl ComGuard {
    fn initialize() -> WindowsResult<Self> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        Ok(Self)
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn read_endpoint(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    role: ERole,
) -> WindowsResult<AudioEndpoint> {
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(flow, role)? };
    let raw_id = unsafe { device.GetId()? };
    let id = unsafe { raw_id.to_string()? };
    unsafe { CoTaskMemFree(Some(raw_id.0.cast::<c_void>())) };

    let store = unsafe { device.OpenPropertyStore(STGM_READ)? };
    let value = unsafe { store.GetValue(&PKEY_Device_FriendlyName)? };
    let label = BSTR::try_from(&value)?.to_string();

    Ok(AudioEndpoint { id, label })
}

fn optional_endpoint(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    role: ERole,
    name: &str,
) -> (Option<AudioEndpoint>, Option<String>) {
    match read_endpoint(enumerator, flow, role) {
        Ok(endpoint) => (Some(endpoint), None),
        Err(error) => (
            None,
            Some(format!("audio endpoint {name} unavailable: {error}")),
        ),
    }
}

fn read_endpoints(enumerator: &IMMDeviceEnumerator) -> (AudioEndpointSet, Vec<String>) {
    let (capture_console, capture_console_error) =
        optional_endpoint(enumerator, eCapture, eConsole, "capture-console");
    let (capture_communications, capture_communications_error) = optional_endpoint(
        enumerator,
        eCapture,
        eCommunications,
        "capture-communications",
    );
    let (render_console, render_console_error) =
        optional_endpoint(enumerator, eRender, eConsole, "render-console");
    let (render_communications, render_communications_error) = optional_endpoint(
        enumerator,
        eRender,
        eCommunications,
        "render-communications",
    );
    let errors = [
        capture_console_error,
        capture_communications_error,
        render_console_error,
        render_communications_error,
    ]
    .into_iter()
    .flatten()
    .collect();
    (
        AudioEndpointSet {
            capture_console,
            capture_communications,
            render_console,
            render_communications,
        },
        errors,
    )
}

fn process_basename(process_id: u32) -> WindowsResult<String> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id)? };
    let result = (|| {
        let mut path = [0u16; 32768];
        let mut length = path.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(path.as_mut_ptr()),
                &mut length,
            )?;
        }
        let path = String::from_utf16_lossy(&path[..length as usize]);
        Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .ok_or_else(windows::core::Error::from_thread)
    })();
    unsafe {
        let _ = CloseHandle(process);
    }
    result
}

fn scan_active_teams_capture_sessions(enumerator: &IMMDeviceEnumerator) -> (Option<bool>, bool) {
    let devices = match unsafe { enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) } {
        Ok(devices) => devices,
        Err(_) => return (None, true),
    };
    let count = match unsafe { devices.GetCount() } {
        Ok(count) => count,
        Err(_) => return (None, true),
    };
    let mut found_teams_session = false;
    let mut scan_error = false;

    for index in 0..count {
        let device = match unsafe { devices.Item(index) } {
            Ok(device) => device,
            Err(_) => {
                scan_error = true;
                continue;
            }
        };
        let manager: IAudioSessionManager2 = match unsafe { device.Activate(CLSCTX_ALL, None) } {
            Ok(manager) => manager,
            Err(_) => {
                scan_error = true;
                continue;
            }
        };
        let sessions = match unsafe { manager.GetSessionEnumerator() } {
            Ok(sessions) => sessions,
            Err(_) => {
                scan_error = true;
                continue;
            }
        };
        let session_count = match unsafe { sessions.GetCount() } {
            Ok(session_count) => session_count,
            Err(_) => {
                scan_error = true;
                continue;
            }
        };

        for session_index in 0..session_count {
            let session = match unsafe { sessions.GetSession(session_index) } {
                Ok(session) => session,
                Err(_) => {
                    scan_error = true;
                    continue;
                }
            };
            let state = match unsafe { session.GetState() } {
                Ok(state) => state,
                Err(_) => {
                    scan_error = true;
                    continue;
                }
            };
            if state != AudioSessionStateActive {
                continue;
            }
            let session2: IAudioSessionControl2 = match session.cast() {
                Ok(session2) => session2,
                Err(_) => {
                    scan_error = true;
                    continue;
                }
            };
            let process_id = match unsafe { session2.GetProcessId() } {
                Ok(process_id) => process_id,
                Err(_) => {
                    scan_error = true;
                    continue;
                }
            };
            if process_id == 0 {
                continue;
            }
            match process_basename(process_id) {
                Ok(basename) if is_teams_process_basename(&basename) => {
                    found_teams_session = true;
                }
                Ok(_) => {}
                Err(_) => scan_error = true,
            }
        }
    }

    if found_teams_session {
        (Some(true), scan_error)
    } else if scan_error {
        (None, true)
    } else {
        (Some(false), false)
    }
}

fn snapshot_process_basename(process_id: u32) -> WindowsResult<Option<String>> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)? };
    let result = (|| {
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        unsafe { Process32FirstW(snapshot, &mut entry)? };
        loop {
            if entry.th32ProcessID == process_id {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                return Ok(Some(String::from_utf16_lossy(&entry.szExeFile[..end])));
            }
            match unsafe { Process32NextW(snapshot, &mut entry) } {
                Ok(()) => {}
                Err(error)
                    if error.code()
                        == windows::core::HRESULT::from_win32(ERROR_NO_MORE_FILES.0) =>
                {
                    return Ok(None)
                }
                Err(error) => return Err(error),
            }
        }
    })();
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    result
}

struct WindowScan {
    titles: Vec<String>,
    failed: bool,
    pre_join: bool,
}

unsafe extern "system" fn collect_teams_window(window: HWND, context: LPARAM) -> BOOL {
    let scan = unsafe { &mut *(context.0 as *mut WindowScan) };
    if !unsafe { IsWindowVisible(window) }.as_bool() {
        return BOOL(1);
    }

    let mut process_id = 0;
    if unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) } == 0 {
        scan.failed = true;
        return BOOL(1);
    }
    let direct = process_basename(process_id).ok();
    // Only on query failure: read a fresh OS process snapshot, never guess from
    // window titles. Recheck ownership afterward instead of using cached PIDs.
    let snapshot = if direct.is_none() {
        snapshot_process_basename(process_id).ok().flatten()
    } else {
        None
    };
    let mut confirmed_id = 0;
    if unsafe { GetWindowThreadProcessId(window, Some(&mut confirmed_id)) } == 0
        || confirmed_id != process_id
    {
        scan.failed = true;
        return BOOL(1);
    }
    match classify_window_process(direct.as_deref(), snapshot.as_deref()) {
        WindowProcessIdentity::Other => return BOOL(1),
        WindowProcessIdentity::Unknown => {
            scan.failed = true;
            return BOOL(1);
        }
        WindowProcessIdentity::Teams => {}
    }

    let mut title_buffer = [0u16; MAX_TEAM_WINDOW_TITLE_LENGTH + 1];
    let title_length = unsafe { GetWindowTextW(window, &mut title_buffer) };
    if title_length <= 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&title_buffer[..title_length as usize]);
    if title.to_ascii_lowercase().contains("meeting join") {
        scan.pre_join = true;
    }
    if scan.titles.len() < MAX_TEAM_WINDOW_TITLES
        && !scan.titles.iter().any(|existing| existing == &title)
    {
        scan.titles.push(title);
    }
    BOOL(1)
}

fn scan_teams_windows() -> (Vec<String>, bool, bool) {
    let mut scan = WindowScan {
        titles: Vec::new(),
        failed: false,
        pre_join: false,
    };
    let result = unsafe {
        EnumWindows(
            Some(collect_teams_window),
            LPARAM(&mut scan as *mut WindowScan as isize),
        )
    };
    if result.is_err() {
        scan.failed = true;
    }
    (scan.titles, scan.failed, scan.pre_join)
}

fn observe_teams_call(
    enumerator: &IMMDeviceEnumerator,
    emitter: &mut TeamsObservationEmitter,
) -> TeamsCallObservation {
    let (active, audio_scan_failed) = scan_active_teams_capture_sessions(enumerator);
    let (window_titles, window_scan_failed, pre_join) = scan_teams_windows();
    if audio_scan_failed {
        eprintln!("teams audio session observation unavailable");
    }
    if window_scan_failed {
        eprintln!("teams window observation unavailable");
    }
    let mut observation = emitter.observe_scan(active, window_scan_failed, window_titles);
    // The window scanner also checks titles beyond the bounded output list.
    observation.pre_join |= pre_join;
    observation
}

fn run(observe_teams: bool) -> Result<(), Box<dyn std::error::Error>> {
    let _com = ComGuard::initialize()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut emitter = SnapshotEmitter::default();
    let mut teams_emitter = TeamsObservationEmitter::default();

    loop {
        let (endpoints, errors) = read_endpoints(&enumerator);
        if let Some(snapshot) = emitter.observe(endpoints) {
            for error in errors {
                eprintln!("{error}");
            }
            serde_json::to_writer(&mut output, &snapshot)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
        if observe_teams {
            let observation = observe_teams_call(&enumerator, &mut teams_emitter);
            serde_json::to_writer(&mut output, &observation)?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn main() {
    let observe_teams = std::env::args().any(|argument| argument == "--observe-teams");
    if let Err(error) = run(observe_teams) {
        eprintln!("audio endpoint monitor failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod process_snapshot_tests {
    use super::*;

    #[test]
    fn fresh_os_snapshot_matches_direct_owned_process_identity() {
        let process_id = std::process::id();
        let direct = process_basename(process_id).expect("query own process");
        let snapshot = snapshot_process_basename(process_id)
            .expect("read OS snapshot")
            .expect("own PID exists");
        assert!(snapshot.eq_ignore_ascii_case(&direct));
    }
}
