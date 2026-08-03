import { readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { mkdir } from 'fs/promises'

export interface GraphSchedulerState {
  windowStartUtc?: string
  windowEndUtc?: string
  deltaLink?: string
  lastSuccessfulSyncUtc?: string
  backoffUntilUtc?: string
  decisions: Record<
    string,
    {
      reason: string
      autoRecordEligible: boolean
      startUtc?: string
      endUtc?: string
      updatedAtUtc: string
    }
  >
}

export const EMPTY_GRAPH_SCHEDULER_STATE: GraphSchedulerState = {
  decisions: {}
}

export async function readGraphSchedulerState(path: string): Promise<GraphSchedulerState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (isNotFound(err)) return EMPTY_GRAPH_SCHEDULER_STATE
    throw err
  }
  // A corrupt state file (interrupted write, disk hiccup) must never take the
  // whole calendar sync down — the state is a rebuildable cache, so discard it
  // and start from the empty window (observed in the field as a whitespace-only
  // file crashing every sync with an unhandled SyntaxError).
  try {
    const parsed = JSON.parse(text) as Partial<GraphSchedulerState> | null
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return EMPTY_GRAPH_SCHEDULER_STATE
    }
    const decisions =
      parsed.decisions && typeof parsed.decisions === 'object' && !Array.isArray(parsed.decisions)
        ? parsed.decisions
        : {}
    return { ...EMPTY_GRAPH_SCHEDULER_STATE, ...parsed, decisions }
  } catch {
    return EMPTY_GRAPH_SCHEDULER_STATE
  }
}

export async function writeGraphSchedulerState(
  path: string,
  state: GraphSchedulerState
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Write-then-rename so a crash mid-write leaves the previous state intact
  // instead of a truncated file (the corruption readGraphSchedulerState now
  // tolerates should never be produced by us in the first place).
  const tempPath = `${path}.tmp`
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tempPath, path)
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
