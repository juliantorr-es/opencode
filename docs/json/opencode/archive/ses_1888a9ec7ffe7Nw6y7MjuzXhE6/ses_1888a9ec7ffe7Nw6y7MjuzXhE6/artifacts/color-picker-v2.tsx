import { createSignal, createMemo, For, Show, splitProps, onCleanup } from "solid-js"
import "./color-picker-v2.css"

export interface ColorPickerV2Props {
  class?: string
  classList?: Record<string, boolean | undefined>
  /** Current hex color value */
  value?: string
  /** Default value */
  defaultValue?: string
  /** Preset swatches (default: provided palette) */
  swatches?: string[]
  /** Show recent colors section */
  showRecent?: boolean
  /** Called when color changes */
  onChange?: (color: string) => void
  /** Label for accessibility */
  label?: string
}

const DEFAULT_SWATCHES = [
  "#ffffff", "#f5f5f5", "#e0e0e0", "#bdbdbd", "#757575", "#424242", "#212121", "#000000",
  "#f44336", "#e91e63", "#9c27b0", "#673ab7", "#3f51b5", "#2196f3", "#03a9f4", "#00bcd4",
  "#009688", "#4caf50", "#8bc34a", "#cddc39", "#ffeb3b", "#ffc107", "#ff9800", "#ff5722",
]

const STORAGE_KEY = "opencode-v2-recent-colors"

function loadRecent(): string[] {
  if (typeof window === "undefined") return []
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? (JSON.parse(stored) as string[]).slice(0, 8) : []
  } catch {
    return []
  }
}

function saveRecent(colors: string[]) {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors.slice(0, 8)))
  } catch {
    /* ignore */
  }
}

function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(hex)
}

export function ColorPickerV2(props: ColorPickerV2Props) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "value",
    "defaultValue",
    "swatches",
    "showRecent",
    "onChange",
    "label",
  ])

  const [hexInput, setHexInput] = createSignal(local.value ?? local.defaultValue ?? "#000000")
  const [recentColors, setRecentColors] = createSignal<string[]>(loadRecent())
  const [isInvalid, setIsInvalid] = createSignal(false)

  const swatches = createMemo(() => local.swatches ?? DEFAULT_SWATCHES)

  const currentColor = createMemo(() => {
    const v = local.value ?? hexInput()
    return isValidHex(v) ? v : "#000000"
  })

  const handleHexInput = (input: string) => {
    const hex = input.startsWith("#") ? input : `#${input}`
    setHexInput(hex)

    if (isValidHex(hex)) {
      setIsInvalid(false)
      local.onChange?.(hex)
    } else {
      setIsInvalid(hex.length > 1)
    }
  }

  const handleSwatchPick = (color: string) => {
    setHexInput(color)
    setIsInvalid(false)
    const recent = [color, ...recentColors().filter((c) => c !== color)].slice(0, 8)
    setRecentColors(recent)
    saveRecent(recent)
    local.onChange?.(color)
  }

  const handleNativePicker = () => {
    const input = document.createElement("input")
    input.type = "color"
    input.value = currentColor()
    input.addEventListener("input", () => {
      handleSwatchPick(input.value)
    })
    input.click()
  }

  return (
    <div
      data-component="color-picker-v2"
      data-invalid={isInvalid() ? "" : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.label}>
        <label data-slot="color-picker-v2-label">{local.label}</label>
      </Show>

      {/* Preview + Hex Input */}
      <div data-slot="color-picker-v2-input-row">
        <div data-slot="color-picker-v2-preview" style={{ "background-color": currentColor() }} />
        <input
          data-slot="color-picker-v2-input"
          type="text"
          value={hexInput()}
          onInput={(e) => handleHexInput(e.currentTarget.value)}
          aria-label={local.label ?? "Hex color value"}
          aria-invalid={isInvalid() ? "true" : undefined}
          placeholder="#000000"
        />
        <button
          data-slot="color-picker-v2-picker-btn"
          onClick={handleNativePicker}
          aria-label="Pick color from screen"
          title="Pick color"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M11.5 2.5L12.5 1.5C13.1667 0.833333 14.1667 0.833333 14.8333 1.5C15.5 2.16667 15.5 3.16667 14.8333 3.83333L13.5 5.16667M11.5 2.5L5.5 8.5M11.5 2.5L13.5 4.5M5.5 8.5L2.5 14.5L8.5 11.5M5.5 8.5L8.5 11.5"
              stroke="currentColor"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <Show when={isInvalid()}>
        <span data-slot="color-picker-v2-error">Invalid hex color</span>
      </Show>

      {/* Swatch Grid */}
      <div data-slot="color-picker-v2-swatches">
        <For each={swatches()}>
          {(color) => (
            <button
              data-slot="color-picker-v2-swatch"
              data-active={color === currentColor() ? "" : undefined}
              style={{ "background-color": color }}
              onClick={() => handleSwatchPick(color)}
              aria-label={color}
              tabindex="0"
            />
          )}
        </For>
      </div>

      {/* Recent Colors */}
      <Show when={local.showRecent !== false && recentColors().length > 0}>
        <div data-slot="color-picker-v2-recent">
          <span data-slot="color-picker-v2-recent-label">Recent</span>
          <div data-slot="color-picker-v2-recent-swatches">
            <For each={recentColors()}>
              {(color) => (
                <button
                  data-slot="color-picker-v2-swatch"
                  data-recent
                  style={{ "background-color": color }}
                  onClick={() => handleSwatchPick(color)}
                  aria-label={`Recent: ${color}`}
                  tabindex="0"
                />
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
