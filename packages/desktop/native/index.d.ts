// Type stubs for native modules — built by `bun install --cwd native`
// These are replaced when the native build step completes.

export interface MacWindow {
  setWindowPosition(x: number, y: number): void
  getWindowPosition(): { x: number; y: number }
  setWindowSize(width: number, height: number): void
  getWindowSize(): { width: number; height: number }
}

export function createMacWindow(): MacWindow
