import type { AgentRunnerRole, AgentToolPermissionPolicy } from "../agent-provider/index.js";
import type { OrchestrationRunRequest, OrchestrationRunResult } from "../orchestration-engine/index.js";
import type { TaskRecord } from "../task-registry/index.js";

export interface DriverProfile {
  schemaId: "ipt.driver-profile"; schemaVersion: "1.0.0";
  repository: string; integrationTarget: string; requiredCiChecks: string[];
  paths: { issues: string; responses: string; outbound: string; archive: string; exchange: string };
  roleActors: Record<AgentRunnerRole, string>;
  rolePolicies: Record<AgentRunnerRole, AgentToolPermissionPolicy>;
  manual: { maxAttempts:number; retryDelayMs:number; roleTimeoutMs:number };
}
export interface DriverSession {
  schemaId: "ipt.driver-session"; schemaVersion: "1.0.0";
  sessionId: string; projectRoot: string; profileHash: string; intakeId: string;
  taskId: string; issueNumber: number; definitionPath: string; definitionHash: string; registrationRevision: string;
  request: Omit<OrchestrationRunRequest, "signal">;
  status: "PREPARED" | "WAITING" | "STOPPED" | "DONE";
  pendingPacket: string | null; diagnosticId: string | null;
  predecessor: string | null; result: OrchestrationRunResult | null;
}
export interface IntakeRecord {
  schemaId: "ipt.driver-intake"; schemaVersion: "1.0.0";
  intakeId: string; projectRoot: string; profileHash: string; sourceHash: string;
  source: string; issueNumber: number | null; issueUrl: string | null; task: TaskRecord | null;
  diagnostics: string[]; sessionId: string | null;
}
export interface DriverResponse {
  schemaId: "ipt.driver-response"; schemaVersion: "1.0.0";
  projectRoot: string; profileHash: string; packetId: string;
  action: "clarify" | "recheck" | "rework";
  intakeId?: string; sessionId?: string; task?: TaskRecord; issueNumber?: number;
}
