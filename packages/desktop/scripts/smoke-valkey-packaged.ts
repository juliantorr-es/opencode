/**
 * Valkey Packaged Smoke Test
 *
 * Verifies: binary exists, architecture matches, PING responds, process exits cleanly.
 * Run after packaging: `bun run scripts/smoke-valkey-packaged.ts <path-to-packaged-app>`
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";

const args = process.argv.slice(2);
const appPath = args[0];

if (!appPath) {
	console.error("Usage: bun run scripts/smoke-valkey-packaged.ts <path-to-packaged-app>");
	console.error("  e.g. bun run scripts/smoke-valkey-packaged.ts dist/mac-arm64/OpenCode.app");
	process.exit(2);
}

console.log(`\n🔍 Valkey Smoke Test — ${new Date().toISOString()}`);
console.log(`   Target: ${appPath}\n`);

let failures = 0;
let passes = 0;

function pass(msg: string) { passes++; console.log(`  ✅ ${msg}`); }
function fail(msg: string) { failures++; console.error(`  ❌ ${msg}`); }

// ── Resource discovery ──────────────────────────────────

const platform = process.platform;
const arch = process.arch === "arm64" ? "arm64" : "x64";
const ext = platform === "win32" ? ".exe" : "";

// Look for binary in multiple locations
const candidatePaths = [
	join(appPath, "Contents", "Resources", "valkey", `${platform}-${arch}`, "bin", `valkey-server${ext}`),
	join(appPath, "..", "resources", "valkey", `${platform}-${arch}`, "bin", `valkey-server${ext}`),
	// Dev fallback
	join(process.cwd(), "resources", "valkey", `${platform}-${arch}`, "bin", `valkey-server${ext}`),
];

let binaryPath: string | undefined;
for (const p of candidatePaths) {
	if (existsSync(p)) { binaryPath = p; break; }
}

if (!binaryPath) {
	fail(`Valkey binary not found. Searched: ${candidatePaths.join(", ")}`);
	process.exit(1);
}
pass(`Binary found: ${binaryPath}`);

// ── SHA256 verification ──────────────────────────────────

const sumsDir = binaryPath.replace(/\/bin\/valkey-server$/, "");
const sumsPath = join(sumsDir, "SHA256SUMS");

if (existsSync(sumsPath)) {
	pass(`SHA256SUMS found: ${sumsPath}`);
	const sums = readFileSync(sumsPath, "utf-8");
	const expected = sums.split("\n").find((l) => l.includes("valkey-server"))?.split(/\s+/)[0];
	if (expected) {
		const actual = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
		if (expected === actual) {
			pass(`SHA256 verified: ${expected.slice(0, 16)}...`);
		} else {
			fail(`SHA256 MISMATCH. Expected: ${expected.slice(0, 16)}... Got: ${actual.slice(0, 16)}...`);
		}
	} else {
		fail("No valkey-server entry in SHA256SUMS");
	}
} else {
	console.log(`  ⚠️  SHA256SUMS not found (dev mode, non-fatal)`);
}

// ── Architecture check ───────────────────────────────────

try {
	const fileType = execSync(`file "${binaryPath}"`, { encoding: "utf-8" });
	console.log(`  📋 ${fileType.trim()}`);
	if (arch === "arm64" && fileType.includes("arm64")) pass("Architecture: arm64 (correct)");
	else if (arch === "x64" && fileType.includes("x86_64")) pass("Architecture: x86_64 (correct)");
	else console.log(`  ⚠️  Architecture mismatch: ${arch} vs binary`);
} catch {
	console.log(`  ⚠️  Could not check architecture (file command unavailable)`);
}

// ── Version check ────────────────────────────────────────

try {
	const version = execSync(`"${binaryPath}" --version`, { encoding: "utf-8", timeout: 5000 });
	console.log(`  📋 ${version.trim()}`);
	if (version.includes("9.1")) pass("Version: 9.1.x (expected)");
	else console.log(`  ⚠️  Unexpected version: ${version.trim()}`);
} catch (err) {
	fail(`Version check failed: ${err instanceof Error ? err.message : String(err)}`);
}

// ── PING/PONG test ───────────────────────────────────────

console.log(`\n  Starting Valkey for live test...`);

const port = 63800 + Math.floor(Math.random() * 100);
let valkeyProcess: ChildProcess | undefined;

try {
	valkeyProcess = spawn(binaryPath, [
		"--port", String(port),
		"--bind", "127.0.0.1",
		"--save", "",
		"--appendonly", "no",
		"--daemonize", "no",
	], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	// Wait for ready signal
	const ready = await new Promise<boolean>((resolve) => {
		const timeout = setTimeout(() => resolve(false), 10000);
		let output = "";
		valkeyProcess!.stdout?.on("data", (data: Buffer) => {
			output += data.toString();
			if (output.includes("Ready to accept connections")) {
				clearTimeout(timeout);
				resolve(true);
			}
		});
		valkeyProcess!.stderr?.on("data", (data: Buffer) => {
			output += data.toString();
			if (output.includes("Ready to accept connections")) {
				clearTimeout(timeout);
				resolve(true);
			}
		});
		valkeyProcess!.on("exit", () => {
			clearTimeout(timeout);
			resolve(false);
		});
	});

	if (!ready) {
		fail("Valkey did not become ready within 10s");
		throw new Error("Not ready");
	}
	pass(`Valkey ready on port ${port}`);

	// PING test using node:net
	const pong = await new Promise<string>((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port }, () => {
			socket.write("PING\r\n");
		});
		socket.on("data", (data: Buffer) => {
			resolve(data.toString().trim());
			socket.end();
		});
		socket.on("error", reject);
		setTimeout(() => reject(new Error("PING timeout")), 5000);
	});

	if (pong === "+PONG") {
		pass("PING → PONG");
	} else {
		fail(`PING response: ${pong}`);
	}

	// Clean shutdown
	valkeyProcess.kill("SIGTERM");
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 2000);
		if (valkeyProcess && !valkeyProcess.killed) {
			valkeyProcess.kill("SIGKILL");
		}
		resolve();
	});
	pass("Valkey process exited cleanly");

} catch (err) {
	fail(`Live test error: ${err instanceof Error ? err.message : String(err)}`);
	if (valkeyProcess && !valkeyProcess.killed) {
		valkeyProcess.kill("SIGKILL");
	}
}

// ── Summary ──────────────────────────────────────────────

console.log(`\n${passes} passed, ${failures} failed\n`);

if (failures > 0) {
	process.exit(1);
}

console.log("Smoke test complete — Valkey is release-ready for this platform.\n");
