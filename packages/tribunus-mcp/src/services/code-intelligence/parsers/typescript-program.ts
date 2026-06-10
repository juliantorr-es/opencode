import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as ts from "typescript"

export type TypeScriptProgramV1 = {
  program: ts.Program
  checker: ts.TypeChecker
  diagnostics: ts.Diagnostic[]
}

export function buildTypeScriptProgram(repoRoot: string, filePaths: string[]): TypeScriptProgramV1 {
  const rootNames = filePaths
    .filter((path) => /\.(ts|tsx|js|jsx|mts|cts)$/.test(path))
    .map((path) => resolve(repoRoot, path))

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    resolveJsonModule: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  }

  const host = ts.createCompilerHost(options, true)
  host.getCurrentDirectory = () => repoRoot
  host.readFile = (fileName) => {
    const abs = fileName.startsWith(repoRoot) ? fileName : resolve(repoRoot, fileName)
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined
  }
  host.fileExists = (fileName) => {
    const abs = fileName.startsWith(repoRoot) ? fileName : resolve(repoRoot, fileName)
    return existsSync(abs)
  }
  host.realpath = (fileName) => fileName

  const program = ts.createProgram({ rootNames, options, host })
  const checker = program.getTypeChecker()
  const diagnostics = [...ts.getPreEmitDiagnostics(program)]
  return { program, checker, diagnostics }
}

export function exportedModuleSymbols(program: ts.Program, checker: ts.TypeChecker): Array<{
  path: string
  symbol_name: string
  kind: string
  signature?: string
}> {
  const results: Array<{ path: string; symbol_name: string; kind: string; signature?: string }> = []
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (!moduleSymbol) continue
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const name = symbol.getName()
      const declaration = symbol.declarations?.[0]
      results.push({
        path: sourceFile.fileName,
        symbol_name: name,
        kind: declaration ? ts.SyntaxKind[declaration.kind] : "unknown",
        signature: checker.symbolToString(symbol),
      })
    }
  }
  return results
}
