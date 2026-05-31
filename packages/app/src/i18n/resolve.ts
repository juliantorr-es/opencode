import { resolveTemplate } from "@solid-primitives/i18n"

/**
 * Resolve a translation key through the fallback chain:
 *   1. Current locale dictionary
 *   2. Parent locale dictionary (e.g., zh for zht)
 *   3. Base dictionary (en)
 *   4. Raw key if missing from all dictionaries
 */
export function resolveKey(
  key: string,
  dict: Record<string, string> | undefined,
  parentDict: Record<string, string> | undefined,
  base: Record<string, string>,
  params?: Record<string, unknown>,
): string {
  if (dict && key in dict) return resolveTemplate(dict[key], params)
  if (parentDict && key in parentDict) return resolveTemplate(parentDict[key], params)
  if (key in base) return resolveTemplate(base[key], params)
  return key
}

/**
 * Parent locale mapping for the fallback chain.
 *
 * Locales listed here will fall through to their parent locale
 * before falling back to the base (en) dictionary.
 *
 * Example: zht (Traditional Chinese) -> zh (Simplified Chinese) -> en
 */
export const PARENT: Record<string, string> = {
  zht: "zh",
}
