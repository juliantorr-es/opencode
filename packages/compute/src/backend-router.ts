import type { DType } from "./types.js"
import type { ComputeOp } from "./operation-graph.js"
import { isNativeAvailable, detectDefaultDevice } from "./native-backend.js"

export type AcceleratorBackend =
  | "metal"
  | "cuda"
  | "hip"
  | "oneapi"
  | "vulkan"
  | "webgpu"
  | "cpu"

export interface BackendCapability {
  readonly backend: AcceleratorBackend
  readonly available: boolean
  readonly deviceName: string
  readonly memoryBytes: number
  readonly computeUnits: number
}

export interface BackendRouter {
  readonly availableBackends: BackendCapability[]
  selectBackend(op: ComputeOp): AcceleratorBackend
  getBackend(name: AcceleratorBackend): BackendCapability | undefined
}

type OpFamily =
  | "matmul"
  | "convolution"
  | "elementwise"
  | "reduction"
  | "activation"
  | "reshape"
  | "io"
  | "other"

function classifyOp(opType: string): OpFamily {
  const lower = opType.toLowerCase()
  if (
    lower.includes("matmul") ||
    lower.includes("gemm") ||
    lower.includes("linear") ||
    lower.includes("dense")
  ) {
    return "matmul"
  }
  if (
    lower.includes("conv") ||
    lower.includes("conv2d") ||
    lower.includes("conv3d")
  ) {
    return "convolution"
  }
  if (
    lower.includes("add") ||
    lower.includes("sub") ||
    lower.includes("mul") ||
    lower.includes("div") ||
    lower.includes("sigmoid") ||
    lower.includes("tanh")
  ) {
    return "elementwise"
  }
  if (
    lower.includes("sum") ||
    lower.includes("mean") ||
    lower.includes("max") ||
    lower.includes("min") ||
    lower.includes("reduce") ||
    lower.includes("softmax")
  ) {
    return "reduction"
  }
  if (
    lower.includes("relu") ||
    lower.includes("gelu") ||
    lower.includes("silu") ||
    lower.includes("elu") ||
    lower.includes("leaky") ||
    lower.includes("prelu")
  ) {
    return "activation"
  }
  if (
    lower.includes("reshape") ||
    lower.includes("transpose") ||
    lower.includes("permute") ||
    lower.includes("slice") ||
    lower.includes("concat") ||
    lower.includes("split") ||
    lower.includes("pad") ||
    lower.includes("flatten")
  ) {
    return "reshape"
  }
  if (
    lower.includes("copy") ||
    lower.includes("transfer") ||
    lower.includes("load") ||
    lower.includes("store") ||
    lower.includes("read") ||
    lower.includes("write")
  ) {
    return "io"
  }
  return "other"
}

interface BackendWeight {
  readonly backend: AcceleratorBackend
  score(opFamily: OpFamily): number
}

const backendWeights: BackendWeight[] = [
  {
    backend: "cuda",
    score(family) {
      switch (family) {
        case "matmul":
        case "convolution":
          return 100
        case "reduction":
          return 90
        case "activation":
        case "elementwise":
          return 80
        case "reshape":
          return 50
        case "io":
          return 30
        default:
          return 70
      }
    },
  },
  {
    backend: "hip",
    score(family) {
      switch (family) {
        case "matmul":
        case "convolution":
          return 95
        case "reduction":
          return 85
        case "activation":
        case "elementwise":
          return 75
        case "reshape":
          return 50
        case "io":
          return 30
        default:
          return 65
      }
    },
  },
  {
    backend: "metal",
    score(family) {
      switch (family) {
        case "matmul":
        case "convolution":
          return 90
        case "reduction":
          return 80
        case "activation":
        case "elementwise":
          return 90
        case "reshape":
          return 60
        case "io":
          return 40
        default:
          return 75
      }
    },
  },
  {
    backend: "oneapi",
    score(family) {
      switch (family) {
        case "matmul":
        case "convolution":
          return 85
        case "reduction":
          return 75
        case "activation":
        case "elementwise":
          return 70
        case "reshape":
          return 50
        case "io":
          return 30
        default:
          return 60
      }
    },
  },
  {
    backend: "vulkan",
    score(family) {
      switch (family) {
        case "matmul":
        case "convolution":
          return 75
        case "reduction":
          return 65
        case "activation":
        case "elementwise":
          return 70
        case "reshape":
          return 55
        case "io":
          return 35
        default:
          return 60
      }
    },
  },
  {
    backend: "webgpu",
    score(family) {
      switch (family) {
        case "matmul":
        case "convolution":
          return 60
        case "reduction":
          return 55
        case "activation":
        case "elementwise":
          return 65
        case "reshape":
          return 50
        case "io":
          return 40
        default:
          return 50
      }
    },
  },
  {
    backend: "cpu",
    score(_family) {
      return 10
    },
  },
]

/** DTypes that require CPU fallback regardless of accelerator availability. */
const cpuOnlyDtypes: readonly DType[] = ["int8", "uint8"]

export function detectBackends(): BackendCapability[] {
  const backends: BackendCapability[] = []

  const computeUnits =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4

  backends.push({
    backend: "cpu",
    available: true,
    deviceName: "CPU (default)",
    memoryBytes: 0,
    computeUnits,
  })

  try {
    if (typeof process !== "undefined" && process.platform === "darwin") {
      const nativeAvailable = isNativeAvailable()
      const info = nativeAvailable ? detectDefaultDevice() : null
      backends.push({
        backend: "metal",
        available: nativeAvailable ? info!.available : true,
        deviceName: nativeAvailable ? info!.deviceName : "Apple Metal GPU (native addon not built)",
        memoryBytes: 0,
        computeUnits: 0,
      })
    }
  } catch {
    // not in a Node-like environment
  }
  try {
    if (
      typeof process !== "undefined" &&
      process.env.CUDA_VISIBLE_DEVICES !== undefined
    ) {
      backends.push({
        backend: "cuda",
        available: true,
        deviceName: "CUDA GPU",
        memoryBytes: 0,
        computeUnits: 0,
      })
    }
  } catch {
    // CUDA detection unavailable
  }

  try {
    if (
      typeof process !== "undefined" &&
      process.env.ROCM_PATH !== undefined
    ) {
      backends.push({
        backend: "hip",
        available: true,
        deviceName: "AMD HIP GPU",
        memoryBytes: 0,
        computeUnits: 0,
      })
    }
  } catch {
    // HIP detection unavailable
  }

  return backends
}

export function createBackendRouter(
  backends?: BackendCapability[],
): BackendRouter {
  const capabilities = backends ?? detectBackends()
  const byName = new Map<AcceleratorBackend, BackendCapability>()
  for (const cap of capabilities) {
    byName.set(cap.backend, cap)
  }

  const availableWeights = backendWeights.filter((w) =>
    byName.has(w.backend),
  )

  return {
    get availableBackends(): BackendCapability[] {
      return [...capabilities]
    },

    selectBackend(op: ComputeOp): AcceleratorBackend {
      const family = classifyOp(op.opType)

      // CPU-only dtypes force CPU fallback
      if (
        op.inputs.some((t) => cpuOnlyDtypes.includes(t.dtype)) ||
        op.outputs.some((t) => cpuOnlyDtypes.includes(t.dtype))
      ) {
        return "cpu"
      }

      let best: AcceleratorBackend = "cpu"
      let bestScore = -1

      for (const bw of availableWeights) {
        const score = bw.score(family)
        if (score > bestScore) {
          bestScore = score
          best = bw.backend
        }
      }

      return best
    },

    getBackend(name: AcceleratorBackend): BackendCapability | undefined {
      return byName.get(name)
    },
  }
}
