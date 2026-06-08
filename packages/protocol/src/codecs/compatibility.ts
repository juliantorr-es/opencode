// Version compatibility helpers for protocol schema evolution

export type SchemaVersion = `${number}.${number}.${number}`

export interface VersionConstraint {
  min: SchemaVersion
  max?: SchemaVersion
  deprecated?: boolean
  migration_path?: string
}

export const COMPATIBILITY_MAP: Record<string, VersionConstraint> = {
  "event_envelope": { min: "1.0.0", max: "1.1.0" },
  "receipt": { min: "1.0.0", max: "1.1.0" },
  "capability_descriptor": { min: "1.0.0", max: "1.1.0" },
  "work_state_transition": { min: "1.0.0", max: "1.1.0" },
  "federation_types": { min: "1.0.0", max: "1.1.0" },
}

// Check if a schema version is compatible with the current protocol version
export function isCompatible(schemaName: string, version: SchemaVersion): boolean {
  const constraint = COMPATIBILITY_MAP[schemaName]
  if (!constraint) return false
  if (constraint.deprecated) return false
  const vParts = version.split(".").map(Number)
  const minParts = constraint.min.split(".").map(Number)
  const vMajor = vParts[0] ?? 0
  const vMinor = vParts[1] ?? 0
  const minMajor = minParts[0] ?? 0
  const minMinor = minParts[1] ?? 0
  if (vMajor !== minMajor) return false
  if (vMinor < minMinor) return false
  if (constraint.max) {
    const maxParts = constraint.max.split(".").map(Number)
    const maxMajor = maxParts[0] ?? 0
    const maxMinor = maxParts[1] ?? 0
    if (vMajor > maxMajor) return false
    if (vMajor === maxMajor && vMinor > maxMinor) return false
  }
  return true
}

// Deprecation policy: after 2 major versions, removal is allowed
export const DEPRECATION_WINDOW_MAJOR = 2

export function isDeprecated(constraint: VersionConstraint): boolean {
  return constraint.deprecated === true
}

export function getMigrationPath(schemaName: string): string | undefined {
  return COMPATIBILITY_MAP[schemaName]?.migration_path
}
