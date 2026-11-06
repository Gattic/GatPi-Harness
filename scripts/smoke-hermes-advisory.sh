#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--run" ]]; then
  exec pi --no-session --no-extensions -e extensions/hermes-advisory/index.ts '/hermes-status'
fi
cat <<'CHECKLIST'
Hermes advisory manual smoke

1. Run /hermes-status. Confirm providerReady, advisoryDraftAllowed,
   canonicalPromotionAllowed, and automaticMutationAllowed are separate.
2. Run /hermes-doctor --curation. Confirm both bounded probes pass and no note,
   conversation, cache, or skill is created.
3. Run /hermes-plan <bounded public task>. Confirm strict typed JSON and a receipt.
4. Run /obsidian-hermes <topic>. Confirm dry-run candidates are unverified and no
   Obsidian memory note is written.
5. Run /skill-draft-hermes <eligible-skill-id>. Confirm the package exists only
   under .pi/hermes-skill-candidates and is not loaded.
6. Run /skill-candidate-promote <candidate-id> without flags. Confirm preview.
   Promotion requires the explicit --apply --yes command.
7. Run /hermes-scorecard. Confirm E3 and C5 remain NULL-RESULT unless qualified
   exact-version field evidence exists, and automatic mutation remains false.
CHECKLIST
