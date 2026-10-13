export interface AudioEndpoint {
  id: string
  label: string
}

export interface AudioEndpointSet {
  captureConsole: AudioEndpoint | null
  captureCommunications: AudioEndpoint | null
  renderConsole: AudioEndpoint | null
  renderCommunications: AudioEndpoint | null
}

export interface AudioEndpointSnapshot {
  schemaVersion: 1
  kind: 'snapshot'
  generation: number
  endpoints: AudioEndpointSet
}

export interface TeamsCallObservation {
  schemaVersion: 1
  kind: 'teams-call'
  generation: number
  active: boolean | null
  preJoin: boolean
  windowTitles: string[]
}
