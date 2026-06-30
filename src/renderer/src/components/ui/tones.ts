/** Semantic colour pairings used by pills, avatars, and icon squares. */
export type Tone = 'info' | 'success' | 'warning' | 'danger' | 'secondary'

export const toneClasses: Record<Tone, string> = {
  info: 'bg-bg-info text-content-info',
  success: 'bg-bg-success text-content-success',
  warning: 'bg-bg-warning text-content-warning',
  danger: 'bg-bg-danger text-content-danger',
  secondary: 'bg-bg-secondary text-content-secondary'
}
