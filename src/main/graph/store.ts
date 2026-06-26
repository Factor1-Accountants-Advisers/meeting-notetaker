import { readFile, writeFile } from 'fs/promises'
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
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text) as Partial<GraphSchedulerState>
    return { ...EMPTY_GRAPH_SCHEDULER_STATE, ...parsed, decisions: parsed.decisions ?? {} }
  } catch (err) {
    if (isNotFound(err)) return EMPTY_GRAPH_SCHEDULER_STATE
    throw err
  }
}

export async function writeGraphSchedulerState(
  path: string,
  state: GraphSchedulerState
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
