import { createServer, startServer } from "./server/server.js"
import { initPathPolicy } from "./governance/paths.js"
import { join, resolve } from "node:path"
import { homedir } from "node:os"

const MLX_MODEL_DIR = process.env.TRIBUNUS_MLX_MODEL_DIR || join(homedir(), ".cache/tribunus/models")

const server = createServer()

initPathPolicy(
  process.cwd(),
  join(process.cwd(), "packages/compute-native/evidence"),
  MLX_MODEL_DIR,
  join(process.cwd(), ".omp/evidence"),
)

import { registerGitHubTools } from "./domains/github/index.js"
import { registerComputeTools } from "./domains/compute/index.js"
import { registerEvidenceTools } from "./domains/evidence/index.js"
import { registerHardwareTools } from "./domains/hardware/index.js"
import { registerOmpControlPlaneTools } from "./domains/omp/control-plane.js"
import { registerOmpRepoIntelTools } from "./domains/omp/repo-intelligence.js"
import { registerCrossCuttingTools } from "./tools/index.js"
import { registerArtifactTools } from "./domains/artifacts/index.js"
import { registerPublicationTools } from "./domains/publication/index.js"

registerGitHubTools()
registerComputeTools()
registerEvidenceTools()
registerHardwareTools()
registerOmpControlPlaneTools()
registerOmpRepoIntelTools()
registerCrossCuttingTools()
registerArtifactTools()
registerPublicationTools()

await startServer(server)
