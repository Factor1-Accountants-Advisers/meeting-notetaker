import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export const PUBLIC_APP_CONFIG = {
  MN_ENTRA_CLIENT_ID: '3e3f3422-d4fa-4ebe-9b22-148439e84cc3',
  MN_ENTRA_TENANT_ID: '891d380b-39a6-4eb4-aca5-4ffe1d3c25ac',
  MN_STORAGE_API_URL:
    'https://func-innov-nt-storage-prod-eqg7dzf8gfbqawea.australiaeast-01.azurewebsites.net',
  MN_STORAGE_API_SCOPE:
    'api://13298042-714a-4d57-a1c5-481c22753087/access_as_user'
} as const

function parseEnvFile(path: string): void {
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const index = trimmed.indexOf('=')
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!key) continue
    if (value === '' || value === 'undefined' || value === 'null') continue
    if (!hasUsableEnvValue(process.env[key])) process.env[key] = value
  }
}

function hasUsableEnvValue(value: string | undefined): value is string {
  return Boolean(value && value !== 'undefined' && value !== 'null')
}

function setDefaultEnv(
  key: string,
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!hasUsableEnvValue(env[key]) && hasUsableEnvValue(value)) env[key] = value
}

export function applyPublicEnvDefaults(env: NodeJS.ProcessEnv = process.env): void {
  setDefaultEnv('MN_ENTRA_CLIENT_ID', env.AZURE_AD_CLIENT_ID, env)
  setDefaultEnv('MN_ENTRA_TENANT_ID', env.AZURE_AD_TENANT_ID, env)
  for (const [key, value] of Object.entries(PUBLIC_APP_CONFIG)) {
    setDefaultEnv(key, value, env)
  }
}

export function loadPublicEnv(): void {
  const candidates = [
    join(process.cwd(), '.env.production'),
    join(process.cwd(), '.env'),
    process.resourcesPath ? join(process.resourcesPath, '.env.production') : ''
  ].filter(Boolean)

  for (const path of candidates) parseEnvFile(path)

  applyPublicEnvDefaults()
}
