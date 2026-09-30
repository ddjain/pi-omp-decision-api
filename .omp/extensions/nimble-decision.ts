// OMP uses the same extension API as Pi. Keep one implementation so both agents
// share routing, tool gating, audit records, and configuration.
export { default } from "../../.pi/extensions/nimble-decision.ts";
