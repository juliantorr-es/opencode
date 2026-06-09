import { Schema } from "effect"

// ── Primitives (re-exports) ──
export const Str = Schema.String
export const Num = Schema.Number
export const Bool = Schema.Boolean
export const Unknown = Schema.Unknown
export const NullConst = Schema.Null
export const UndefinedConst = Schema.Undefined

// ── Type helper ──
/** Type-level reference to a Schema. Use: S.Type<typeof MySchema> */
export type Type<T extends Schema.Schema<any>> = Schema.Schema.Type<T>
// If Schema.Schema.Type doesn't exist in beta.66, use a simpler approach:
// export type SType<S> = S extends Schema.Schema<infer A> ? A : never
export type SType<S> = S extends { readonly Type: infer A } ? A : never

// ── Nullable / Optional ──
export function Nullable<T>(schema: Schema.Schema<T>): Schema.Schema<T | null> {
  return Schema.Union([schema, Schema.Null]) as Schema.Schema<T | null>
}

export function Optional<T>(schema: Schema.Schema<T>): Schema.Schema<T | undefined> {
  return Schema.optional(schema) as Schema.Schema<T | undefined>
}

// ── Composite builders ──
/** Tuple: S.Tuple([S.Str, S.Num]) */
export function Tuple<T extends readonly Schema.Schema<any>[]>(elements: T): Schema.Schema<any> {
  return Schema.Tuple(elements as any) as any
}

/** Tagged union: S.Union([S.Literal("a"), S.Literal("b")]) */
export function Union<T extends readonly Schema.Schema<any>[]>(members: T): Schema.Schema<any> {
  return Schema.Union(members) as any
}

/** Struct: S.Struct({ name: S.Str, age: S.Num }) */
export function Struct<T extends Record<string, Schema.Schema<any>>>(fields: T): Schema.Schema<any> {
  return Schema.Struct(fields as any) as any
}

// ── Array ──
export function Arr<T>(item: Schema.Schema<T>): Schema.Schema<readonly T[]> {
  return Schema.Array(item) as Schema.Schema<readonly T[]>
}

// ── Record ──
export function Rec<K, V>(key: Schema.Schema<K>, value: Schema.Schema<V>): Schema.Schema<Record<string, V>> {
  return Schema.Record(key as any, value as any) as Schema.Schema<Record<string, V>>
}

// ── Literal ──
export function Lit<T extends string | number | boolean>(value: T): Schema.Schema<T> {
  return Schema.Literal(value) as Schema.Schema<T>
}

/** Multi-literal: S.Lits(["a", "b", "c"]) */
export function Lits<T extends readonly (string | number | boolean)[]>(values: T): Schema.Schema<T[number]> {
  return Schema.Literals(values as any) as any
}

// ── Branding ──
/** Brand a string schema: S.Str.pipe(S.brand("RequestId")) */
export function brand<T extends string>(name: T) {
  return Schema.brand(name)
}

// ── Decode / Encode ──
/** Synchronously decode unknown input. Throws ParseError on failure. */
export function decodeSync<T>(schema: Schema.Schema<T>): (input: unknown) => T {
  return Schema.decodeUnknownSync(schema as any) as (input: unknown) => T
}

/** Asynchronously decode unknown input. Returns Effect<T, ParseError>. */
/** Synchronously encode a value to an unknown shape. */
export function encodeSync<T>(schema: Schema.Schema<T>): (value: T) => unknown {
  return Schema.encodeSync(schema as any) as (value: T) => unknown
}

/** Synchronously encode to unknown. Throws on failure. */
export function encodeUnknownSync<T>(schema: Schema.Schema<T>): (value: T) => unknown {
  return Schema.encodeUnknownSync(schema as any) as (value: T) => unknown
}

// ── Validation helpers ──
/** Try to decode. Returns the decoded value or null on failure (never throws). */
export function tryDecodeSync<T>(schema: Schema.Schema<T>, input: unknown): T | null {
  try {
    return decodeSync(schema)(input)
  } catch {
    return null
  }
}
