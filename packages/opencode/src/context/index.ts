// Flat re-exports from modules with unique names (no conflict risk)
export * from "./invalidation-registry"

// Namespace re-exports for modules with common names (Interface, Service, layer, etc.)
export * as InvalidationBus from "./invalidation-bus"
export * as FileMemory from "./file-memory"
export * as Packet from "./packet"
export * as ProjectMap from "./project-map"
export * as ContextTools from "./tools"
export * as ValidationContext from "./validation-context"

// Workers namespace
export * as Workers from "./workers"
