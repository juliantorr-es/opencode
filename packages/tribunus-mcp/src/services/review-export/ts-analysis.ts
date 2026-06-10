// Copyright (C) 2025 Tribunus contributors
// SPDX-License-Identifier: LicenseRef-Tribunus-Internal
//
// TypeScript analysis — extracts imports, exports, symbols, and test cases from
// TypeScript source files using the TypeScript compiler API.

import * as ts from "typescript";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { analyzeSourceGraphFile, type SourceGraphAnalysisV1 } from "./source-graph.js";
import { hashText, languageForPath, lineCountForText, normalizeLineBreaks } from "./fs-utils.js";
import type { SourceAnchorV1 } from "./types.js";

export function scriptKindForPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".mts") || path.endsWith(".cts") || path.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

export function makeAnchor(args: {
  path: string;
  text: string;
  start: number;
  end: number;
  symbol_id?: string;
}): { path: string; start_line: number; end_line: number; sha256: string; language: string; symbol_id?: string } {
  const sourceFile = ts.createSourceFile(
    args.path,
    args.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(args.path),
  );
  const startLine = sourceFile.getLineAndCharacterOfPosition(args.start).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(args.end).line + 1;
  return {
    path: args.path,
    start_line: startLine,
    end_line: endLine,
    sha256: hashText(args.text),
    language: languageForPath(args.path),
    ...(args.symbol_id ? { symbol_id: args.symbol_id } : {}),
  };
}

export function makeLineAnchor(args: {
  path: string;
  text: string;
  start_line?: number;
  end_line?: number;
  symbol_id?: string;
}): SourceAnchorV1 {
  return {
    path: args.path,
    start_line: args.start_line ?? 1,
    end_line: args.end_line ?? lineCountForText(args.text),
    sha256: hashText(args.text),
    language: languageForPath(args.path),
    ...(args.symbol_id ? { symbol_id: args.symbol_id } : {}),
  };
}

export type TsAnalysisImport = {
  specifier: string;
  import_kind: "value" | "type_only" | "side_effect" | "dynamic" | "require" | "unknown";
  start_line: number;
  end_line: number;
  resolved_path?: string;
  resolution_status:
    | "resolved_in_packet"
    | "resolved_not_embedded"
    | "external_package"
    | "builtin"
    | "ts_js_extension_remap"
    | "missing_source"
    | "missing_asset"
    | "missing_generated"
    | "missing_prompt_template"
    | "missing_route_target"
    | "unresolved";
};

export type TsAnalysisExport = {
  name: string;
  kind: string;
  anchor: SourceAnchorV1;
  signature?: string;
};

export type TsAnalysisSymbol = {
  name: string;
  kind: string;
  exported: boolean;
  anchor: SourceAnchorV1;
  signature?: string;
  tags: string[];
};

export function analyzeTypeScriptFile(args: {
  path: string;
  text: string;
  repoRoot: string;
  includedSet: Set<string>;
}): {
  parser: SourceGraphAnalysisV1["parser"];
  parse_errors: number;
  parse_error_messages: string[];
  imports: TsAnalysisImport[];
  exports: TsAnalysisExport[];
  symbols: TsAnalysisSymbol[];
  test_cases: Array<{ name: string; anchor: SourceAnchorV1 }>;
  metrics: SourceGraphAnalysisV1["metrics"];
} {
  const sf = ts.createSourceFile(
    args.path,
    normalizeLineBreaks(args.text),
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(args.path),
  );
  const sourceGraph: SourceGraphAnalysisV1 = analyzeSourceGraphFile(args);
  const imports: TsAnalysisImport[] = sourceGraph.imports;
  const exports: TsAnalysisExport[] = sourceGraph.exports.map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    anchor: makeAnchor({
      path: args.path,
      text: args.text,
      start: entry.start_byte,
      end: entry.end_byte,
      symbol_id: `symbol:${args.path}#${entry.name}`,
    }),
    ...(entry.signature ? { signature: entry.signature } : {}),
  }));
  const symbols: TsAnalysisSymbol[] = [];
  const test_cases: Array<{ name: string; anchor: SourceAnchorV1 }> = [];
  const isExported = (node: ts.Node) => (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
  const isDefaultExport = (node: ts.Node) => (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) !== 0;

  const pushSymbol = (name: string, kind: string, node: ts.Node, tags: string[] = [], signature?: string) => {
    const anchor = makeAnchor({
      path: args.path,
      text: args.text,
      start: node.getStart(sf),
      end: node.getEnd(),
      symbol_id: `symbol:${args.path}#${name}`,
    });
    symbols.push({ name, kind, exported: true, anchor, signature, tags });
  };

  const visit = (node: ts.Node) => {
    if (ts.isExportAssignment(node)) {
      pushSymbol("default", "export_assignment", node, ["default"]);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      const exported = isExported(node);
      if (exported) {
        pushSymbol(node.name.text, "function", node, ["function"], node.getText(sf).replace(/\s+/g, " ").slice(0, 240));
      }
    } else if (ts.isClassDeclaration(node) && node.name) {
      const exported = isExported(node);
      if (exported) {
        pushSymbol(node.name.text, "class", node, ["class"], node.getText(sf).replace(/\s+/g, " ").slice(0, 240));
        for (const member of node.members) {
          if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name && ts.isIdentifier(member.name)) {
            const methodName = `${node.name.text}.${member.name.text}`;
            const anchor = makeAnchor({
              path: args.path,
              text: args.text,
              start: member.getStart(sf),
              end: member.getEnd(),
              symbol_id: `symbol:${args.path}#${methodName}`,
            });
            symbols.push({
              name: methodName,
              kind: "method",
              exported: true,
              anchor,
              signature: member.getText(sf).replace(/\s+/g, " ").slice(0, 240),
              tags: ["method"],
            });
          }
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      if (isExported(node)) {
        pushSymbol(node.name.text, "interface", node, ["type"], node.getText(sf).replace(/\s+/g, " ").slice(0, 240));
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (isExported(node)) {
        pushSymbol(node.name.text, "type_alias", node, ["type"], node.getText(sf).replace(/\s+/g, " ").slice(0, 240));
      }
    } else if (ts.isEnumDeclaration(node)) {
      if (isExported(node)) {
        pushSymbol(node.name.text, "enum", node, ["enum"], node.getText(sf).replace(/\s+/g, " ").slice(0, 240));
      }
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText(sf);
        pushSymbol(name, "const", decl, ["const"], decl.getText(sf).replace(/\s+/g, " ").slice(0, 240));
      }
    } else if (ts.isCallExpression(node)) {
      const name = node.expression.getText(sf);
      if ((name === "it" || name === "test") && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
        const testName = node.arguments[0].text;
        const anchor = makeAnchor({
          path: args.path,
          text: args.text,
          start: node.getStart(sf),
          end: node.getEnd(),
          symbol_id: `test:${args.path}#${testName}`,
        });
        test_cases.push({ name: testName, anchor });
        symbols.push({ name: testName, kind: "test_case", exported: false, anchor, tags: ["test"] });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);

  if (sf.isDeclarationFile) {
    symbols.push({
      name: basename(args.path),
      kind: "type_alias",
      exported: true,
      anchor: makeAnchor({
        path: args.path,
        text: args.text,
        start: 0,
        end: args.text.length,
        symbol_id: `symbol:${args.path}#declaration-file`,
      }),
      tags: ["declaration"],
    });
  }

  return {
    parser: sourceGraph.parser,
    parse_errors: sourceGraph.parse_errors,
    parse_error_messages: sourceGraph.parse_error_messages,
    imports,
    exports,
    symbols,
    test_cases,
    metrics: sourceGraph.metrics,
  };
}
