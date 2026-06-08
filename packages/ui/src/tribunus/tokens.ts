/**
 * Tribunus Design Tokens — W3C DTCG format
 *
 * Defines the primitive visual primitives: color, spacing, typography,
 * radius, shadow, and animation durations.
 */
export const tokens = {
  color: {
    primary: { $type: "color", $value: "#6366f1" },
    secondary: { $type: "color", $value: "#8b5cf6" },
    accent: { $type: "color", $value: "#06b6d4" },
    success: { $type: "color", $value: "#22c55e" },
    warning: { $type: "color", $value: "#f59e0b" },
    error: { $type: "color", $value: "#ef4444" },
    surface: { $type: "color", $value: "#1e1e2e" },
    text: { $type: "color", $value: "#e2e8f0" },
    surfaceAlt: { $type: "color", $value: "#2a2a3e" },
    border: { $type: "color", $value: "#3a3a4e" },
  },
  spacing: {
    xs: { $type: "dimension", $value: "4px" },
    sm: { $type: "dimension", $value: "8px" },
    md: { $type: "dimension", $value: "16px" },
    lg: { $type: "dimension", $value: "24px" },
    xl: { $type: "dimension", $value: "32px" },
    "2xl": { $type: "dimension", $value: "48px" },
  },
  typography: {
    fontSize: {
      sm: { $type: "dimension", $value: "0.75rem" },
      base: { $type: "dimension", $value: "0.875rem" },
      lg: { $type: "dimension", $value: "1rem" },
      xl: { $type: "dimension", $value: "1.25rem" },
      "2xl": { $type: "dimension", $value: "1.5rem" },
      "3xl": { $type: "dimension", $value: "2rem" },
    },
    fontWeight: {
      normal: { $type: "number", $value: 400 },
      medium: { $type: "number", $value: 500 },
      semibold: { $type: "number", $value: 600 },
      bold: { $type: "number", $value: 700 },
    },
  },
  radius: {
    sm: { $type: "dimension", $value: "4px" },
    md: { $type: "dimension", $value: "8px" },
    lg: { $type: "dimension", $value: "12px" },
    full: { $type: "dimension", $value: "9999px" },
  },
  shadow: {
    sm: { $type: "shadow", $value: "0 1px 2px 0 rgba(0,0,0,0.3)" },
    md: { $type: "shadow", $value: "0 4px 6px -1px rgba(0,0,0,0.3), 0 2px 4px -2px rgba(0,0,0,0.2)" },
    lg: { $type: "shadow", $value: "0 10px 15px -3px rgba(0,0,0,0.3), 0 4px 6px -4px rgba(0,0,0,0.2)" },
  },
  animation: {
    duration: {
      fast: { $type: "duration", $value: "150ms" },
      normal: { $type: "duration", $value: "300ms" },
      slow: { $type: "duration", $value: "500ms" },
    },
  },
} as const

export type Tokens = typeof tokens
