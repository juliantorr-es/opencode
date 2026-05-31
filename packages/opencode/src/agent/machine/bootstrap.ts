import { Effect } from "effect"
import { Service as MachineRegistry } from "./runtime"
import { generalManDef } from "./general-man"
import { secretaryDef } from "./secretary"
import { cartographerDef } from "./cartographer"
import { architectDef } from "./architect"
import { criticDef } from "./critic"
import { surgeonDef } from "./surgeon"
import { trialDef } from "./trial"
import { journalistDef } from "./journalist"
import {
  surveyorDef, compassDef, soundingsDef, logbookDef,
  foundationDef, loadBearerDef, buildingInspectorDef, blueprintDef, zoningBoardDef,
  witnessDef, coronerDef, precedentDef, blastRadiusDef, reasonableDoubtDef, exhibitADef, appealDef,
  scalpelDef, vitalsDef, stressTestDef, secondOpinionDef, tourniquetDef, monitorDef,
  scoopDef, editorDef, bylineDef, pressDef, retortDef, headlineDef,
  qaObserverDef, redTeamDef, emsDef,
} from "./stubs"

/**
 * Bootstraps all machine definitions into the registry.
 * Call this once at application startup to make all machines available for spawning.
 * Requires MachineRegistry to be provided via effect layer.
 */
export const bootstrapAllMachines: Effect.Effect<void, never, MachineRegistry> = Effect.gen(function* () {
  const registry = yield* MachineRegistry

  // General Management
  yield* registry.register(generalManDef)

  // Lane lifecycle
  yield* registry.register(secretaryDef)

  // Wave 1: Cartographer crew
  yield* registry.register(cartographerDef)
  yield* registry.register(surveyorDef)
  yield* registry.register(compassDef)
  yield* registry.register(soundingsDef)
  yield* registry.register(logbookDef)

  // Wave 2: Architect crew
  yield* registry.register(architectDef)
  yield* registry.register(foundationDef)
  yield* registry.register(loadBearerDef)
  yield* registry.register(buildingInspectorDef)
  yield* registry.register(blueprintDef)
  yield* registry.register(zoningBoardDef)

  // Wave 3: Critic crew
  yield* registry.register(criticDef)
  yield* registry.register(witnessDef)
  yield* registry.register(coronerDef)
  yield* registry.register(precedentDef)
  yield* registry.register(blastRadiusDef)
  yield* registry.register(reasonableDoubtDef)
  yield* registry.register(exhibitADef)
  yield* registry.register(appealDef)

  // Wave 4: Surgeon crew
  yield* registry.register(surgeonDef)
  yield* registry.register(scalpelDef)
  yield* registry.register(vitalsDef)
  yield* registry.register(stressTestDef)
  yield* registry.register(secondOpinionDef)
  yield* registry.register(tourniquetDef)
  yield* registry.register(monitorDef)

  // Wave 5: Trial crew
  yield* registry.register(trialDef)
  yield* registry.register(qaObserverDef)
  yield* registry.register(redTeamDef)
  yield* registry.register(emsDef)

  // Wave 6: Journalist crew
  yield* registry.register(journalistDef)
  yield* registry.register(scoopDef)
  yield* registry.register(editorDef)
  yield* registry.register(bylineDef)
  yield* registry.register(pressDef)
  yield* registry.register(retortDef)
  yield* registry.register(headlineDef)
})
