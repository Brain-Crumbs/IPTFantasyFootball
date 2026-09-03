export {
  LIFECYCLE_SCHEMA_ID,
  LIFECYCLE_SCHEMA_VERSION,
  TRANSITION_RULES,
  createLifecycleRecord,
  getTransitionRule,
  transitionLifecycle,
} from "./state-machine.js";

export type {
  LifecycleHistoryEvent,
  LifecycleRecord,
  ReviewRole,
  TransitionPrerequisiteKey,
  TransitionRejection,
  TransitionRejectionCode,
  TransitionRequest,
  TransitionResult,
  TransitionRule,
} from "./state-machine.js";
