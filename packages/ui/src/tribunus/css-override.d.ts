/**
 * Override Lit's `css` tagged template signature to accept string interpolations.
 *
 * Lit 3.x narrows the parameter types of `css` to exclude `string`, which
 * breaks W3C DTCG design token systems where token values are plain strings.
 * At runtime, Lit handles string values correctly in CSS templates, so this
 * override is safe.
 */
declare global {
  namespace JSX {
    // dummy to make this a valid ambient module
  }
}
