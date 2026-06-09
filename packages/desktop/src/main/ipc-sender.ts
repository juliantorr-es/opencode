// Pure sender authorization — no Electron imports. Tests can mock the narrow
// IpcSenderInfo interface without triggering Electron's binary loader.

/** Narrow interface for sender info — stable subset of Electron's WebContents. */
export interface IpcSenderInfo {
  readonly isDestroyed: () => boolean
  readonly getURL: () => string
}

export interface IpcFrameInfo {
  readonly url: string
  readonly isMainFrame: boolean
}

/** Sender authorization result */
export type SenderCheck = { allowed: true } | { allowed: false; reason: string }

/**
 * Check that the IPC sender is from an approved origin and frame.
 *
 * - `"standard"` — verifies the sender web-contents is alive.
 * - `"strict"` — additionally checks the frame URL is dev or packaged
 *   origin and that the calling frame is the main frame.
 */
export function checkSender(
  sender: IpcSenderInfo | null | undefined,
  policy: "standard" | "strict",
  frame?: IpcFrameInfo,
): SenderCheck {
  if (!sender || sender.isDestroyed()) {
    return { allowed: false, reason: "sender destroyed or missing" }
  }

  if (policy === "strict") {
    const url = sender.getURL()
    const isDev = url.startsWith("http://localhost")
    const isPackaged = url.startsWith("file://")
    const isInternal = url.startsWith("oc://")
    if (!isDev && !isPackaged && !isInternal) {
      return { allowed: false, reason: `unapproved origin: ${url}` }
    }
    if (frame && !frame.isMainFrame) {
      return { allowed: false, reason: "invocation from non-main frame" }
    }
  }

  return { allowed: true }
}
