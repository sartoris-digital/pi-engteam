export {
  FUSION_MODES,
  isFusionMode,
  type FusionMode,
  type FusionRequest,
  type FusionSlot,
  type SlotResult,
} from "./types.js";
export { validateStack, vendorPrefix, type StackValidation } from "./stack.js";
export { mergeSample } from "./sample.js";
export { mergeOpinion } from "./opinion.js";
export { mergeFuse } from "./fuse.js";
export { mergeAdversarial } from "./adversarial.js";
export { mergeVeto } from "./veto.js";
export { mergeDebate } from "./debate.js";
export {
  fusionRequestFromStage,
  mergeForMode,
  runFusion,
  type RunFusionOptions,
} from "./run.js";
export {
  degradeSlots,
  fusionEvidence,
  isDroppedSlot,
  resolvePinnedModel,
  slotEvidence,
  withFusionEvidence,
  type FusionEvidence,
  type FusionEvidenceSlot,
} from "./degrade.js";
