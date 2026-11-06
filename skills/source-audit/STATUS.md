# Source audit status (as packaged)

- The 18 upstream repository landing pages and high-level catalogs were reviewed as described in `../research/repository-review.md`.
- Selected concrete upstream `SKILL.md` pages were inspected; their notes are in `../research/selected-upstream-skills.md`.
- **Full Git-tree inventory of each source SKILL.md has not been run in this environment** because direct `git clone`/GitHub blob access failed. This directory intentionally contains no fabricated per-file scores.
- Run `python tools/audit_repositories.py --out source-audit` from the package root on an environment with outbound HTTPS access to GitHub, or supply local clones via `--offline-repo`.
- Success condition: `source-inventory.json` has `audit_is_exhaustive: true`, with all 18 repositories COMPLETE and no per-file read errors. Separately behavior-test source skills to evaluate real-world performance.
