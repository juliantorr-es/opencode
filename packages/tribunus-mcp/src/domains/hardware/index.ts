import { registerTool } from "../../server/registry.js"

// Hardware monitoring tools are registered by the compute domain (macmon_metrics, macmon_session).
// This module exists for future hardware-specific tooling (Instruments scripting, GPU counter sampling, thermal policy).

export function registerHardwareTools(): void {
  // Future: register additional hardware tools here
}
