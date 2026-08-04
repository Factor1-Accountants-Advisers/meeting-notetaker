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
