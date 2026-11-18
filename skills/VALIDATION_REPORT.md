# Skill Foundry 3.0 validation — November 18, 2026

> **pi-harness note:** the report below is reproduced as supplied and describes the 131-skill ZIP. This repository copy holds 139 skills (131 supplied + 8 local) and 1075 designed cases; here `python tools/validate_skills.py` reports `PASS: 139 skills` and the offline suite runs 28 tests (the 23 supplied plus five local SEO-helper regressions in `tests/test_helpers.py`). `RELEASE_FILES.json` is not kept: `python tools/verify_release.py` passed on the extracted ZIP before adaptation and does not apply to this adapted tree. See `docs/skill-bundle-migration.md` in the harness repository.

## Verified in local environment

- **PASS**: 131 generated `SKILL.md` and all JSON evaluation schemas pass `python tools/validate_skills.py`.
- **PASS**: all **23** offline unit and integration tests pass, including seven new motion/SVG/kinematics tests.
- **PASS**: 121 prior catalog records preserved; **23** deliberately modified; **98** unchanged.
- **PASS**: **10** new original specialist skills created and supplied with 10 supporting references and 3 runnable standard-library scripts.
- **PASS**: JSON evaluations include **1019 designed, unexecuted** test cases. This is a dataset count, not an agent behavior score.
- **PASS**: release file hashes and archive ZIP integrity checked before distribution.

## NOT TESTED

- End-to-end agent execution of the 1019 evaluation prompts.
- Actual Blender renders, Lottie/dotLottie playback, interactive browser scenes and WebGL effects.
- True physical collision detection: included mechanical validator only tests ideal gearing and lead-screw sample constraints.
- Source tree cloning of the three upstream URLs: GitHub DNS was unavailable. Two source `SKILL.md` files and both gist documents were examined via public GitHub web view; full nested kit/scripts were not downloaded or audited.

## Security and provenance

Sources were used for independently written guidance. The package does not import or execute untrusted upstream code. SHA-256 manifests detect changes relative to the packaged manifest but are **not** cryptographic publisher identity signatures.

## Verification commands

```bash
python tools/validate_skills.py
python -m unittest discover -s tests -v
python tools/verify_release.py
```
