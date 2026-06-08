// ─── Review Export Git ──────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";

export function gitExec(
  args: string[],
  cwd: string,
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, timeout: 15000, encoding: "utf8" });
  if (result.error) {
    return { ok: false, stdout: "", stderr: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout || "",
      stderr: result.stderr || `exit ${result.status}`,
    };
  }
  return { ok: true, stdout: result.stdout || "", stderr: "" };
}
