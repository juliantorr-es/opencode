/**
 * Pairing — QR code pairing flow between PWA mobile cockpit and desktop.
 *
 * Desktop generates a pairing QR with an auth token + WebSocket URL.
 * The PWA scans the QR, stores the token, and initiates the projection
 * stream connection. Pairing persists across sessions via localStorage.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface PairingPayload {
  /** Auth token for WebSocket upgrade and command auth. */
  token: string
  /** WebSocket URL for the projection stream. */
  wsUrl: string
  /** HTTP base URL for the command gateway. */
  httpUrl: string
  /** VAPID public key for push subscription. */
  vapidKey: string
  /** Granted capabilities the desktop permits from the mobile cockpit. */
  capabilities: Array<{
    command: string
    label: string
    scope?: string
  }>
  /** Timestamp when the desktop generated this payload. */
  issuedAt: number
}

export interface PairedSession {
  token: string
  wsUrl: string
  httpUrl: string
  vapidKey: string
  displayName: string
  pairedAt: number
}

// ── Constants ──────────────────────────────────────────────────────────

const PAIRED_SESSION_KEY = "tribunus-pwa:paired-session"
const PAIRING_CALLBACK_PATH = "/pwa/pairing"

// ── Implementation ─────────────────────────────────────────────────────

export interface PairingManager {
  /** Store a pairing payload (from QR scan or URL callback). */
  pair(payload: PairingPayload, displayName: string): void
  /** Retrieve the currently active paired session, or null. */
  getSession(): PairedSession | null
  /** Forget the paired session (unpair). */
  unpair(): void
  /** Whether a paired session exists. */
  isPaired(): boolean
  /** Build the QR content URL the desktop should display. */
  buildQrContent(baseUrl: string, payload: PairingPayload): string
  /** Parse QR scan result or callback URL into a pairing payload. */
  parseCallback(url: string): PairingPayload | null
}

function parseQrFragment(fragment: string): Record<string, string> {
  const params = new URLSearchParams(fragment.startsWith("?") || fragment.startsWith("#") ? fragment.slice(1) : fragment)
  const result: Record<string, string> = {}
  for (const [key, value] of params) result[key] = value
  return result
}

export function createPairingManager(): PairingManager {
  return {
    pair(payload: PairingPayload, displayName: string) {
      const session: PairedSession = {
        token: payload.token,
        wsUrl: payload.wsUrl,
        httpUrl: payload.httpUrl,
        vapidKey: payload.vapidKey,
        displayName,
        pairedAt: Date.now(),
      }
      try {
        localStorage.setItem(PAIRED_SESSION_KEY, JSON.stringify(session))
      } catch {
        // Storage unavailable — pairing won't survive page reload
      }
    },

    getSession(): PairedSession | null {
      try {
        const raw = localStorage.getItem(PAIRED_SESSION_KEY)
        if (!raw) return null
        return JSON.parse(raw) as PairedSession
      } catch {
        return null
      }
    },

    unpair() {
      try {
        localStorage.removeItem(PAIRED_SESSION_KEY)
      } catch {
        // noop
      }
    },

    isPaired(): boolean {
      return this.getSession() !== null
    },

    buildQrContent(baseUrl: string, payload: PairingPayload): string {
      const qp = new URLSearchParams({
        t: payload.token,
        w: payload.wsUrl,
        h: payload.httpUrl,
        v: payload.vapidKey,
        c: JSON.stringify(payload.capabilities),
        i: String(payload.issuedAt),
      })
      return `${baseUrl.replace(/\/+$/, "")}${PAIRING_CALLBACK_PATH}#${qp.toString()}`
    },

    parseCallback(url: string): PairingPayload | null {
      try {
        const parsed = new URL(url)
        // The pairing data arrives in the URL fragment after the callback path
        const hash = parsed.hash || ""
        if (!hash) return null

        const raw = parsed.hash.startsWith("#") ? hash.slice(1) : hash
        const params = parseQrFragment(raw)

        const token = params["t"]
        const wsUrl = params["w"]
        const httpUrl = params["h"]
        const vapidKey = params["v"]
        const capabilitiesRaw = params["c"]
        const issuedAt = params["i"]

        if (!token || !wsUrl || !httpUrl || !vapidKey || !capabilitiesRaw || !issuedAt) return null

        return {
          token,
          wsUrl,
          httpUrl,
          vapidKey,
          capabilities: JSON.parse(decodeURIComponent(capabilitiesRaw)) as PairingPayload["capabilities"],
          issuedAt: Number(issuedAt),
        }
      } catch {
        return null
      }
    },
  }
}

export const pairingManager = createPairingManager()
