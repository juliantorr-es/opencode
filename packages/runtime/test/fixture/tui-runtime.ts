import { spyOn } from "bun:test"
import path from "path"
import { createBindingLookup } from "@opentui/keymap/extras"

const TuiConfig = {
  waitForDependencies: async () => {},
} as { waitForDependencies: () => Promise<void> } & Record<string, any>
type TuiConfig = {
  Resolved: {
    attention: { enabled: boolean; notifications: boolean; sound: boolean; volume: number; sound_pack: string; sounds: Record<string, string> }
    keybinds: any
    leader_timeout: number
    plugin?: any
    plugin_origins?: any
    plugin_enabled?: Record<string, boolean>
    [key: string]: any
  }
}

const TuiKeybind = {
  Keybinds: { parse: (input: any) => input },
  toBindingConfig: (keybinds: any) => ({}),
  CommandMap: {},
  bindingDefaults: () => ({}),
}
type TuiKeybind = {
  Keybinds: any
}

type PluginSpec = string | [string, Record<string, unknown>]
type ResolvedInput = Omit<TuiConfig["Resolved"], "attention" | "keybinds" | "leader_timeout"> & {
  attention?: Partial<TuiConfig["Resolved"]["attention"]>
  keybinds?: Partial<TuiKeybind["Keybinds"]>
  leader_timeout?: number
}

export function createTuiResolvedKeybinds(input: Partial<TuiKeybind["Keybinds"]> = {}): TuiConfig["Resolved"]["keybinds"] {
  const keybinds = TuiKeybind.Keybinds.parse(input)
  return createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
    commandMap: TuiKeybind.CommandMap,
    bindingDefaults: TuiKeybind.bindingDefaults() as any,
  })
}

export function createTuiResolvedConfig(input: ResolvedInput = {}): TuiConfig["Resolved"] {
  const keybinds = TuiKeybind.Keybinds.parse(input.keybinds ?? {})
  return {
    ...input,
    attention: {
      enabled: false,
      notifications: true,
      sound: true,
      volume: 0.4,
      sound_pack: "opencode.default",
      sounds: {},
      ...input.attention,
    },
    keybinds: createTuiResolvedKeybinds(keybinds),
    leader_timeout: input.leader_timeout ?? 2000,
  }
}

export function mockTuiRuntime(dir: string, plugin: PluginSpec[], opts?: { plugin_enabled?: Record<string, boolean> }) {
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(dir, "plugin-meta.json")
  const plugin_origins = plugin.map((spec) => ({
    spec,
    scope: "local" as const,
    source: path.join(dir, "tui.json"),
  }))
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue(undefined)
  const cwd = spyOn(process, "cwd").mockImplementation(() => dir)

  const config = createTuiResolvedConfig({
    plugin,
    plugin_origins,
    ...(opts?.plugin_enabled && { plugin_enabled: opts.plugin_enabled }),
  })

  return {
    config,
    restore: () => {
      cwd.mockRestore()
      wait.mockRestore()
      delete process.env.OPENCODE_PLUGIN_META_FILE
    },
  }
}
