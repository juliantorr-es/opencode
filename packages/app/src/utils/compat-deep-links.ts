const LEGACY_SCHEME = "opencode://"
const CANONICAL_SCHEME = "tribunus://"

export const handleDeepLink = (
  url: string,
): { action: "redirect" | "reject" | "accept"; target?: string; reason: string } => {
  if (url.startsWith(CANONICAL_SCHEME)) {
    return { action: "accept", reason: "canonical scheme" }
  }

  if (url.startsWith(LEGACY_SCHEME)) {
    const target = url.replace(LEGACY_SCHEME, CANONICAL_SCHEME)
    console.warn(
      `[CompatDeepLinks] Deprecated scheme 'opencode://' — redirecting to 'tribunus://' equivalent`,
    )
    return { action: "redirect", target, reason: "legacy scheme redirected" }
  }

  return { action: "reject", reason: "unsupported scheme" }
}
