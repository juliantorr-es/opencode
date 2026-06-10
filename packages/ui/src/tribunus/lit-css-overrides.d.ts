/**
 * Lit CSS tagged template literal compatibility with design token strings.
 *
 * Lit 3.x narrows the `css` tagged template to accept only CSSResult | number |
 * boolean | null | undefined in interpolation slots. Design tokens produce plain
 * strings, which Lit rejects at type-check time but handles correctly at
 * runtime.
 *
 * This module augmentation widens `css` to accept any value, restoring
 * compatibility with W3C DTCG design token systems.
 */

declare module "lit" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function css(template: TemplateStringsArray, ...values: any[]): import("lit").CSSResultGroup
}

export {}
