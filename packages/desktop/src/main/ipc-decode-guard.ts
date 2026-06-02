/**
 * IPC Decode Guard — runtime decode helpers for boot-critical IPC values.
 *
 * Usage: Any value received from IPC that controls app boot, navigation,
 * or feature availability MUST be decoded through a schema here.
 * TypeScript types are not sufficient — we need runtime shape verification.
 */

export interface DecodeResult<T> {
  ok: boolean
  value?: T
  error?: string
}

/** Shallow structural decoder for known object shapes */
export function decodeObject<T extends Record<string, unknown>>(
  label: string,
  value: unknown,
  requiredKeys: (keyof T)[],
): DecodeResult<T> {
  if (value === null || typeof value !== "object") {
    return { ok: false, error: `${label}: expected object, got ${typeof value}` }
  }
  const obj = value as Record<string, unknown>
  for (const key of requiredKeys) {
    if (!(key as string in obj)) {
      return { ok: false, error: `${label}: missing required key "${String(key)}"` }
    }
  }
  return { ok: true, value: obj as unknown as T }
}

/** Decode or throw — for boot-critical values that must be valid */
export function decodeOrThrow<T extends Record<string, unknown>>(
  label: string,
  value: unknown,
  requiredKeys: (keyof T)[],
): T {
  const result = decodeObject<T>(label, value, requiredKeys)
  if (!result.ok) throw new Error(result.error)
  return result.value!
}
