use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AudioEndpoint {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEndpointSet {
    pub capture_console: Option<AudioEndpoint>,
    pub capture_communications: Option<AudioEndpoint>,
    pub render_console: Option<AudioEndpoint>,
    pub render_communications: Option<AudioEndpoint>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioEndpointSnapshot {
    pub schema_version: u8,
    pub kind: &'static str,
    pub generation: u64,
    pub endpoints: AudioEndpointSet,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamsCallObservation {
    pub schema_version: u8,
    pub kind: &'static str,
    pub generation: u64,
    pub active: Option<bool>,
    pub pre_join: bool,
    pub window_titles: Vec<String>,
}

#[derive(Default)]
pub struct SnapshotEmitter {
    generation: u64,
    previous: Option<AudioEndpointSet>,
}

impl SnapshotEmitter {
    pub fn observe(&mut self, endpoints: AudioEndpointSet) -> Option<AudioEndpointSnapshot> {
        if self.previous.as_ref() == Some(&endpoints) {
            return None;
        }
        self.generation = self.generation.saturating_add(1);
        self.previous = Some(endpoints.clone());
        Some(AudioEndpointSnapshot {
            schema_version: 1,
            kind: "snapshot",
            generation: self.generation,
            endpoints,
        })
    }
}

#[derive(Default)]
pub struct TeamsObservationEmitter {
    generation: u64,
}

impl TeamsObservationEmitter {
    /// Incomplete window evidence can authorize neither joining nor hang-up.
    /// Missing capture audio alone cannot prove the call ended.
    pub fn observe_scan(
        &mut self,
        audio_active: Option<bool>,
        window_scan_failed: bool,
        window_titles: Vec<String>,
    ) -> TeamsCallObservation {
        let pre_join = window_titles
            .iter()
            .any(|title| title.to_ascii_lowercase().contains("meeting join"));
        let active = if window_scan_failed {
            None
        } else {
            audio_active
        };
        self.observe(active, pre_join, window_titles)
    }

    pub fn observe(
        &mut self,
        active: Option<bool>,
        pre_join: bool,
        window_titles: Vec<String>,
    ) -> TeamsCallObservation {
        self.generation = self.generation.saturating_add(1);
        TeamsCallObservation {
            schema_version: 1,
            kind: "teams-call",
            generation: self.generation,
            active,
            pre_join,
            window_titles,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowProcessIdentity {
    Teams,
    Other,
    Unknown,
}

/// A fresh OS snapshot can exclude a verified unrelated process, not authorize
/// a Teams window whose direct process query failed. Unknown remains uncertain.
pub fn classify_window_process(
    direct: Option<&str>,
    snapshot: Option<&str>,
) -> WindowProcessIdentity {
    match direct {
        Some(name) if is_teams_process_basename(name) => WindowProcessIdentity::Teams,
        Some(_) => WindowProcessIdentity::Other,
        None => match snapshot {
            Some(name) if !name.is_empty() && !is_teams_process_basename(name) => {
                WindowProcessIdentity::Other
            }
            _ => WindowProcessIdentity::Unknown,
        },
    }
}

pub fn is_teams_process_basename(basename: &str) -> bool {
    basename.eq_ignore_ascii_case("ms-teams.exe") || basename.eq_ignore_ascii_case("teams.exe")
}
