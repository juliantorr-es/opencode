import { $ } from "bun"

const result = await $`bun test test/project/instance-trace.test.ts 2>&1`.cwd(process.cwd()).nothrow().quiet()
console.log("STDOUT:", result.stdout.toString())
console.log("STDERR:", result.stderr.toString())
console.log("EXIT:", result.exitCode)
