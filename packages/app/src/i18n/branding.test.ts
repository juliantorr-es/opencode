import { describe, expect, test } from "bun:test"
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

const locales: Record<string, Record<string, string>> = {
  en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, uk, zh, zht,
}

// System/compatibility keys that MUST remain preserved to prevent config & API issues
const PRESERVED_KEYS = [
  "dialog.provider.opencode.note",
  "dialog.provider.opencode.tagline",
  "dialog.provider.opencodeGo.tagline",
  "provider.connect.opencodeZen.line1",
  "provider.connect.opencodeZen.line2",
  "provider.connect.opencodeZen.visit.prefix",
  "provider.connect.opencodeZen.visit.link",
  "provider.connect.opencodeZen.visit.suffix",
  "dialog.plugins.empty", // refers to opencode.json
  "error.chain.checkConfig", // refers to opencode.json
]

// User-facing keys that MUST reflect the "Tribunus" brand
const BRANDED_KEYS = [
  "app.name.desktop",
  "settings.desktop.wsl.description",
  "settings.general.row.language.description",
  "settings.general.row.appearance.description",
  "settings.general.row.colorScheme.description",
  "settings.general.row.theme.description",
  "settings.updates.row.startup.description",
  "settings.updates.toast.latest.description",
  "dialog.model.unpaid.freeModels.title",
  "toast.update.description",
  "error.page.report.prefix",
  "error.chain.mcpFailed",
]

describe("i18n branding boundaries", () => {
  for (const [name, locale] of Object.entries(locales)) {
    test(`${name} has all compatibility keys preserved`, () => {
      for (const key of PRESERVED_KEYS) {
        expect(key in locale).toBe(true)
      }
    })

    test(`${name} has Tribunus in user-facing brand key values`, () => {
      // English check specifically for values
      if (name === "en") {
        expect(locale["app.name.desktop"]).toBe("Tribunus Desktop")
        expect(locale["settings.general.row.theme.description"]).toBe("Customise how Tribunus is themed.")
      }
      
      // Ensure no branded keys contain "OpenCode" string
      for (const key of BRANDED_KEYS) {
        const val = locale[key]
        if (val) {
          expect(val.includes("OpenCode")).toBe(false)
        }
      }
    })

    test(`${name} allows legacy OpenCode urls/keys in compatibility values`, () => {
      const urlVal = locale["provider.connect.opencodeZen.visit.link"]
      if (urlVal) {
        expect(urlVal).toBe("opencode.ai/zen")
      }
    })
  }
})
