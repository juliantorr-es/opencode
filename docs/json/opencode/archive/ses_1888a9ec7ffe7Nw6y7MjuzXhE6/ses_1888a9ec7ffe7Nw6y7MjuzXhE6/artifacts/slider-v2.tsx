import { Slider as Kobalte } from "@kobalte/core/slider"
import { Show, createMemo, splitProps, type ComponentProps } from "solid-js"
import "./slider-v2.css"

interface GetValueLabelParams {
  values: number[]
  min: number
  max: number
}

export interface SliderV2Props extends ComponentProps<typeof Kobalte> {
  /** Label for accessibility */
  label?: string
  /** Show tick marks for discrete mode */
  showTicks?: boolean
  /** Tick interval (defaults to step if not set) */
  tickInterval?: number
  /** Format the displayed value */
  formatValue?: (value: number) => string
}

export function SliderV2(props: SliderV2Props) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "label",
    "showTicks",
    "tickInterval",
    "formatValue",
    "getValueLabel",
  ])

  const tickInterval = createMemo(() => local.tickInterval ?? props.step ?? 1)

  const ticks = createMemo(() => {
    if (!local.showTicks) return []
    const min = props.minValue ?? 0
    const max = props.maxValue ?? 100
    const interval = tickInterval()
    const count = Math.floor((max - min) / interval)
    return Array.from({ length: count + 1 }, (_, i) => min + i * interval)
  })

  const mergedGetValueLabel = createMemo(() => {
    if (local.formatValue) {
      const fmt = local.formatValue
      return (params: GetValueLabelParams) => params.values.map(fmt).join(" – ")
    }
    if (local.getValueLabel) {
      return local.getValueLabel
    }
    return (params: GetValueLabelParams) => params.values.join(" – ")
  })

  return (
    <Kobalte
      {...others}
      getValueLabel={mergedGetValueLabel()}
      data-component="slider-v2"
      data-tick={local.showTicks ? "" : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <div data-slot="slider-v2-label-row">
        <Show when={local.label}>
          <Kobalte.Label data-slot="slider-v2-label">{local.label}</Kobalte.Label>
        </Show>
        <Kobalte.ValueLabel data-slot="slider-v2-value" />
      </div>
      <div data-slot="slider-v2-track-area">
        <Kobalte.Track data-slot="slider-v2-track">
          <Kobalte.Fill data-slot="slider-v2-fill" />
          <Show when={local.showTicks}>
            <div data-slot="slider-v2-ticks">
              {ticks().map((tick) => (
                <div
                  data-slot="slider-v2-tick"
                  data-active={tick <= ((props.value ?? props.defaultValue ?? [0])[0]) ? "" : undefined}
                />
              ))}
            </div>
          </Show>
          <Kobalte.Thumb data-slot="slider-v2-thumb">
            <Kobalte.Input data-slot="slider-v2-input" />
          </Kobalte.Thumb>
        </Kobalte.Track>
      </div>
    </Kobalte>
  )
}
