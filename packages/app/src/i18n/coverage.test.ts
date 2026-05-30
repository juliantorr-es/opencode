import { describe, expect, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as th } from "./th"
import { dict as tr } from "./tr"
import { dict as uk } from "./uk"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"

/**
 * Mirror of the runtime resolveKey from context/language.tsx:
 *   currentDict -> parentDict -> base -> raw key
 */
function resolveKey(
  key: string,
  dict: Record<string, string> | undefined,
  parentDict: Record<string, string> | undefined,
  base: Record<string, string>,
): string {
  if (dict && key in dict) return resolveTemplate(dict[key])
  if (parentDict && key in parentDict) return resolveTemplate(parentDict[key])
  if (key in base) return resolveTemplate(base[key])
  return key
}

type Dict = Record<string, string>

const enKeys = Object.keys(en).sort()
const enDict = en as Dict

type LocaleEntry = {
  name: string
  dict: Dict
  parent?: Dict
}

const locales: LocaleEntry[] = [
  { name: "ar", dict: ar as Dict },
  { name: "br", dict: br as Dict },
  { name: "bs", dict: bs as Dict },
  { name: "da", dict: da as Dict },
  { name: "de", dict: de as Dict },
  { name: "es", dict: es as Dict },
  { name: "fr", dict: fr as Dict },
  { name: "ja", dict: ja as Dict },
  { name: "ko", dict: ko as Dict },
  { name: "no", dict: no as Dict },
  { name: "pl", dict: pl as Dict },
  { name: "ru", dict: ru as Dict },
  { name: "th", dict: th as Dict },
  { name: "tr", dict: tr as Dict },
  { name: "uk", dict: uk as Dict },
  { name: "zh", dict: zh as Dict },
  { name: "zht", dict: zht as Dict, parent: zh as Dict },
]

describe("i18n graceful fallback resolution", () => {
  for (const locale of locales) {
    test(`${locale.name} resolves every key through fallback chain`, () => {
      for (const key of enKeys) {
        const result = resolveKey(key, locale.dict, locale.parent, enDict)

        // Must never return the raw key — at minimum every key exists in base
        expect(result).not.toBe(key)

        // Must always be a non-empty string
        expect(typeof result).toBe("string")
      }
    })
  }
})

describe("i18n graceful degradation — missing key safety", () => {
  test("returns raw key when missing from all dicts", () => {
    expect(resolveKey("nonexistent.key.should.not.exist", zh as Dict, undefined, enDict)).toBe(
      "nonexistent.key.should.not.exist",
    )
  })

  test("zht falls through to zh when key missing from zht", () => {
    const zhDict = zh as Dict
    const zhtDict = zht as Dict
    const zhtKeys = new Set(Object.keys(zhtDict))
    const missingFromZht = Object.keys(zhDict).filter((k) => !zhtKeys.has(k))

    if (missingFromZht.length > 0) {
      const sample = missingFromZht[0]
      const resolved = resolveKey(sample, zhtDict, zhDict, enDict)
      expect(resolved).toBe(zhDict[sample])
    }
  })

  test("locale without parent falls through to English when key missing", () => {
    const brDict = br as Dict
    const brKeys = new Set(Object.keys(brDict))
    const missingFromBr = enKeys.filter((k) => !brKeys.has(k))

    if (missingFromBr.length > 0) {
      const sample = missingFromBr[0]
      const resolved = resolveKey(sample, brDict, undefined, enDict)
      expect(resolved).toBe(enDict[sample])
    }
  })
})

describe("i18n translation coverage", () => {
  for (const locale of locales) {
    test(`${locale.name} translation coverage`, () => {
      const localeKeys = new Set(Object.keys(locale.dict))
      const missing: string[] = []
      const untranslated: string[] = []

      for (const key of enKeys) {
        if (!localeKeys.has(key)) {
          missing.push(key)
        } else if (locale.dict[key] === enDict[key]) {
          // Value is identical to English — likely an untranslated stub
          untranslated.push(key)
        }
      }

      const total = enKeys.length
      const present = total - missing.length
      const translatedPct = ((present - untranslated.length) / total) * 100

      // Log coverage report — visible in test runner output
      console.log(
        `  ${locale.name}: ${present}/${total} keys present (${((present / total) * 100).toFixed(1)}%)` +
          `, ${translatedPct.toFixed(1)}% translated` +
          (missing.length > 0 ? `, ${missing.length} missing` : "") +
          (untranslated.length > 0 ? `, ${untranslated.length} still English` : ""),
      )

      // Assertion: no key should be missing if it exists in en.
      // The fallback chain handles missing keys gracefully at runtime,
      // but CI should flag when locales need translation work.
      expect(missing).toEqual([])
    })
  }
})
