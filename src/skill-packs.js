"use strict";

/** First-party curated procedural skills for bootstrapping retrieval before a repo has organic captures. */

function curatedPiSkillPack() {
  return {
    schemaVersion: 2,
    providerId: "pi-curated-core",
    evidenceState: { sourceTrust: "trusted", schema: "valid", sandbox: "not-run", localVerification: "insufficient-data", field: "insufficient-data" },
    approvals: { advisoryRetrieval: "allowed", routing: "not-approved", publishing: "not-approved" },
    skills: [
      {
        skillId: "skill_curated_debug_verify",
        name: "Debug with verification evidence",
        description: "Investigate a failing behavior, patch the root cause, and collect targeted plus broad verification evidence before completion.",
        category: "debugging",
        status: "approved",
        triggerConditions: ["failing test", "bug", "regression", "command failed", "verification failed"],
        domainTags: ["debugging", "verification", "repair"],
        requiredTools: ["read", "bash", "edit"],
        workflowSteps: [
          { id: "inspect", kind: "research", description: "Inspect the failing output and the smallest relevant code path.", tools: ["read", "bash"] },
          { id: "patch", kind: "code", description: "Apply a minimal root-cause fix rather than masking symptoms.", tools: ["edit"] },
          { id: "verify", kind: "verify", description: "Run targeted verification first, then a broader regression check when affordable.", tools: ["bash"] }
        ],
        validationStrategy: { kind: "verification-sequence", requiredEvidence: ["targeted test", "regression check"], commands: [] },
        confidenceScore: 0.86,
        governance: { approval: "approved", sandboxRequired: false, unsafe: false }
      },
      {
        skillId: "skill_curated_safe_refactor",
        name: "Safe behavior-preserving refactor",
        description: "Refactor code while preserving behavior through small semantic edits and regression verification.",
        category: "refactor",
        status: "approved",
        triggerConditions: ["refactor", "cleanup", "simplify", "extract helper"],
        domainTags: ["refactor", "semantic-edit", "verification"],
        requiredTools: ["read", "edit", "bash"],
        workflowSteps: [
          { id: "map", kind: "research", description: "Map public behavior, call sites, and tests before editing.", tools: ["read"] },
          { id: "change", kind: "refactor", description: "Make one cohesive structural change with minimal surface area.", tools: ["edit"] },
          { id: "regress", kind: "verify", description: "Run behavior-preserving regression checks and inspect diffs.", tools: ["bash", "read"] }
        ],
        validationStrategy: { kind: "regression", requiredEvidence: ["tests pass", "diff review"] },
        confidenceScore: 0.84,
        governance: { approval: "approved", sandboxRequired: false, unsafe: false }
      },
      {
        skillId: "skill_curated_planner_coder_verifier",
        name: "Planner coder verifier workflow",
        description: "Use planner, coder, and verifier roles with an explicit verification gate for implementation tasks.",
        category: "topology",
        status: "approved",
        triggerConditions: ["multi-step implementation", "planner coder verifier", "autonomous coding workflow"],
        domainTags: ["topology", "coordination", "verification"],
        requiredTools: ["read", "edit", "bash"],
        workflowSteps: [
          { id: "plan", role: "planner", kind: "plan", description: "Create a constrained plan with risks and success criteria." },
          { id: "code", role: "coder", kind: "execute", description: "Implement the plan with minimal changes." },
          { id: "verify", role: "verifier", kind: "verify", description: "Verify implementation and report evidence." }
        ],
        validationStrategy: { kind: "verification-gate", requiredEvidence: ["verifier result"] },
        confidenceScore: 0.88,
        governance: { approval: "approved", sandboxRequired: false, unsafe: false }
      },
      {
        skillId: "skill_curated_docs_examples",
        name: "Documentation and example validation",
        description: "Update docs/examples and validate they still describe runnable behavior.",
        category: "documentation",
        status: "approved",
        triggerConditions: ["docs", "readme", "examples", "documentation"],
        domainTags: ["docs", "examples", "verification"],
        requiredTools: ["read", "edit", "bash"],
        workflowSteps: [
          { id: "align", kind: "research", description: "Compare docs against current code behavior.", tools: ["read"] },
          { id: "write", kind: "documentation", description: "Update concise docs and runnable examples.", tools: ["edit"] },
          { id: "check", kind: "verify", description: "Run examples or source checks that prove docs are current.", tools: ["bash"] }
        ],
        validationStrategy: { kind: "docs-evidence", requiredEvidence: ["example output or source test"] },
        confidenceScore: 0.82,
        governance: { approval: "approved", sandboxRequired: false, unsafe: false }
      },
      {
        skillId: "skill_curated_failure_investigation",
        name: "Failure-pattern investigation",
        description: "Analyze repeated failures, identify anti-pattern signatures, and choose a mitigation before retrying.",
        category: "debugging",
        status: "approved",
        triggerConditions: ["repeated failure", "retry loop", "flaky", "blocked"],
        domainTags: ["failure-learning", "retry", "mitigation"],
        requiredTools: ["read", "bash"],
        workflowSteps: [
          { id: "collect", kind: "research", description: "Collect the latest failure evidence and previous retry signatures." },
          { id: "classify", kind: "analysis", description: "Classify whether this is tool misuse, insufficient context, invalid output, or verifier failure." },
          { id: "mitigate", kind: "strategy", description: "Apply the smallest mitigation and rerun only the relevant verification." }
        ],
        validationStrategy: { kind: "failure-mitigation", requiredEvidence: ["failure signature", "post-mitigation verification"] },
        confidenceScore: 0.8,
        governance: { approval: "approved", sandboxRequired: false, unsafe: false }
      }
    ]
  };
}

module.exports = { curatedPiSkillPack };
