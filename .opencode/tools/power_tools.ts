import { tool } from "@opencode-ai/plugin"
import { resolve } from "node:path"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { init, bumpErrorHotspot } from "./db"

export default tool({
  description: "In-process TypeScript type checking using the TS compiler API. 10x faster than spawning bun. Gets structured diagnostics with exact positions. Also: 'stream' for real-time command output via execa, 'chart' for PNG chart generation via sharp.",
  args: {
    action: tool.schema.string().describe("'typecheck' for in-process TS | 'stream' for real-time command output | 'chart' to generate PNG"),
    file_path: tool.schema.string().optional().describe("Specific file to check (for 'typecheck')."),
    tsconfig: tool.schema.string().optional().describe("Path to tsconfig.json (for 'typecheck', defaults to auto-detect)."),
    command: tool.schema.string().optional().describe("Shell command (for 'stream')."),
    cwd: tool.schema.string().optional().describe("Working directory (for 'stream')."),
    chart_type: tool.schema.string().optional().describe("'bar' | 'line' | 'heatmap' (for 'chart')."),
    chart_data: tool.schema.string().optional().describe("JSON data for chart."),
    chart_labels: tool.schema.string().optional().describe("JSON array of labels (for 'chart')."),
    chart_title: tool.schema.string().optional().describe("Chart title."),
    output_path: tool.schema.string().optional().describe("Output PNG path (for 'chart', default 'docs/chart.png')."),
  },
  async execute(args, context) {
    const db = init(context.worktree)

    // ── IN-PROCESS TYPECHECK (TypeScript compiler API) ──
    if (args.action === "typecheck") {
      try {
        const ts = await import("typescript")
        const cwd = args.cwd ? resolve(context.worktree, args.cwd) : context.worktree

        // Find tsconfig
        let configPath: string | undefined
        if (args.tsconfig) {
          configPath = resolve(context.worktree, args.tsconfig)
        } else {
          for (const name of ["tsconfig.json", "jsconfig.json"]) {
            const p = resolve(cwd, name)
            if (existsSync(p)) { configPath = p; break }
          }
          if (!configPath) {
            // Try parent dirs
            let dir = cwd
            for (let i = 0; i < 5; i++) {
              const p = resolve(dir, "tsconfig.json")
              if (existsSync(p)) { configPath = p; break }
              const parent = resolve(dir, "..")
              if (parent === dir) break
              dir = parent
            }
          }
        }
        if (!configPath || !existsSync(configPath)) {
          return JSON.stringify({ error: "No tsconfig.json found. Pass tsconfig path." }, null, 2)
        }

        const configFile = ts.readConfigFile(configPath, (p) => readFileSync(p, "utf8"))
        const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, resolve(configPath, ".."))
        
        if (args.file_path) {
          parsed.fileNames = [resolve(context.worktree, args.file_path)]
        }

        const program = ts.createProgram({
          rootNames: parsed.fileNames,
          options: { ...parsed.options, noEmit: true },
        })

        const diagnostics = ts.getPreEmitDiagnostics(program)
        const errors: any[] = []
        const files = new Set<string>()

        for (const d of diagnostics) {
          if (d.file && d.start !== undefined) {
            const pos = d.file.getLineAndCharacterOfPosition(d.start)
            const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n")
            errors.push({
              file: d.file.fileName.replace(context.worktree + "/", ""),
              line: pos.line + 1, col: pos.character + 1,
              code: d.code, message: msg,
            })
            files.add(d.file.fileName)
            // Auto-bump error hotspot
            bumpErrorHotspot(db, d.file.fileName.replace(context.worktree + "/", ""), true, msg)
          }
        }

        return JSON.stringify({
          action: "typecheck", engine: "typescript-compiler-api",
          errors: errors.length, files: files.size,
          diagnostics: errors.slice(0, 20),
          truncated: errors.length > 20 ? `${errors.length - 20} more` : undefined,
        }, null, 2)
      } catch (e: any) {
        return JSON.stringify({ error: `TypeCheck failed: ${e.message}` }, null, 2)
      }
    }

    // ── STREAMING EXEC (execa) ──
    if (args.action === "stream") {
      if (!args.command) return JSON.stringify({ error: "command required" }, null, 2)
      try {
        const { execa } = await import("execa")
        const cwd = args.cwd ? resolve(context.worktree, args.cwd) : context.worktree
        const proc = execa(args.command, { cwd, shell: true, timeout: 60000 })
        
        let output = ""
        proc.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString() })
        proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString() })
        
        await proc
        return JSON.stringify({
          action: "stream", command: args.command, exit_code: proc.exitCode,
          output: output.slice(-4000), output_length: output.length,
        }, null, 2)
      } catch (e: any) {
        return JSON.stringify({ action: "stream", command: args.command, error: e.message, output: e.stdout?.slice(-2000) || "" }, null, 2)
      }
    }

    // ── CHART RENDERING (sharp) ──
    if (args.action === "chart") {
      try {
        const sharp = (await import("sharp")).default
        const data: number[] = args.chart_data ? JSON.parse(args.chart_data) : []
        const labels: string[] = args.chart_labels ? JSON.parse(args.chart_labels) : []
        const title = args.chart_title || "Chart"
        
        if (data.length === 0) return JSON.stringify({ error: "chart_data required (JSON array of numbers)" }, null, 2)

        const width = 800, height = 400
        const barWidth = Math.max(10, Math.floor((width - 100) / data.length) - 4)
        const maxVal = Math.max(...data, 1)
        
        // Build SVG
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 60}">
  <rect width="${width}" height="${height + 60}" fill="#0d1117"/>
  <text x="${width/2}" y="24" fill="#c9d1d9" text-anchor="middle" font-size="14">${title}</text>`

        const colors = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#56d4dd"]
        
        if (args.chart_type === "heatmap") {
          // Simple heatmap grid
          const cols = Math.ceil(Math.sqrt(data.length))
          const cellW = (width - 40) / cols
          const cellH = (height - 40) / Math.ceil(data.length / cols)
          for (let i = 0; i < data.length; i++) {
            const col = i % cols, row = Math.floor(i / cols)
            const intensity = Math.round((data[i]! / maxVal) * 255)
            svg += `\n  <rect x="${20 + col * cellW}" y="${40 + row * cellH}" width="${cellW - 2}" height="${cellH - 2}" fill="rgb(${intensity}, ${Math.round(intensity * 0.4)}, ${Math.round(intensity * 0.2)})" opacity="0.8"/>`
          }
        } else {
          // Bar chart
          for (let i = 0; i < data.length; i++) {
            const barH = (data[i]! / maxVal) * (height - 60)
            const x = 50 + i * (barWidth + 4)
            const y = height - barH
            svg += `\n  <rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${colors[i % colors.length]}" rx="2"/>`
            if (labels[i]) svg += `\n  <text x="${x + barWidth/2}" y="${height + 16}" fill="#8b949e" text-anchor="middle" font-size="10">${labels[i]!.slice(0, 12)}</text>`
            svg += `\n  <text x="${x + barWidth/2}" y="${y - 6}" fill="#c9d1d9" text-anchor="middle" font-size="10">${data[i]}</text>`
          }
        }
        svg += `\n</svg>`

        const outputPath = args.output_path || "docs/chart.png"
        const fullPath = resolve(context.worktree, outputPath)
        try { mkdirSync(resolve(fullPath, ".."), { recursive: true }) } catch {}
        
        await sharp(Buffer.from(svg)).png().toFile(fullPath)

        return JSON.stringify({
          action: "chart", type: args.chart_type || "bar", output: outputPath,
          width, height, data_points: data.length,
        }, null, 2)
      } catch (e: any) {
        return JSON.stringify({ error: `Chart failed: ${e.message}` }, null, 2)
      }
    }

    return JSON.stringify({ error: `Unknown action: '${args.action}'. Valid: typecheck, stream, chart.` }, null, 2)
  },
})
