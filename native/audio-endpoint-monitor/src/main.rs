use std::{
    ffi::c_void,
    io::{self, Write},
    thread,
    time::Duration,
};

use notetaker_audio_endpoints::{AudioEndpoint, AudioEndpointSet, SnapshotEmitter};
use windows::{
    core::{Result as WindowsResult, BSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Media::Audio::{
            eCapture, eCommunications, eConsole, eRender, EDataFlow, ERole, IMMDeviceEnumerator,
            MMDeviceEnumerator,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
            COINIT_MULTITHREADED, STGM_READ,
        },
    },
};

const POLL_INTERVAL: Duration = Duration::from_millis(750);

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

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let _com = ComGuard::initialize()?;
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut emitter = SnapshotEmitter::default();

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
        thread::sleep(POLL_INTERVAL);
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("audio endpoint monitor failed: {error}");
        std::process::exit(1);
    }
}
