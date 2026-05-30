import { ColorPickerV2 } from "./color-picker-v2"
import { createSignal } from "solid-js"

const docs = `### Overview
Color picker with hex input, preset swatches, and recent colors.

### API
- \`value\`, \`defaultValue\` - controlled/uncontrolled hex color
- \`swatches\` - custom swatch grid (default: 24 presets)
- \`showRecent\` - toggle recent colors section
- \`onChange\` - callback when color changes

### Accessibility
- Full keyboard navigation between swatches
- ARIA labels on all interactive elements
- Error state for invalid hex input
- Native color picker via eyedropper button
`

export default {
  title: "UI V2/ColorPickerV2",
  id: "components-color-picker-v2",
  component: ColorPickerV2,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    defaultValue: "#2196f3",
    label: "Accent Color",
  },
}

export const Playground = {}

export const Controlled = {
  render: () => {
    const [color, setColor] = createSignal("#e91e63")
    return (
      <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
        <ColorPickerV2 value={color()} onChange={setColor} label="Pick a color" />
        <div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
          <div
            style={{
              width: 24,
              height: 24,
              "border-radius": 4,
              "background-color": color(),
              border: "1px solid #ccc",
            }}
          />
          <span style={{ "font-family": "monospace", "font-size": "13px" }}>{color()}</span>
        </div>
      </div>
    )
  },
}

export const CustomSwatches = {
  args: {
    swatches: ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9", "#4dabf7", "#748ffc", "#da77f2"],
    defaultValue: "#4dabf7",
    label: "Custom Palette",
  },
}

export const NoRecent = {
  args: {
    showRecent: false,
    defaultValue: "#000000",
    label: "No Recent Colors",
  },
}
