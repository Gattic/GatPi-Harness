"use strict";

/**
 * Composition root for the clean integration boundary between Pi core and local
 * cognitive libraries.
 *
 * Pi core depends on this module's adapter contracts, not on scattered imports
 * from library implementation modules. Each adapter is instance-local, can be
 * disabled, and receives persistence/logging/tracing dependencies through
 * explicit interfaces.
 *
 * Adapter implementations live in per-subsystem modules under
 * src/integration-boundary/. Keeping this file as a thin composition root means
 * adding an adapter no longer grows one 900-line module with every dependency
 * in the repository.
 */

const { AdvisorySkillPilot } = require("./advisory-skill-pilot");
const { CompoundingEffectivenessAdapter } = require("./compounding-effectiveness");
const { EntropyReview } = require("./entropy-review");
const { FileIntegrationStorage } = require("./file-integration-storage");
const { HermesAdvisoryAdapter } = require("./hermes-advisory");
const { MemoryMaintenanceAdapter } = require("./memory-maintenance");
const { ProjectMemoryCandidatePipeline, appendProjectMemoryDiagnostic, captureAttemptSummary, readDiagnosticReviewRequests, resolveDiagnosticReview } = require("./project-memory-candidates");
const { ProjectMemoryCaptureAdapter } = require("./project-memory-capture");
const { applyProjectMemoryPosture } = require("./project-memory-posture");
const { projectMemoryRuntimeConfig } = require("./project-memory-runtime");
const { ProvenanceGraphAdapter } = require("./provenance-graph");
const { RolloutCenterAdapter } = require("./rollout-center");
const { SessionSearchAdapter } = require("./session-search");
const { SkillIntakeAdapter } = require("./skill-intake");
const { SubagentTopologyExecutor } = require("./multi-agent-topologies");
const { VisualVerificationAdapter } = require("./visual-verification");

const {
  MemoryJsonStorage,
  NullSink,
  RecordingSink,
  roleResultContractLimits,
} = require("./integration-boundary/common.js");
const {
  CognitiveMemoryAdapter,
  FileAnchoringAdapter,
  LayeredContextAdapter,
  MemoryContentSafetyAdapter,
  MemoryStateAdapter,
  PrivacyGuardScanAdapter,
  ProjectMemoryAdapter,
  RetentionAdapter,
  SessionStorageAttributionAdapter,
  StateInventoryAdapter,
  StatePermissionsAdapter,
} = require("./integration-boundary/memory.js");
const {
  MemoryEvidenceStore,
  MemoryVerificationCache,
  MemoryVerificationMetrics,
  VerificationAdapter,
} = require("./integration-boundary/verification.js");
const {
  BranchingAdapter,
  EntropyAdapter,
  EntropyPersistenceAdapter,
  MemoryBranchStore,
  OrchestrationAdapter,
  ReasoningRuntimeAdapter,
} = require("./integration-boundary/context.js");
const {
  MultiAgentTopologyAdapter,
  SkillSynthesisAdapter,
  SpecialistToolsAdapter,
  SubagentAdapter,
  SubagentTasksAdapter,
  clearSpecialistRuntimeCache,
} = require("./integration-boundary/agents.js");
const {
  ExecutionOutcomeAdapter,
  GoalControllerAdapter,
  GoalEvidenceAdapter,
  LearningLoopAdapter,
  SystemOneAdapter,
  TraceAdapter,
} = require("./integration-boundary/governance.js");

function configureProjectMemoryServices(boundary, { cwd = process.cwd(), env = process.env, vault } = {}) {
  const runtime = projectMemoryRuntimeConfig(cwd, env, { vault });
  boundary.projectMemory = new ProjectMemoryAdapter(runtime.adapter);
  boundary.projectMemoryRollout = runtime.rollout;
  boundary.projectMemoryCandidates = new ProjectMemoryCandidatePipeline({ cwd, projectMemory: boundary.projectMemory, rollout: runtime.rollout });
  if (boundary.provenance) boundary.provenance.projectMemory = boundary.projectMemory;
  return { boundary, rollout: runtime.rollout, scorecard: runtime.scorecard, selection: runtime.selection, readiness: runtime.readiness, vaultReady: runtime.adapter.enabled };
}

function createPiIntegrationBoundary(config = {}) {
  const storage = config.storage || new MemoryJsonStorage();
  const sink = config.sink || new NullSink();
  const enabled = config.enabled !== false;
  // Adapters that freeze a configuration identity must hash the same values the
  // runtime resolves, so a declared project-memory posture is applied here too
  // instead of recording an inherited shell export.
  const resolvedEnv = applyProjectMemoryPosture(config.env || process.env).env;
  const trace = new TraceAdapter({ enabled: enabled && config.trace?.enabled !== false, storage, sink, ...(config.trace || {}) });
  const branching = new BranchingAdapter({ enabled: enabled && config.branching?.enabled !== false, storage, sink, ...(config.branching || {}) });
  const boundary = {
    storage,
    sink,
    trace,
    memory: new CognitiveMemoryAdapter({ enabled: enabled && config.memory?.enabled !== false, storage, sink, ...(config.memory || {}) }),
    stateInventory: new StateInventoryAdapter({ enabled: enabled && config.stateInventory?.enabled !== false, ...(config.stateInventory || {}) }),
    memoryState: new MemoryStateAdapter({ enabled: enabled && config.memoryState?.enabled !== false, ...(config.memoryState || {}) }),
    memorySafety: new MemoryContentSafetyAdapter({ enabled: enabled && config.memorySafety?.enabled !== false, ...(config.memorySafety || {}) }),
    sessionSearch: new SessionSearchAdapter({ enabled: enabled && config.sessionSearch?.enabled !== false, cwd: config.sessionSearch?.cwd || config.branching?.cwd || process.cwd(), ...(config.sessionSearch || {}) }),
    memoryMaintenance: new MemoryMaintenanceAdapter({ enabled: enabled && config.memoryMaintenance?.enabled !== false, cwd: config.memoryMaintenance?.cwd || config.branching?.cwd || process.cwd(), ...(config.memoryMaintenance || {}) }),
    retention: new RetentionAdapter({ enabled: enabled && config.retention?.enabled !== false, ...(config.retention || {}) }),
    statePermissions: new StatePermissionsAdapter({ enabled: enabled && config.statePermissions?.enabled !== false, ...(config.statePermissions || {}) }),
    projectMemory: new ProjectMemoryAdapter({ enabled: enabled && config.projectMemory?.enabled === true, ...(config.projectMemory || {}) }),
    executionOutcomes: new ExecutionOutcomeAdapter({ enabled: enabled && config.executionOutcomes?.enabled !== false, storage, prefix: "execution-outcomes", ...(config.executionOutcomes || {}) }),
    hermes: new HermesAdvisoryAdapter({ enabled: enabled && config.hermes?.enabled !== false, storage, prefix: "hermes-advisory", cwd: config.hermes?.cwd || config.branching?.cwd || process.cwd(), trace, ...(config.hermes || {}) }),
    goalController: new GoalControllerAdapter({ enabled: enabled && config.goalController?.enabled !== false, ...(config.goalController || {}) }),
    goalEvidence: new GoalEvidenceAdapter({ enabled: enabled && config.goalEvidence?.enabled !== false, cwd: config.goalEvidence?.cwd || process.cwd(), ...(config.goalEvidence || {}) }),
    learning: new LearningLoopAdapter({ enabled: enabled && config.learning?.enabled !== false, cwd: config.learning?.cwd || process.cwd(), ...(config.learning || {}) }),
    context: new LayeredContextAdapter({ enabled: enabled && config.context?.enabled !== false, storage, sink, ...(config.context || {}) }),
    anchoring: new FileAnchoringAdapter({ enabled: enabled && config.anchoring?.enabled !== false, sink, ...(config.anchoring || {}) }),
    verification: new VerificationAdapter({ enabled: enabled && config.verification?.enabled !== false, storage, sink, ...(config.verification || {}) }),
    visualVerification: new VisualVerificationAdapter({ enabled: enabled && config.visualVerification?.enabled !== false, cwd: config.visualVerification?.cwd || config.branching?.cwd || process.cwd(), ...(config.visualVerification || {}) }),
    rolloutCenter: new RolloutCenterAdapter({ enabled: enabled && config.rolloutCenter?.enabled !== false, cwd: config.rolloutCenter?.cwd || config.branching?.cwd || process.cwd(), ...(config.rolloutCenter || {}) }),
    entropy: new EntropyAdapter({ enabled: enabled && config.entropy?.enabled !== false, storage, sink, ...(config.entropy || {}) }),
    reasoning: new ReasoningRuntimeAdapter({ enabled: enabled && config.reasoning?.enabled !== false, storage, sink, ...(config.reasoning || {}) }),
    orchestration: new OrchestrationAdapter({ enabled: enabled && config.orchestration?.enabled !== false, storage, sink, ...(config.orchestration || {}) }),
    branching,
    subagents: new SubagentAdapter({ enabled: enabled && config.subagents?.enabled !== false, sink, trace, branchManager: branching.manager, ...(config.subagents || {}) }),
    typesafe: new SystemOneAdapter({ enabled: enabled && config.typesafe?.enabled !== false, sink, ...(config.typesafe || {}) }),
    skills: null,
    skillIntake: null,
    provenance: null,
    compounding: null,
    topologies: null,
  };
  boundary.skills = new SkillSynthesisAdapter({ enabled: enabled && config.skills?.enabled !== false, storage, sink, trace, memory: boundary.memory, hermes: boundary.hermes, cwd: config.skills?.cwd || config.skills?.options?.cwd || config.branching?.cwd || process.cwd(), ...(config.skills || {}) });
  if (enabled && config.pilots?.enabled === true) {
    const cwd = config.pilots.cwd || process.cwd();
    boundary.skillPilot = new AdvisorySkillPilot({ cwd, skills: boundary.skills, env: resolvedEnv });
    boundary.entropy.review = new EntropyReview({ cwd });
  }
  boundary.skillIntake = new SkillIntakeAdapter({ enabled: enabled && config.skillIntake?.enabled !== false, cwd: config.skillIntake?.cwd || config.skills?.options?.cwd || config.branching?.cwd || process.cwd(), skills: boundary.skills, ...(config.skillIntake || {}) });
  boundary.provenance = new ProvenanceGraphAdapter({ enabled: enabled && config.provenance?.enabled !== false, cwd: config.provenance?.cwd || config.branching?.cwd || process.cwd(), projectMemory: boundary.projectMemory, executionOutcomes: boundary.executionOutcomes, learning: boundary.learning, skills: boundary.skills, evidence: boundary.goalEvidence, ...(config.provenance || {}) });
  const compoundingSkills = boundary.skillPilot ? { compoundingRecords(options) { const records = boundary.skills.compoundingRecords(options); return { ...records, machineVerificationPilot: boundary.skillPilot.report() }; } } : boundary.skills;
  boundary.compounding = new CompoundingEffectivenessAdapter({ enabled: enabled && config.compounding?.enabled !== false, cwd: config.compounding?.cwd || config.branching?.cwd || process.cwd(), skills: compoundingSkills, learning: boundary.learning, executionOutcomes: boundary.executionOutcomes, maintenance: boundary.memoryMaintenance, provenance: boundary.provenance, storage, ...(config.compounding || {}) });
  const topologyOptions = config.topologies?.options || {};
  const handlerRegistry = { ...(topologyOptions.handlerRegistry || {}), ...(boundary.skillIntake.enabled ? boundary.skillIntake.handlerRegistry() : {}) };
  const subagentExecutor = topologyOptions.subagentExecutor || new SubagentTopologyExecutor({ service: boundary.subagents.service, cwd: topologyOptions.cwd || config.subagents?.cwd, trace });
  boundary.topologies = new MultiAgentTopologyAdapter({ enabled: enabled && config.topologies?.enabled !== false, storage, sink, trace, memory: boundary.memory, ...(config.topologies || {}), options: { ...topologyOptions, handlerRegistry, subagentExecutor } });
  boundary.tasks = new SubagentTasksAdapter({ enabled: enabled && config.tasks?.enabled === true, cwd: config.tasks?.cwd || config.subagents?.cwd || process.cwd(), storage, topologies: boundary.topologies, subagents: boundary.subagents.service, evidenceStore: new MemoryEvidenceStore(storage), ...(config.tasks || {}) });
  return boundary;
}

module.exports = {
  AdvisorySkillPilot,
  EntropyReview,
  SystemOneAdapter,
  MemoryJsonStorage,
  FileIntegrationStorage,
  NullSink,
  RecordingSink,
  CognitiveMemoryAdapter,
  StateInventoryAdapter,
  PrivacyGuardScanAdapter,
  MemoryStateAdapter,
  MemoryContentSafetyAdapter,
  SessionSearchAdapter,
  RetentionAdapter,
  StatePermissionsAdapter,
  SessionStorageAttributionAdapter,
  ProjectMemoryAdapter,
  ProjectMemoryCaptureAdapter,
  LayeredContextAdapter,
  FileAnchoringAdapter,
  VerificationAdapter,
  VisualVerificationAdapter,
  RolloutCenterAdapter,
  EntropyAdapter,
  ReasoningRuntimeAdapter,
  OrchestrationAdapter,
  BranchingAdapter,
  SubagentAdapter,
  SubagentTasksAdapter,
  SpecialistToolsAdapter,
  clearSpecialistRuntimeCache,
  MultiAgentTopologyAdapter,
  SkillSynthesisAdapter,
  SkillIntakeAdapter,
  HermesAdvisoryAdapter,
  MemoryMaintenanceAdapter,
  ProvenanceGraphAdapter,
  CompoundingEffectivenessAdapter,
  GoalControllerAdapter,
  GoalEvidenceAdapter,
  LearningLoopAdapter,
  ExecutionOutcomeAdapter,
  TraceAdapter,
  MemoryVerificationCache,
  MemoryEvidenceStore,
  MemoryVerificationMetrics,
  EntropyPersistenceAdapter,
  MemoryBranchStore,
  roleResultContractLimits,
  createPiIntegrationBoundary,
  configureProjectMemoryServices,
  projectMemoryRuntimeConfig,
  appendProjectMemoryDiagnostic,
  captureAttemptSummary,
  resolveDiagnosticReview,
  readDiagnosticReviewRequests,
};
