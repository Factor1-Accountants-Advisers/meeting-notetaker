export interface MsalAccountIdentity {
  localAccountId?: string
  idTokenClaims?: Record<string, unknown>
}

export interface StorageIdentity {
  email?: string
  oid?: string
  accessToken?: string
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

export function getAccountOid(
  account: MsalAccountIdentity | null | undefined
): string | undefined {
  return clean(account?.idTokenClaims?.oid) ?? clean(account?.localAccountId)
}

export function isStorageApiEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): boolean {
  return clean(env.MN_STORAGE_API_ENABLED)?.toLowerCase() !== 'false'
}

export function storageIdentityHeaders(identity: StorageIdentity): Record<string, string> {
  const headers: Record<string, string> = {}
  const email = clean(identity.email)
  const oid = clean(identity.oid)
  const accessToken = clean(identity.accessToken)
  if (email) headers['X-MN-User-Email'] = email
  if (oid) headers['X-MN-User-Oid'] = oid
  if (accessToken) headers['X-MN-Storage-Token'] = accessToken
  return headers
}
