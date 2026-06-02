import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "tribunus-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  // Native titlebar addon — requires prebuilt artifacts in native/.
  // Build native modules (mac_window.node, swift-bridge) before packaging
  // or the bundled app will lack native titlebar/window features.
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "Tribunus",
    schemes: ["tribunus"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    // Azure Artifact Signing for Windows (#15201) uses ephemeral certificates
    // managed by Azure, which are incompatible with electron-builder's
    // verifyUpdateCodeSignature check. The installer is still signed at build
    // time, but auto-update signature verification must be disabled until a
    // stable publisher certificate is available or electron-builder supports
    // dynamic certificate verification for Azure-signed binaries.
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: "dev.tribunus.desktop.dev",
        productName: "Tribunus Dev",
        rpm: { packageName: "tribunus-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: "dev.tribunus.desktop.beta",
        productName: "Tribunus Beta",
        protocols: { name: "Tribunus Beta", schemes: ["tribunus"] },
        publish: { provider: "github", owner: "tribunus-dev", repo: "tribunus-beta", channel: "latest" },
        rpm: { packageName: "tribunus-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: "dev.tribunus.desktop",
        productName: "Tribunus",
        protocols: { name: "Tribunus", schemes: ["tribunus"] },
        publish: { provider: "github", owner: "tribunus-dev", repo: "tribunus", channel: "latest" },
        rpm: { packageName: "tribunus" },
      }
    }
  }
}

export default getConfig()
