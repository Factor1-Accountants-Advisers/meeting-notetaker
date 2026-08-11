use notetaker_audio_endpoints::{AudioEndpoint, AudioEndpointSet, SnapshotEmitter};

fn endpoint(id: &str, label: &str) -> Option<AudioEndpoint> {
    Some(AudioEndpoint {
        id: id.to_owned(),
        label: label.to_owned(),
    })
}

fn endpoint_set(capture: &str, render: &str) -> AudioEndpointSet {
    AudioEndpointSet {
        capture_console: endpoint(capture, "Capture console"),
        capture_communications: endpoint(capture, "Capture communications"),
        render_console: endpoint(render, "Render console"),
        render_communications: endpoint(render, "Render communications"),
    }
}

#[test]
fn emits_only_when_endpoint_ids_change() {
    let mut emitter = SnapshotEmitter::default();
    let first = endpoint_set("capture-a", "render-a");

    assert_eq!(emitter.observe(first.clone()).unwrap().generation, 1);
    assert!(emitter.observe(first).is_none());
    assert_eq!(
        emitter
            .observe(endpoint_set("capture-b", "render-a"))
            .unwrap()
            .generation,
        2
    );
}

#[test]
fn label_change_is_emitted_for_diagnostics() {
    let mut emitter = SnapshotEmitter::default();
    let first = endpoint_set("capture-a", "render-a");
    emitter.observe(first.clone()).unwrap();

    let mut renamed = first;
    renamed.capture_communications.as_mut().unwrap().label = "Bluetooth mic".to_owned();
    let snapshot = emitter.observe(renamed).expect("renamed endpoint emits");

    assert_eq!(snapshot.generation, 2);
    assert_eq!(
        snapshot
            .endpoints
            .capture_communications
            .as_ref()
            .unwrap()
            .label,
        "Bluetooth mic"
    );
}

#[test]
fn serializes_the_typescript_v1_shape() {
    let mut emitter = SnapshotEmitter::default();
    let snapshot = emitter
        .observe(endpoint_set("capture-a", "render-a"))
        .unwrap();
    let json = serde_json::to_value(snapshot).unwrap();

    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["kind"], "snapshot");
    assert_eq!(
        json["endpoints"]["captureCommunications"]["id"],
        "capture-a"
    );
}
