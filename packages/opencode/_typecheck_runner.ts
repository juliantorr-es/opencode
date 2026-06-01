const proc = Bun.spawn(["npx", "tsgo", "--noEmit"], {
    cwd: "/Users/user/Developer/GitHub/opencode-desktop-dev/packages/opencode",
    stdout: "pipe",
    stderr: "pipe",
})

const stdout = await new Response(proc.stdout).text()
const stderr = await new Response(proc.stderr).text()
const exitCode = await proc.exited

const output = stdout + stderr
await Bun.write("typecheck_full_output.txt", output)

const lines = output.split("\n").filter(Boolean)
const errorCount = lines.filter(l => l.includes("error TS")).length
const distinctFiles = [...new Set(lines.filter(l => l.includes("error TS")).map(l => {
    const match = l.match(/^(.+?)\(\d+,\d+\):/)
    return match ? match[1] : l
}))]

console.log("EXIT_CODE:", exitCode)
console.log("TOTAL_ERRORS:", errorCount)
console.log("DISTINCT_FILES:", distinctFiles.length)
console.log("DISTINCT_FILE_LIST:")
distinctFiles.forEach(f => console.log("  ", f))
