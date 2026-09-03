export {
  TASK_DEFINITIONS_RELATIVE_PATH,
  TASK_FILE_SUFFIX,
  TASK_SCHEMA_RELATIVE_PATH,
  TaskRegistryLoadError,
  discoverTaskDefinitionPaths,
  loadTaskRegistry,
  loadTaskRegistryFromPaths,
} from "./registry.js";

export type {
  RegisteredTask,
  TaskRecord,
  TaskRegistry,
  TaskRegistryDiagnostic,
  TaskRegistryDiagnosticCode,
  TaskRegistryLoadOptions,
} from "./registry.js";
