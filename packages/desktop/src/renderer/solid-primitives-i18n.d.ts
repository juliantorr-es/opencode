declare module "@solid-primitives/i18n" {
  export type Flatten<T extends Record<string, any>, Key extends string = ""> = {
    [K in keyof T as Key extends "" ? K : `${Key}.${K & string}`]: T[K] extends Record<string, any>
      ? Flatten<T[K], K & string>
      : T[K]
  } & Record<string, string>

  export function flatten<T extends Record<string, any>>(dict: T): Flatten<T>

  export function resolveTemplate(
    template: string,
    params?: Record<string, unknown>,
  ): string

  export function translator<T extends Record<string, string>>(
    dict: () => T,
    formatter: typeof resolveTemplate,
  ): {
    (key: string, params?: Record<string, unknown>, plural?: number): string
    locale: string
  }
}
