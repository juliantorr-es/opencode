import { Cause, Effect } from "effect"

// Effect module namespace is frozen. Try defineProperty.
console.log("catchAllCause exists:", typeof (Effect as any).catchAllCause)

try {
  Object.defineProperty(Effect, "catchAllCause", {
    value: (handler: any) => (self: any) => self.pipe(Effect.catchCause(handler)),
    writable: true,
    configurable: true,
  })
  console.log("Polyfill via defineProperty applied")
} catch (e) {
  console.log("defineProperty failed:", (e as Error).message)
}

console.log("catchAllCause exists now:", typeof (Effect as any).catchAllCause)
