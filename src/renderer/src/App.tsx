import { useCallback, useEffect, useRef, useState } from 'react'
import { AppShell } from './components/shell/AppShell'
import { EnrollmentModal } from './components/EnrollmentModal'
import { HomeScreen } from './screens/HomeScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { LoginScreen, type User } from './screens/LoginScreen'
import { RecordingScreen, type RecordingSession } from './screens/RecordingScreen'
import {
  createMeeting,
  emailNotes,
  ensureCurrentPerson,
  fetchEnrolmentStatus,
  fetchMeetings,
  fetchMeetingReview,
  retryBlobDelivery,
  retryPipeline,
  saveTranscriptToSharePoint,
  uploadAudio,
  type EnrolmentStatus,
  type GraphMeetingMetadata,
  type ManualMeetingAttendee,
  type MeetingDto,
  type SystemAudioSegmentUpload
} from './lib/api'
import { capture, type CaptureStatus, type SystemSegment } from './lib/capture'
import { emailFailureMessage } from './lib/deliveryNotice'
import notificationChimeUrl from './assets/notification.wav'
import { loadPrefs } from './lib/prefs'
import { audioDurationSeconds, blobToBase64 } from './lib/recorder'
import { elapsedMs } from './screens/RecordingScreen'
import { useTheme } from './lib/theme'
import type { ScreenId } from './lib/nav'
import type { BlobStatus, StaffMember } from './data/mock'

const USER_KEY = 'mn.user'

function loadUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

type View = ScreenId | 'recording'

// IN-129: interrupted-recording spill entries surfaced for recovery on launch.
type SpillEntry = Awaited<ReturnType<Window['api']['spillList']>>[number]

// Distinguishes spills orphaned by a previous run from any session started in
// this one — only pre-boot sessions are offered for recovery.
const APP_BOOT_MS = Date.now()

// IN-468: a device switch mid-recording splits system audio into segments;
// each is saved/uploaded with its timeline offset so the backend can stitch.
const systemSegmentFileName = (base: string, offsetMs: number): string =>
  offsetMs === 0 ? `${base}.system.webm` : `${base}.system.${offsetMs}.webm`

const systemSegmentManifestName = (base: string): string => `${base}.system.segments.json`

async function toSegmentUploads(segments: SystemSegment[]): Promise<SystemAudioSegmentUpload[]> {
  return Promise.all(
    segments.map(async (segment) => ({
      audioB64: await blobToBase64(segment.blob),
      mimeType: segment.blob.type || 'audio/webm',
      offsetMs: segment.offsetMs
    }))
  )
}

type PostCaptureState = 'processing' | 'emailing' | 'ready' | 'upload_failed' | 'processing_failed' | 'email_failed'

type PostCaptureNotice = {
  state: PostCaptureState
  meetingId: string
  title: string
  message: string
} | null

type BlobDeliveryNotice = {
  status: BlobStatus
  meetingId: string
  title: string
  message: string
  retrying: boolean
}

type BlobDeliveryState = Pick<MeetingDto, 'blob_status' | 'blob_error_message'>

const BLOB_DELIVERY_FALLBACK = 'Secure storage upload failed. Retry when connected.'
const BLOB_DELIVERY_TAKING_LONGER =
  'Secure storage is taking longer than expected. You can continue working while it finishes.'
const BLOB_DELIVERY_SLOW_POLL_AFTER_MS = 10 * 60 * 1000

function blobDeliveryNotice(
  meetingId: string,
  title: string,
  meeting: BlobDeliveryState,
  retrying: boolean,
  pendingMessage = 'Saving meeting record to secure storage…'
): BlobDeliveryNotice {
  const status = meeting.blob_status
  return {
    status,
    meetingId,
    title,
    message:
      status === 'uploaded'
        ? 'Meeting record saved to secure storage.'
        : status === 'pending'
          ? pendingMessage
          : meeting.blob_error_message ?? BLOB_DELIVERY_FALLBACK,
    retrying: status === 'pending' && retrying
  }
}

function App(): JSX.Element {
  const [user, setUser] = useState<User | null>(loadUser)
  const [authChecked, setAuthChecked] = useState(Boolean(loadUser()))
  const [currentPerson, setCurrentPerson] = useState<StaffMember | null>(null)
  const [enrolmentStatus, setEnrolmentStatus] = useState<EnrolmentStatus | null>(null)
  // IN-379/Slice 2 vocabulary spells this single-l "enrolment"; the file's
  // older Slice 1 identifiers (currentPerson aside, see enrollmentLoading,
  // EnrollmentModal, etc. below) keep the double-l "enrollment" spelling.
  // Same concept — grep for one and you will miss the other.
  const enrolmentEpochRef = useRef(0)
  const [enrollmentLoading, setEnrollmentLoading] = useState(false)
  // Bumping this re-runs the enrollment gate fetch (Try again after failure).
  const [enrollmentAttempt, setEnrollmentAttempt] = useState(0)
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null)

  // IN-379 gate. Post-cutover (central_required) ONLY central enrolment passes —
  // local records are structurally invisible (spec §Cutover semantics).
  // Pre-cutover, backend enrolled_locally OR the session's own person record
  // passes: equivalent trust to Slice 1, and resilient to a cold-start
  // status fetched before the main process knows the account email.
  // status null covers ANY failed status call, not just an unreachable
  // backend (a thrown request, a transient single-route failure on the
  // first try, etc.) — falls back to Slice 1 behaviour. Two defence layers
  // guard the gate against that fallback firing when it shouldn't: the
  // server-side fail-closed catch in /people/me/enrolment-status (missing
  // identity header or a StorageApiError both answer false, never 500) and
  // the renderer retry loop below, which treats a person-ok-but-status-null
  // result as retryable rather than accepting it on the first try.
  const enrolmentSatisfied = enrolmentStatus
    ? (enrolmentStatus.central_required
        ? enrolmentStatus.centrally_enrolled
        : enrolmentStatus.enrolled_locally || currentPerson?.enrollment === 'enrolled')
    : currentPerson?.enrollment === 'enrolled'
  const [view, setView] = useState<View>('home')
  const [recording, setRecording] = useState<RecordingSession | null>(null)
  const [extending, setExtending] = useState(false)
  const recordingRef = useRef<RecordingSession | null>(null)
  const autoGraphMetadataRef = useRef<GraphMeetingMetadata | null>(null)
  const controlHandlersRef = useRef<{ pause: () => void; resume: () => void; stop: () => void }>({
    pause: () => {},
    resume: () => {},
    stop: () => {}
  })
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null)
  const [autoRecordingState, setAutoRecordingState] = useState<'idle' | 'recording' | 'processing'>('idle')
  const [postCaptureNotice, setPostCaptureNotice] = useState<PostCaptureNotice>(null)
  const [blobDeliveryNotices, setBlobDeliveryNotices] = useState<
    Record<string, BlobDeliveryNotice>
  >({})
  const blobDeliveryEpochSequenceRef = useRef(0)
  const blobDeliveryHydrationSessionRef = useRef(0)
  const blobDeliveryEpochsRef = useRef(new Map<string, number>())
  const blobDeliveryTimersRef = useRef(new Map<string, number>())
  const [interrupted, setInterrupted] = useState<SpillEntry[]>([])
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    return () => {
      for (const timer of blobDeliveryTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      blobDeliveryTimersRef.current.clear()
      blobDeliveryEpochsRef.current.clear()
    }
  }, [])

  // On cold start, check whether a persisted MSAL cache exists. If the user was
  // signed in last session, skip the login screen and restore the session from
  // the cached account email so auto-record + delivery work without re-prompting.
  useEffect(() => {
    if (authChecked) return
    if (typeof window.api?.getAuthStatus !== 'function') {
      setAuthChecked(true)
      return
    }
    window.api.getAuthStatus().then((status) => {
      if (!status.signedIn) {
        localStorage.removeItem(USER_KEY)
        setAuthChecked(true)
        return
      }
      // Restore from localStorage if available, otherwise create a session entry
      // from the cached account info so the voiceprint gate and auto-record fire.
      const stored = loadUser()
      if (stored) {
        setUser(stored)
        setAuthChecked(true)
        return
      }
      if (status.email) {
        const restored: User = {
          name: status.name ?? status.email.split('@')[0],
          email: status.email
        }
        localStorage.setItem(USER_KEY, JSON.stringify(restored))
        setUser(restored)
      }
      setAuthChecked(true)
    }).catch(() => {
      setAuthChecked(true)
    })
  }, [authChecked])

  // Keep the latest recording session available to auto-stop callbacks.
  useEffect(() => {
    recordingRef.current = recording
  }, [recording])

  const applyScheduledEndUtc = useCallback((endTimeUtc: string): void => {
    setRecording((current) => {
      if (!current) return current
      const next = { ...current, scheduledEndUtc: endTimeUtc }
      // Pause/resume and auto-stop callbacks read the ref synchronously. Keep it
      // aligned with the rendered countdown instead of waiting for the effect.
      recordingRef.current = next
      return next
    })
  }, [])

  // Keep the main process informed so backend calls carry the audit actor.
  useEffect(() => {
    if (typeof window.api?.setUser === 'function') window.api.setUser(user?.name ?? '')
  }, [user])

  // IN-129: surface recordings interrupted by sleep/crash for recovery.
  useEffect(() => {
    if (!user || typeof window.api?.spillList !== 'function') return
    let cancelled = false
    window.api
      .spillList()
      .then((entries) => {
        const orphans = entries.filter((e) => Date.parse(e.startedAtUtc) < APP_BOOT_MS)
        if (!cancelled && orphans.length) setInterrupted(orphans)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [user])

  // Mid-capture status changes (e.g. mic falls silent) must reach the UI live.
  useEffect(() => {
    capture.setStatusListener((status) => setCaptureStatus(status))
    return () => capture.setStatusListener(null)
  }, [])

  // Live audio levels for the input meter (IN-128).
  useEffect(() => {
    capture.setLevelListener((micLevel, loopbackLevel) =>
      setCaptureStatus((prev) =>
        prev ? { ...prev, micLevel, loopbackLevel } : prev
      )
    )
    return () => capture.setLevelListener(null)
  }, [])

  // OS toasts are shown silent; the renderer owns the Notetaker chime so the
  // bundled wav works in an unpackaged win32 app (IN-477). The window only
  // hides to the tray, so this listener stays alive while "closed".
  useEffect(() => {
    if (typeof window.api?.onNotificationChime !== 'function') return
    const chime = new Audio(notificationChimeUrl)
    return window.api.onNotificationChime(() => {
      chime.currentTime = 0
      void chime.play().catch(() => undefined)
    })
  }, [])

  // Required staff voiceprint gate after Microsoft sign-in.
  useEffect(() => {
    let cancelled = false
    if (!user) {
      setCurrentPerson(null)
      setEnrolmentStatus(null)
      setEnrollmentError(null)
      setEnrollmentLoading(false)
      return
    }

    setEnrollmentLoading(true)
    setEnrollmentError(null)

    // At Windows-boot launch (IN-71) the packaged backend takes up to ~20s to
    // spawn and pass health checks, so a single fetch races it and strands the
    // user on the "Voiceprint required" error. Retry with backoff (~50s total)
    // before surfacing the failure; skip retries when there is no IPC bridge
    // at all (browser preview) since waiting cannot help there.
    const retryDelaysMs =
      typeof window.api?.request === 'function' ? [1000, 2000, 3000, 5000, 5000, 5000, 10000, 10000, 10000] : []
    const run = async (): Promise<void> => {
      let lastErrorMessage: string | null = null
      // A person that resolves alongside a null status means the backend
      // answered one of the two calls but not the other — anomalous, and
      // worth retrying rather than accepting on the first try. If retries
      // exhaust while still in that state, fall back to the person with a
      // null status (existing Slice 1 fallback) instead of surfacing a hard
      // error the backend never actually reported.
      let lastPersonWithNullStatus: StaffMember | null = null
      for (let attempt = 0; ; attempt++) {
        try {
          // Fetched alongside the person so the gate has fresh status the
          // moment the person record resolves (IN-379).
          const [person, status] = await Promise.all([
            ensureCurrentPerson(user.name, user.email),
            fetchEnrolmentStatus()
          ])
          if (cancelled) return
          if (person && status) {
            setCurrentPerson(person)
            setEnrolmentStatus(status)
            setEnrollmentLoading(false)
            return
          }
          lastPersonWithNullStatus = person && !status ? person : null
          lastErrorMessage = null
        } catch (err) {
          if (cancelled) return
          lastErrorMessage = err instanceof Error ? err.message : null
          lastPersonWithNullStatus = null
        }
        const delay = retryDelaysMs[attempt]
        if (delay === undefined) break
        await new Promise((resolve) => setTimeout(resolve, delay))
        if (cancelled) return
      }
      if (lastPersonWithNullStatus) {
        setCurrentPerson(lastPersonWithNullStatus)
        setEnrolmentStatus(null)
        setEnrollmentLoading(false)
        return
      }
      setCurrentPerson(null)
      setEnrolmentStatus(null)
      setEnrollmentError(
        lastErrorMessage ??
          'Could not load your staff enrollment record. Check that the backend is running, then try again.'
      )
      setEnrollmentLoading(false)
    }
    void run()

    return () => {
      cancelled = true
    }
  }, [user, enrollmentAttempt])

  // Reflect extends triggered from the tray menu or toast button (IN-124) in
  // the on-screen countdown.
  useEffect(() => {
    if (typeof window.api?.onRecordingEndExtended !== 'function') return
    return window.api.onRecordingEndExtended((data) => {
      if (data?.endTimeUtc) {
        applyScheduledEndUtc(data.endTimeUtc)
      }
    })
  }, [applyScheduledEndUtc])

  // Listen for auto-recording commands from the main process (IN-66).
  useEffect(() => {
    if (!user || !enrolmentSatisfied || typeof window.api?.onAutoStartRequest !== 'function') return

    const unsubStart = window.api.onAutoStartRequest(async (data) => {
      try {
        if (recordingRef.current) {
          window.api.notifyRecordingError('Auto-recording skipped because another recording is already active.')
          return
        }
        const graphMetadata = data.metadata ?? null
        autoGraphMetadataRef.current = graphMetadata
        const title = graphMetadata?.title?.trim() || 'Auto-recorded Teams meeting'
        const created = await createMeeting(title, graphMetadata?.joinWebUrl ?? null, 'online', graphMetadata)
        const status = await capture.start('online', loadPrefs().micDeviceId, {
          title,
          meetingId: created?.id ?? null,
          graphMetadata
        })
        setCaptureStatus(status)
        setRecording({
          meetingId: created?.id ?? null,
          title,
          source: 'online',
          startedAt: Date.now(),
          pausedAccum: 0,
          pausedAt: null,
          scheduledEndUtc: data.endTimeUtc || null
        })
        setView('recording')
        setAutoRecordingState('recording')
        window.api.notifyRecordingStarted()
      } catch (err) {
        window.api.notifyRecordingError(err instanceof Error ? err.message : String(err))
      }
    })

    let stopping = false
    const finishActiveRecording = async (): Promise<void> => {
      if (stopping) return
      stopping = true
      try {
        setAutoRecordingState('processing')
        // Leave the active controls immediately. Capture finalization and upload
        // may take time, but the user should never be left on a dead recording
        // screen after auto-stop (or a manual Stop).
        setView('home')
        const session = recordingRef.current
        const meetingId = session?.meetingId ?? null
        const graphMetadata = autoGraphMetadataRef.current
        const durationSeconds = session ? Math.round(elapsedMs(session) / 1000) : null
        window.api.debugLog('recording stop requested', { meetingId, durationSeconds })
        const result = await capture.stop(session ? elapsedMs(session) : undefined)
        const systemSegments =
          result?.systemSegments ??
          (result?.systemBlob ? [{ blob: result.systemBlob, offsetMs: 0 }] : [])
        window.api.debugLog('capture stop resolved', {
          hasBlob: Boolean(result?.blob),
          size: result?.blob.size ?? 0,
          hasSystemBlob: Boolean(result?.systemBlob),
          systemSize: result?.systemBlob?.size ?? 0,
          systemSegments: systemSegments.length,
          segmentOffsetsMs: systemSegments.map((s) => s.offsetMs),
          durationSeconds
        })
        if (result) {
          let savedLocally = false
          const name = `${meetingId ?? `auto-${Date.now()}`}.webm`
          const base = name.replace(/\.webm$/i, '')
          try {
            await window.api.saveRecording(name, await result.blob.arrayBuffer())
            for (const segment of systemSegments) {
              await window.api.saveRecording(
                systemSegmentFileName(base, segment.offsetMs),
                await segment.blob.arrayBuffer()
              )
            }
            if (systemSegments.length > 1) {
              // Manifest lets the retry-from-local path rebuild the timeline.
              const manifest = systemSegments.map((segment) => ({
                file: systemSegmentFileName(base, segment.offsetMs),
                offsetMs: segment.offsetMs
              }))
              const encoded = new TextEncoder().encode(JSON.stringify(manifest))
              await window.api.saveRecording(
                systemSegmentManifestName(base),
                encoded.buffer.slice(0, encoded.byteLength) as ArrayBuffer
              )
            }
            savedLocally = true
            capture.discardCompletedSpill()
          } catch {
            // Local save failed — still try upload.
          }
          if (meetingId) {
            window.api.debugLog('audio upload starting', {
              meetingId,
              size: result.blob.size,
              systemSize: result.systemBlob?.size ?? 0,
              systemSegments: systemSegments.length,
              durationSeconds
            })
            const uploadedMeeting = await uploadAudio(
              meetingId,
              await blobToBase64(result.blob),
              result.blob.type || 'audio/webm',
              durationSeconds,
              graphMetadata,
              systemSegments.length > 0 ? await toSegmentUploads(systemSegments) : null
            )
            window.api.debugLog('audio upload finished', {
              meetingId,
              ok: Boolean(uploadedMeeting),
              durationSeconds
            })
            if (uploadedMeeting && !savedLocally) capture.discardCompletedSpill()
            if (uploadedMeeting) {
              watchProcessing(meetingId, session?.title ?? graphMetadata?.title ?? 'Recording')
            } else {
              setPostCaptureNotice({
                state: 'upload_failed',
                meetingId,
                title: session?.title ?? graphMetadata?.title ?? 'Recording',
                message: 'Recording saved locally, but upload failed. Retry once the backend is reachable.'
              })
            }
          }
        }
        recordingRef.current = null
        setRecording(null)
        autoGraphMetadataRef.current = null
        setCaptureStatus(null)
        setAutoRecordingState('idle')
        window.api.notifyRecordingStopped()
      } catch (err) {
        stopping = false
        setAutoRecordingState(recordingRef.current ? 'recording' : 'idle')
        window.api.notifyRecordingError(err instanceof Error ? err.message : String(err))
      }
    }

    const pauseActiveRecording = (): void => {
      const session = recordingRef.current
      if (stopping || !session || session.pausedAt !== null) return
      const pausedAt = Date.now()
      capture.pause()
      const next = { ...session, pausedAt }
      recordingRef.current = next
      setRecording(next)
      window.api.notifyRecordingPausedChanged(true)
    }

    const resumeActiveRecording = (): void => {
      const session = recordingRef.current
      if (stopping || !session || session.pausedAt === null) return
      capture.resume()
      const next = {
        ...session,
        pausedAccum: session.pausedAccum + (Date.now() - session.pausedAt),
        pausedAt: null
      }
      recordingRef.current = next
      setRecording(next)
      window.api.notifyRecordingPausedChanged(false)
    }

    const controls = {
      pause: pauseActiveRecording,
      resume: resumeActiveRecording,
      stop: () => void finishActiveRecording()
    }
    controlHandlersRef.current = controls

    const unsubStop = window.api.onAutoStopRequest(controls.stop)
    const unsubTrayControl = window.api.onTrayRecordingControl((action) => {
      controls[action]()
    })

    if (typeof window.api.notifyRecordingReady === 'function') {
      window.api.notifyRecordingReady()
    }

    return () => {
      unsubStart()
      unsubStop()
      unsubTrayControl()
      if (controlHandlersRef.current === controls) {
        controlHandlersRef.current = { pause: () => {}, resume: () => {}, stop: () => {} }
      }
    }
  }, [user, enrolmentSatisfied])

  useEffect(() => {
    const hydrationSession = ++blobDeliveryHydrationSessionRef.current
    let cancelled = false

    if (user) {
      void (async () => {
        try {
          const meetings = await fetchMeetings()
          if (
            cancelled ||
            blobDeliveryHydrationSessionRef.current !== hydrationSession ||
            !meetings
          ) {
            return
          }

          for (const meeting of meetings) {
            if (
              cancelled ||
              blobDeliveryHydrationSessionRef.current !== hydrationSession
            ) {
              return
            }
            if (
              meeting.pipelineStatus !== 'ready' ||
              (meeting.blobStatus !== 'pending' && meeting.blobStatus !== 'failed') ||
              blobDeliveryEpochsRef.current.has(meeting.id)
            ) {
              continue
            }

            const epoch = nextBlobDeliveryEpoch(meeting.id)
            const delivery: BlobDeliveryState = {
              blob_status: meeting.blobStatus,
              blob_error_message: meeting.blobErrorMessage
            }
            if (meeting.blobStatus === 'pending') {
              watchBlobDelivery(meeting.id, meeting.title, delivery, epoch, false)
            } else {
              upsertBlobDeliveryNotice(
                blobDeliveryNotice(meeting.id, meeting.title, delivery, false)
              )
            }
          }
        } catch {
          // Hydration is best-effort. Never create sample or technical-error notices.
        }
      })()
    }

    return () => {
      cancelled = true
      if (blobDeliveryHydrationSessionRef.current === hydrationSession) {
        blobDeliveryHydrationSessionRef.current += 1
      }
    }
  }, [user?.email])

  if (!authChecked) {
    return <div className="flex h-full items-center justify-center bg-page"><span className="h-5 w-5 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" /></div>
  }

  if (!user) {
    return (
      <LoginScreen
        onSignedIn={(u) => {
          localStorage.setItem(USER_KEY, JSON.stringify(u))
          setUser(u)
        }}
      />
    )
  }

  const startManualRecording = async (
    title: string,
    manualAttendees: ManualMeetingAttendee[]
  ): Promise<void> => {
    if (recordingRef.current) return
    const startedAt = Date.now()
    const source = 'online' as const
    const created = await createMeeting(title, null, source, null, manualAttendees)
    const meetingId = created?.id ?? null
    const status = await capture.start(source, loadPrefs().micDeviceId, {
      title,
      meetingId,
      graphMetadata: null
    })
    setCaptureStatus(status)
    if (!status.recording) {
      window.api.debugLog('manual recording could not start', { title, status })
      return
    }

    const manualKey = meetingId ?? `manual-${startedAt}`
    window.api.notifyManualRecordingStarted({
      eventId: manualKey,
      idempotencyKey: manualKey,
      startTimeUtc: new Date(startedAt).toISOString(),
      // Manual recordings have no scheduled end. This only supplies the state
      // machine's required shape; no auto-stop timer is armed for this source.
      endTimeUtc: new Date(startedAt + 8 * 60 * 60 * 1000).toISOString(),
      source: 'manual',
      title
    })
    autoGraphMetadataRef.current = null
    setRecording({
      meetingId,
      title,
      source,
      startedAt,
      pausedAccum: 0,
      pausedAt: null,
      scheduledEndUtc: null
    })
    setAutoRecordingState('recording')
    setView('recording')
  }

  const navigate = (id: ScreenId): void => {
    setView(id)
  }

  const clearBlobDeliveryTimer = (meetingId: string): void => {
    const timer = blobDeliveryTimersRef.current.get(meetingId)
    if (timer !== undefined) window.clearTimeout(timer)
    blobDeliveryTimersRef.current.delete(meetingId)
  }

  const nextBlobDeliveryEpoch = (meetingId: string): number => {
    clearBlobDeliveryTimer(meetingId)
    const epoch = ++blobDeliveryEpochSequenceRef.current
    blobDeliveryEpochsRef.current.set(meetingId, epoch)
    return epoch
  }

  const blobDeliveryIsCurrent = (meetingId: string, epoch: number): boolean =>
    blobDeliveryEpochsRef.current.get(meetingId) === epoch

  const upsertBlobDeliveryNotice = (notice: BlobDeliveryNotice): void => {
    setBlobDeliveryNotices((current) => ({
      ...current,
      [notice.meetingId]: notice
    }))
  }

  const removeBlobDeliveryNotice = (meetingId: string): void => {
    setBlobDeliveryNotices((current) => {
      if (!(meetingId in current)) return current
      const next = { ...current }
      delete next[meetingId]
      return next
    })
  }

  const watchBlobDelivery = (
    meetingId: string,
    title: string,
    initialMeeting: BlobDeliveryState,
    epoch: number,
    retrying: boolean
  ): void => {
    const startedAt = Date.now()

    const applyAndSchedule = (meeting: BlobDeliveryState): void => {
      if (!blobDeliveryIsCurrent(meetingId, epoch)) return
      clearBlobDeliveryTimer(meetingId)

      const elapsedMs = Date.now() - startedAt
      upsertBlobDeliveryNotice(
        blobDeliveryNotice(
          meetingId,
          title,
          meeting,
          retrying,
          elapsedMs >= BLOB_DELIVERY_SLOW_POLL_AFTER_MS
            ? BLOB_DELIVERY_TAKING_LONGER
            : undefined
        )
      )
      if (meeting.blob_status !== 'pending') return

      const delayMs =
        elapsedMs < 120_000
          ? 2000
          : elapsedMs < BLOB_DELIVERY_SLOW_POLL_AFTER_MS
            ? 5000
            : 15_000
      const timer = window.setTimeout(() => {
        blobDeliveryTimersRef.current.delete(meetingId)
        if (!blobDeliveryIsCurrent(meetingId, epoch)) return

        void (async () => {
          let nextMeeting = meeting
          try {
            const review = await fetchMeetingReview(meetingId)
            if (!blobDeliveryIsCurrent(meetingId, epoch)) return
            if (review) nextMeeting = review.meeting
          } catch {
            // Poll through transient failures; never surface transport or provider details.
          }
          if (blobDeliveryIsCurrent(meetingId, epoch)) applyAndSchedule(nextMeeting)
        })()
      }, delayMs)
      blobDeliveryTimersRef.current.set(meetingId, timer)
    }

    applyAndSchedule(initialMeeting)
  }

  const watchProcessing = (meetingId: string, title: string): void => {
    const blobDeliveryEpoch = nextBlobDeliveryEpoch(meetingId)
    setPostCaptureNotice({
      state: 'processing',
      meetingId,
      title,
      message: 'Recording uploaded. Processing transcript, summary, and action items…'
    })

    // Poll until the backend reports a terminal state. The window covers the
    // backend watchdog's own stall limit (provider timeout + buffer) so a
    // legitimately long meeting is never abandoned before the backend has
    // decided ready/failed. A genuine strand now surfaces as backend `failed`.
    const startedAt = Date.now()
    const pollWindowMs = 45 * 60 * 1000
    const poll = async (): Promise<void> => {
      const elapsedMs = Date.now() - startedAt
      const review = await fetchMeetingReview(meetingId)
      const status = review?.meeting.pipeline_status
      const stageMessage = review?.meeting.pipeline_stage_message
      if (status === 'ready' && review) {
        void watchBlobDelivery(
          meetingId,
          title,
          review.meeting,
          blobDeliveryEpoch,
          false
        )
        setPostCaptureNotice({
          state: 'emailing',
          meetingId,
          title,
          message: `Notes are ready: ${review.segments.length} transcript segments and ${review.action_items.length} action items. Saving to SharePoint and emailing transcript…`
        })
        const sharePointResult = await saveTranscriptToSharePoint(meetingId)
        const emailResult = await emailNotes(meetingId, null, user.email)
        // IN-478: a failed email call may still have delivered (transport
        // error or backend restart mid-send). Re-check delivery state so the
        // notice warns "check your inbox" instead of inviting a blind resend.
        const deliveryAfterFailure = emailResult ? null : (await fetchMeetingReview(meetingId))?.meeting
        if (emailResult && sharePointResult?.sharepoint_web_url) {
          setPostCaptureNotice({
            state: 'ready',
            meetingId,
            title,
            message: `Transcript saved to SharePoint and emailed to ${emailResult.recipients.join(', ')}.`
          })
        } else if (emailResult) {
          setPostCaptureNotice({
            state: 'email_failed',
            meetingId,
            title,
            message: 'Transcript email was sent, but SharePoint save failed. Sign in again, then retry delivery.'
          })
        } else if (sharePointResult?.sharepoint_web_url) {
          setPostCaptureNotice({
            state: 'email_failed',
            meetingId,
            title,
            message: emailFailureMessage(
              deliveryAfterFailure?.delivery_status,
              deliveryAfterFailure?.delivery_error_message,
              'Transcript saved to SharePoint, but email was not sent. Sign in to Outlook, then retry email.'
            )
          })
        } else {
          setPostCaptureNotice({
            state: 'email_failed',
            meetingId,
            title,
            message: emailFailureMessage(
              deliveryAfterFailure?.delivery_status,
              deliveryAfterFailure?.delivery_error_message,
              'Notes are ready, but SharePoint save and transcript email failed. Sign in to Microsoft, then retry delivery.'
            )
          })
        }
        return
      }
      if (status === 'failed') {
        setPostCaptureNotice({
          state: 'processing_failed',
          meetingId,
          title,
          message: 'Processing failed. The recording is saved and can be retried.'
        })
        return
      }
      if (elapsedMs < pollWindowMs) {
        if (stageMessage) {
          setPostCaptureNotice({
            state: 'processing',
            meetingId,
            title,
            message: stageMessage
          })
        }
        // Fine-grained early on, then ease off for long transcriptions.
        window.setTimeout(() => void poll(), elapsedMs < 120_000 ? 2000 : 5000)
        return
      }

      setPostCaptureNotice({
        state: 'processing_failed',
        meetingId,
        title,
        message: 'Processing status is taking longer than expected. The recording is saved; retry will check the backend and continue from the saved state.'
      })
    }

    void poll()
  }

  const retryMeetingBlobDelivery = async (
    meetingId: string,
    title: string
  ): Promise<void> => {
    const epoch = nextBlobDeliveryEpoch(meetingId)
    upsertBlobDeliveryNotice({
      status: 'pending',
      meetingId,
      title,
      message: 'Saving meeting record to secure storage…',
      retrying: true
    })

    try {
      const meeting = await retryBlobDelivery(meetingId)
      if (!blobDeliveryIsCurrent(meetingId, epoch)) return
      if (meeting) {
        watchBlobDelivery(meetingId, title, meeting, epoch, true)
        return
      }
    } catch {
      // The error may contain implementation details; show only the fixed fallback.
    }

    if (blobDeliveryIsCurrent(meetingId, epoch)) {
      upsertBlobDeliveryNotice({
        status: 'failed',
        meetingId,
        title,
        message: BLOB_DELIVERY_FALLBACK,
        retrying: false
      })
    }
  }

  const dismissBlobDeliveryNotice = (meetingId: string): void => {
    nextBlobDeliveryEpoch(meetingId)
    removeBlobDeliveryNotice(meetingId)
  }

  const retryTranscriptEmail = async (meetingId: string, title: string): Promise<void> => {
    let recorderEmail = user.email
    setPostCaptureNotice({
      state: 'emailing',
      meetingId,
      title,
      message: 'Connecting to Outlook…'
    })

    if (typeof window.api?.signIn === 'function') {
      const signedIn = await window.api.signIn()
      if (signedIn.ok && signedIn.name && signedIn.email) {
        const nextUser = { name: signedIn.name, email: signedIn.email }
        recorderEmail = signedIn.email
        localStorage.setItem(USER_KEY, JSON.stringify(nextUser))
        setUser(nextUser)
      } else {
        setPostCaptureNotice({
          state: 'email_failed',
          meetingId,
          title,
          message: signedIn.error || 'Outlook sign-in did not complete. Transcript email was not sent.'
        })
        return
      }
    }

    setPostCaptureNotice({
      state: 'emailing',
      meetingId,
      title,
      message: 'Retrying SharePoint save and transcript email…'
    })
    const sharePointResult = await saveTranscriptToSharePoint(meetingId)
    const emailResult = await emailNotes(meetingId, null, recorderEmail)
    // IN-478: same as the post-capture watcher — a failed call may still have
    // delivered, so let the backend's unconfirmed warning replace "failed".
    const deliveryAfterFailure = emailResult ? null : (await fetchMeetingReview(meetingId))?.meeting
    setPostCaptureNotice({
      state: emailResult && sharePointResult?.sharepoint_web_url ? 'ready' : 'email_failed',
      meetingId,
      title,
      message: emailResult && sharePointResult?.sharepoint_web_url
        ? `Transcript saved to SharePoint and emailed to ${emailResult.recipients.join(', ')}.`
        : emailResult
          ? 'Transcript email was sent, but SharePoint save still failed.'
          : sharePointResult?.sharepoint_web_url
            ? emailFailureMessage(
                deliveryAfterFailure?.delivery_status,
                deliveryAfterFailure?.delivery_error_message,
                'Transcript saved to SharePoint, but email still failed.'
              )
            : emailFailureMessage(
                deliveryAfterFailure?.delivery_status,
                deliveryAfterFailure?.delivery_error_message,
                'SharePoint save and email still failed. The notes are ready and the recording is safe.'
              )
    })
  }

  const retrySavedUpload = async (meetingId: string, title: string): Promise<void> => {
    setPostCaptureNotice({
      state: 'processing',
      meetingId,
      title,
      message: 'Retrying upload from the saved local recording…'
    })

    const mic = await window.api.readRecording(`${meetingId}.webm`)
    if (!mic.exists || !mic.data) {
      setPostCaptureNotice({
        state: 'upload_failed',
        meetingId,
        title,
        message: 'Could not find the saved local recording to retry upload. Please keep this app open and contact support.'
      })
      return
    }

    // Segmented capture (IN-468): a manifest sidecar lists every system-audio
    // segment file with its timeline offset; fall back to the single legacy file.
    let systemSegments: SystemAudioSegmentUpload[] | null = null
    const manifest = await window.api.readRecording(systemSegmentManifestName(meetingId))
    if (manifest.exists && manifest.data) {
      try {
        const entries = JSON.parse(new TextDecoder().decode(manifest.data)) as {
          file: string
          offsetMs: number
        }[]
        const parts = await Promise.all(
          entries.map(async (entry) => {
            const segment = await window.api.readRecording(entry.file)
            if (!segment.exists || !segment.data) return null
            return {
              audioB64: await blobToBase64(
                new Blob([segment.data], { type: 'audio/webm;codecs=opus' })
              ),
              mimeType: 'audio/webm;codecs=opus',
              offsetMs: entry.offsetMs
            }
          })
        )
        const present = parts.filter((p): p is SystemAudioSegmentUpload => p !== null)
        if (present.length > 0) systemSegments = present
      } catch {
        // Unreadable manifest — fall back to the single legacy system file.
      }
    }
    if (!systemSegments) {
      const system = await window.api.readRecording(`${meetingId}.system.webm`)
      if (system.exists && system.data) {
        systemSegments = [
          {
            audioB64: await blobToBase64(
              new Blob([system.data], { type: 'audio/webm;codecs=opus' })
            ),
            mimeType: 'audio/webm;codecs=opus',
            offsetMs: 0
          }
        ]
      }
    }
    const uploaded = await uploadAudio(
      meetingId,
      await blobToBase64(new Blob([mic.data], { type: 'audio/webm;codecs=opus' })),
      'audio/webm;codecs=opus',
      null,
      null,
      systemSegments
    )

    window.api.debugLog('retry saved upload finished', { meetingId, ok: Boolean(uploaded) })
    if (uploaded) {
      watchProcessing(meetingId, title)
    } else {
      setPostCaptureNotice({
        state: 'upload_failed',
        meetingId,
        title,
        message: 'Upload still failed. The recording remains saved locally; retry once the backend is healthy.'
      })
    }
  }

  const retryProcessingStatus = async (meetingId: string, title: string): Promise<void> => {
    setPostCaptureNotice({
      state: 'processing',
      meetingId,
      title,
      message: 'Checking backend processing status…'
    })

    const review = await fetchMeetingReview(meetingId)
    if (review?.meeting.pipeline_status === 'ready') {
      const blobDeliveryEpoch = nextBlobDeliveryEpoch(meetingId)
      watchBlobDelivery(meetingId, title, review.meeting, blobDeliveryEpoch, false)
      await retryTranscriptEmail(meetingId, title)
      return
    }
    if (review?.meeting.pipeline_status === 'failed') {
      await retryPipeline(meetingId)
    }
    watchProcessing(meetingId, title)
  }

  const retryPostCapture = async (meetingId: string, title: string): Promise<void> => {
    const state = postCaptureNotice?.state
    if (state === 'upload_failed') {
      await retrySavedUpload(meetingId, title)
    } else if (state === 'processing_failed') {
      await retryProcessingStatus(meetingId, title)
    } else {
      await retryTranscriptEmail(meetingId, title)
    }
  }

  // IN-129: upload a spilled (interrupted) recording through the normal pipeline.
  const recoverInterrupted = async (key: string): Promise<void> => {
    const entry = interrupted.find((e) => e.key === key)
    if (!entry) return
    setInterrupted((list) => list.filter((e) => e.key !== key))
    try {
      const [mic, sys] = await Promise.all([
        window.api.spillRead(key, 'mic'),
        window.api.spillRead(key, 'sys')
      ])
      const micData = mic.exists && mic.data?.byteLength ? mic.data : null
      const sysData = sys.exists && sys.data?.byteLength ? sys.data : null
      const primary = micData ?? sysData
      if (!primary) {
        await window.api.spillDiscard(key)
        return
      }

      const graphMetadata = (entry.graphMetadata as GraphMeetingMetadata | undefined) ?? null
      let meetingId = entry.meetingId
      if (!meetingId) {
        const created = await createMeeting(entry.title, null, entry.source, graphMetadata)
        meetingId = created?.id ?? null
      }
      if (!meetingId) {
        // Backend unreachable — keep the entry so the user can retry later.
        setInterrupted((list) => [entry, ...list])
        return
      }

      const name = `${meetingId}.webm`
      let savedLocally = false
      try {
        await window.api.saveRecording(name, primary)
        if (micData && sysData) {
          await window.api.saveRecording(name.replace(/\.webm$/i, '.system.webm'), sysData)
        }
        savedLocally = true
      } catch {
        // Local save failed — still try upload; keep the spill as the only copy.
      }

      const durationSeconds =
        Math.round((Date.parse(entry.endedAtUtc) - Date.parse(entry.startedAtUtc)) / 1000) || null
      const mimeType = entry.mimeType || 'audio/webm'
      const uploaded = await uploadAudio(
        meetingId,
        await blobToBase64(new Blob([primary])),
        mimeType,
        durationSeconds,
        graphMetadata,
        micData && sysData
          ? [{ audioB64: await blobToBase64(new Blob([sysData])), mimeType, offsetMs: 0 }]
          : null
      )
      if (uploaded || savedLocally) await window.api.spillDiscard(key)
      if (uploaded) {
        watchProcessing(meetingId, entry.title)
      } else {
        setPostCaptureNotice({
          state: 'upload_failed',
          meetingId,
          title: entry.title,
          message: savedLocally
            ? 'Recovered recording saved locally, but upload failed. Retry once the backend is reachable.'
            : 'Upload failed. The recovered audio is kept; retry once the backend is reachable.'
        })
        if (!savedLocally) setInterrupted((list) => [entry, ...list])
      }
    } catch (err) {
      window.api.debugLog('interrupted recording recovery failed', {
        key,
        message: err instanceof Error ? err.message : String(err)
      })
      setInterrupted((list) => [entry, ...list])
    }
  }

  const discardInterrupted = async (key: string): Promise<void> => {
    setInterrupted((list) => list.filter((e) => e.key !== key))
    try {
      await window.api.spillDiscard(key)
    } catch {
      // Already gone or locked — the startup sweep will retry next launch.
    }
  }

  const uploadRecording = async (
    title: string,
    file: File,
    manualAttendees: ManualMeetingAttendee[]
  ): Promise<void> => {
    const created = await createMeeting(title, null, 'upload', null, manualAttendees)
    if (!created) {
      console.warn('Upload needs the backend — start it and try again')
      return
    }
    const b64 = await blobToBase64(file)
    const duration = await audioDurationSeconds(file)
    const uploaded = await uploadAudio(created.id, b64, file.type || 'audio/webm', duration)
    if (!uploaded) console.warn('Audio upload failed — backend unreachable')
    if (uploaded) watchProcessing(created.id, title)
  }

  const signOut = (): void => {
    // Bump so any enrolment-status fetch already in flight (e.g. the
    // onEnrolled refetch below) can detect this logout and discard its
    // result instead of landing a stale status into the next session.
    enrolmentEpochRef.current += 1
    blobDeliveryHydrationSessionRef.current += 1
    for (const timer of blobDeliveryTimersRef.current.values()) {
      window.clearTimeout(timer)
    }
    blobDeliveryTimersRef.current.clear()
    blobDeliveryEpochsRef.current.clear()
    localStorage.removeItem(USER_KEY)
    setRecording(null)
    setCurrentPerson(null)
    setEnrolmentStatus(null)
    setEnrollmentError(null)
    setEnrollmentLoading(false)
    setBlobDeliveryNotices({})
    setView('home')
    setUser(null)
    if (typeof window.api?.signOut === 'function') {
      window.api.signOut().catch(() => { /* clear is best-effort */ })
    }
  }

  if (enrollmentLoading || enrollmentError || !currentPerson || !enrolmentSatisfied) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center bg-page px-6">
        <div className="w-full max-w-[520px] rounded-lg border-[0.5px] border-edge-secondary bg-bg-primary p-5 text-center">
          <h1 className="m-0 text-[18px] font-medium text-content-primary">Voiceprint required</h1>
          <p className="mx-auto mb-0 mt-2 max-w-[420px] text-[12px] leading-relaxed text-content-tertiary">
            Factor1 staff must enroll a voiceprint after Microsoft sign-in before using
            Notetaker. This helps identify speakers accurately in meeting transcripts.
          </p>
          {enrollmentLoading && (
            <p className="mb-0 mt-4 flex items-center justify-center gap-2 text-[13px] text-content-secondary">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-edge-tertiary border-t-brand-blue" />
              Loading your enrollment status…
            </p>
          )}
          {enrollmentError && (
            <p className="mb-0 mt-4 rounded-md border-[0.5px] border-edge-danger bg-bg-danger px-3 py-2 text-[12px] leading-relaxed text-content-danger">
              {enrollmentError}
            </p>
          )}
          <div className="mt-4 flex items-center justify-center gap-2">
            {enrollmentError && (
              <button
                type="button"
                onClick={() => setEnrollmentAttempt((n) => n + 1)}
                className="rounded-md border-[0.5px] border-edge-info bg-bg-info px-3 py-2 text-[13px] text-content-info hover:opacity-90"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={signOut}
              className="rounded-md border-[0.5px] border-edge-secondary px-3 py-2 text-[13px] text-content-primary hover:bg-bg-secondary"
            >
              Sign out
            </button>
          </div>
        </div>
        {currentPerson && !enrolmentSatisfied && (
          <EnrollmentModal
            person={currentPerson}
            required
            onClose={() => undefined}
            onEnrolled={(updated) => {
              setCurrentPerson(updated)
              setEnrollmentError(null)
              setView('home')
              // Optimistic: the enroll call itself 502s when central
              // registration fails, so a successful response here implies
              // it already succeeded — flip the gate immediately rather
              // than waiting on a round trip. The refetch below is just
              // confirmation.
              setEnrolmentStatus((s) => s && { ...s, centrally_enrolled: true })
              // Cancellation guard mirrors the main gate effect: capture the
              // epoch now so a logout that lands mid-flight (e.g. the user
              // signs out before this refetch resolves) can't apply a stale
              // status to the next session.
              const epoch = enrolmentEpochRef.current
              void fetchEnrolmentStatus().then((status) => {
                if (enrolmentEpochRef.current !== epoch) return
                setEnrolmentStatus(status)
              })
            }}
          />
        )}
      </div>
    )
  }

  const finishingRecording = autoRecordingState === 'processing'
  const activePostCaptureNotice =
    postCaptureNotice &&
    (postCaptureNotice.state === 'processing' || postCaptureNotice.state === 'emailing')
      ? postCaptureNotice
      : null
  const shellRecordingState = finishingRecording
    ? 'processing'
    : recording
      ? 'recording'
      : autoRecordingState
  const shellStatusText = finishingRecording
    ? activePostCaptureNotice?.message ?? 'Processing recording'
    : recording
      ? recording.pausedAt !== null
        ? 'Recording paused'
        : 'Recording'
      : activePostCaptureNotice?.message ?? null
  const shellStatusDetail = finishingRecording
    ? activePostCaptureNotice?.title ?? recording?.title ?? null
    : !recording &&
        activePostCaptureNotice
      ? activePostCaptureNotice.title
      : null

  return (
    <AppShell
      active={view === 'recording' ? null : view}
      onSelect={navigate}
      recordingState={shellRecordingState}
      statusText={shellStatusText}
      statusDetail={shellStatusDetail}
      recordingStartedAt={recording?.startedAt}
      recordingPausedAt={recording?.pausedAt}
      recordingPausedAccum={recording?.pausedAccum}
      onOpenRecording={
        recording && autoRecordingState !== 'processing' ? () => setView('recording') : null
      }
      userName={user?.name}
    >
      {view === 'recording' && recording && (
        <RecordingScreen
          session={recording}
          captureStatus={captureStatus}
          onPause={() => controlHandlersRef.current.pause()}
          onResume={() => controlHandlersRef.current.resume()}
          onStop={() => controlHandlersRef.current.stop()}
          saving={autoRecordingState === 'processing'}
          onExtend={
            recording.scheduledEndUtc && typeof window.api?.extendRecording === 'function'
              ? () => {
                  setExtending(true)
                  void window.api
                    .extendRecording()
                    .then((res) => {
                      if (res?.endTimeUtc) {
                        applyScheduledEndUtc(res.endTimeUtc)
                      }
                    })
                    .finally(() => setExtending(false))
                }
              : undefined
          }
          extending={extending}
        />
      )}
      {view === 'home' && (
        <HomeScreen
          onStartRecording={(title, attendees) =>
            void startManualRecording(title, attendees)
          }
          onUploadRecording={(title, file, attendees) =>
            void uploadRecording(title, file, attendees)
          }
          recordingState={shellRecordingState}
          interruptedRecordings={interrupted.map((e) => ({
            key: e.key,
            title: e.title,
            interruptedAtUtc: e.endedAtUtc
          }))}
          onRecoverInterrupted={(key) => void recoverInterrupted(key)}
          onDiscardInterrupted={(key) => void discardInterrupted(key)}
          postCaptureNotice={postCaptureNotice}
          onDismissPostCaptureNotice={() => setPostCaptureNotice(null)}
          onRetryPostCapture={(meetingId, title) => void retryPostCapture(meetingId, title)}
          blobDeliveryNotices={Object.values(blobDeliveryNotices)}
          onDismissBlobDeliveryNotice={dismissBlobDeliveryNotice}
          onRetryBlobDelivery={(meetingId, title) =>
            void retryMeetingBlobDelivery(meetingId, title)
          }
        />
      )}
      {view === 'settings' && (
        <SettingsScreen
          theme={theme}
          onSetTheme={setTheme}
          userName={user.name}
          userEmail={user.email}
          onSignOut={signOut}
          onClose={() => setView('home')}
        />
      )}
    </AppShell>
  )
}

export default App
