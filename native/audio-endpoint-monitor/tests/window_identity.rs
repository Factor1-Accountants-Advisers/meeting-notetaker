use notetaker_audio_endpoints::{
    classify_window_process, TeamsObservationEmitter, WindowProcessIdentity,
};

#[test]
fn inaccessible_verified_non_teams_window_does_not_poison_a_valid_call() {
    let unrelated = classify_window_process(None, Some("protected-console.exe"));
    assert_eq!(unrelated, WindowProcessIdentity::Other);
    let mut emitter = TeamsObservationEmitter::default();
    let call = emitter.observe_scan(
        Some(true),
        unrelated == WindowProcessIdentity::Unknown,
        vec!["Call with Fixture".to_owned()],
    );
    assert_eq!(call.active, Some(true));
}

#[test]
fn inaccessible_teams_process_still_fails_closed() {
    assert_eq!(
        classify_window_process(None, Some("ms-teams.exe")),
        WindowProcessIdentity::Unknown
    );
    let mut emitter = TeamsObservationEmitter::default();
    let call = emitter.observe_scan(Some(true), true, vec!["Call with Fixture".to_owned()]);
    assert_eq!(call.active, None);
}

#[test]
fn absent_or_failed_identity_snapshot_is_unknown() {
    assert_eq!(
        classify_window_process(None, None),
        WindowProcessIdentity::Unknown
    );
}

#[test]
fn direct_identity_remains_authoritative() {
    assert_eq!(
        classify_window_process(Some("Teams.EXE"), None),
        WindowProcessIdentity::Teams
    );
    assert_eq!(
        classify_window_process(Some("ms-teams.exe"), Some("other.exe")),
        WindowProcessIdentity::Teams
    );
    assert_eq!(
        classify_window_process(Some("other.exe"), Some("ms-teams.exe")),
        WindowProcessIdentity::Other
    );
    assert_eq!(
        classify_window_process(None, Some("msedgewebview2.exe")),
        WindowProcessIdentity::Other
    );
}
