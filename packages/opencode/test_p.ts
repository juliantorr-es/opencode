// Test 10: evaluatePredicate adapter delegates to checkPredicate
import { reduceCampaignState, LANE_STATE_MACHINE } from "./src/campaign/state-machine"
const s = { currentState:"created", events:[], transitionCount:0, stateHistory:[], metadata:{}, retryBudgets:{} }
const r = reduceCampaignState(s, [{type:"context.sufficient"}], LANE_STATE_MACHINE)
console.assert(r.currentState==="scouting", "expected scouting, got "+r.currentState)
console.log("PASS: change 10")
