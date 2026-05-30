import { SliderV2 } from "./slider-v2"

const docs = `### Overview
Accessible slider component with horizontal/vertical orientation and discrete mode.

### API
- \`minValue\`, \`maxValue\`, \`step\`, \`defaultValue\` - range configuration
- \`orientation\`: "horizontal" | "vertical"
- \`showTicks\`: enables discrete tick marks
- \`label\`: accessible label text
- \`formatValue\`: custom value formatter
- Inherits Kobalte Slider props

### Accessibility
- Uses Kobalte's Slider primitive for full ARIA support
- Keyboard navigation: Arrow keys, Home/End
- Screen reader friendly via Label and ValueLabel components
`

export default {
  title: "UI V2/SliderV2",
  id: "components-slider-v2",
  component: SliderV2,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    label: "Volume",
    defaultValue: [50],
    maxValue: 100,
    minValue: 0,
    step: 1,
  },
  argTypes: {
    orientation: {
      control: "select",
      options: ["horizontal", "vertical"],
    },
  },
}

export const Playground = {}

export const WithTicks = {
  args: {
    showTicks: true,
    step: 10,
    defaultValue: [30],
  },
}

export const Vertical = {
  args: {
    orientation: "vertical",
    defaultValue: [75],
    style: { height: "200px" },
  },
}

export const AllStates = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "24px", "max-width": "400px" }}>
      <SliderV2 label="Default" defaultValue={[50]} maxValue={100} />
      <SliderV2 label="With Ticks" showTicks step={10} defaultValue={[30]} maxValue={100} />
      <SliderV2 label="Disabled" defaultValue={[60]} maxValue={100} disabled />
      <div style={{ display: "flex", gap: "24px", height: "200px" }}>
        <SliderV2 label="Vertical" orientation="vertical" defaultValue={[75]} maxValue={100} />
        <SliderV2
          label="Vertical Ticks"
          orientation="vertical"
          defaultValue={[25]}
          maxValue={100}
          showTicks
          step={25}
        />
      </div>
    </div>
  ),
}
