import type { Language, Parser } from "web-tree-sitter"

let initialized = false
let ParserCtor: typeof Parser | null = null
let tsLang: Language | null = null
let tsxLang: Language | null = null

export async function ensureTreeSitterLanguages(): Promise<{
  ParserCtor: typeof Parser
  tsLang: Language
  tsxLang: Language
}> {
  if (initialized && ParserCtor && tsLang && tsxLang) {
    return { ParserCtor, tsLang, tsxLang }
  }

  const mod: {
    default: { init(): Promise<void>; Language: typeof Language; Parser: typeof Parser }
  } = await import("web-tree-sitter")
  await mod.default.init()
  const base = import.meta.resolve("tree-sitter-typescript")
  const baseDir = base.replace("file://", "").replace("/tree-sitter.json", "")
  tsLang = await mod.default.Language.load(`${baseDir}/tree-sitter-typescript.wasm`)
  tsxLang = await mod.default.Language.load(`${baseDir}/tree-sitter-tsx.wasm`)
  ParserCtor = mod.default.Parser
  initialized = true
  return { ParserCtor, tsLang, tsxLang }
}

export function languageForPath(path: string, tsLang: Language, tsxLang: Language): Language {
  return path.endsWith(".tsx") || path.endsWith(".jsx") ? tsxLang : tsLang
}
