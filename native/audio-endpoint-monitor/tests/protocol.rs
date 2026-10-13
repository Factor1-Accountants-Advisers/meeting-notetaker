use notetaker_audio_endpoints::{
    is_teams_process_basename, AudioEndpoint, AudioEndpointSet, SnapshotEmitter,
    TeamsObservationEmitter,
};

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

#[test]
fn serializes_a_teams_call_heartbeat_shape() {
    let mut emitter = TeamsObservationEmitter::default();
    let observation = emitter.observe(Some(true), false, vec!["Meeting join".to_owned()]);
    let json = serde_json::to_value(observation).unwrap();

    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["kind"], "teams-call");
    assert_eq!(json["generation"], 1);
    assert_eq!(json["active"], true);
    assert_eq!(json["preJoin"], false);
    assert_eq!(json["windowTitles"][0], "Meeting join");
}

#[test]
fn window_scan_failure_cannot_turn_pre_join_into_a_connected_call() {
    let mut emitter = TeamsObservationEmitter::default();
    let observation = emitter.observe_scan(Some(true), true, vec!["Meeting join".to_owned()]);
    assert_eq!(observation.active, None);
    assert!(observation.pre_join);
}

#[test]
fn window_scan_failure_makes_audio_disconnect_unknown() {
    let mut emitter = TeamsObservationEmitter::default();
    let observation = emitter.observe_scan(Some(false), true, vec![]);
    assert_eq!(observation.active, None);
}

#[test]
fn healthy_scan_without_call_audio_preserves_disconnect() {
    let mut emitter = TeamsObservationEmitter::default();
    let observation = emitter.observe_scan(Some(false), false, vec![]);
    assert_eq!(observation.active, Some(false));
}

#[test]
fn healthy_scan_preserves_pre_join_and_connected_call_evidence() {
    let mut emitter = TeamsObservationEmitter::default();
    let pre_join = emitter.observe_scan(Some(true), false, vec!["Meeting join".to_owned()]);
    assert_eq!(pre_join.active, Some(true));
    assert!(pre_join.pre_join);
    let connected = emitter.observe_scan(Some(true), false, vec!["Call with Fixture".to_owned()]);
    assert_eq!(connected.active, Some(true));
    assert!(!connected.pre_join);
}

#[test]
fn recognizes_only_supported_teams_process_basenames() {
    assert!(is_teams_process_basename("ms-teams.exe"));
    assert!(is_teams_process_basename("Teams.exe"));
    assert!(is_teams_process_basename("ms-teams.EXE"));
    assert!(!is_teams_process_basename("msedgewebview2.exe"));
    assert!(!is_teams_process_basename("teams-helper.exe"));
}
