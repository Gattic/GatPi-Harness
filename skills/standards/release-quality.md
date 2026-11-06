# Release and artifact quality gates

A skill's outcome is accepted only against its declared deliverable, not the existence of pleasant-looking prose.

| Work type | Required evidence examples | Critical failure examples |
|---|---|---|
| Software | exact build/test commands, output and failing-regression tests; no secrets in logs | unexecuted tests claimed passed, broken API contract, dangerous default |
| Web and SEO | crawl/indexation evidence, real browser/a11y performance results, Search Console where available | guessed rankings, inaccessible controls, wrong canonical/redirects |
| Image and design | brief match, full-resolution artifact, source/provenance/rights, spot inspection | fabricated branding, wrong SKU/product, illegible type, unlicensed source |
| Video and audio | timeline continuity, dimensions/frame rate, mix loudness, caption accuracy, consent | missing final render, audible artifacts, unauthorized voice identity |
| 3D and motion capture | units, transforms, normals/topology, export import, preview and reference calibration | invalid scale, unusable joints, missing source assets, non-manifold mesh when prohibited |
| Marketing | attributable metrics, falsifiable claims, channel/segment fit, experiment guardrails | deceptive claims, invented spend/ROI, uncontrolled test contamination |
| Security | threat context, exact path/line and exploit preconditions, scoped validation, safe fixes | unapproved active testing, unsupported severity, hidden high-risk access |
| Research | reproducible source trail, claim confidence, contradictory evidence, publication/event dates | citations that do not support claims, fabricated studies, stale facts as current |
| Delivery | owner, dependency, acceptance criterion, test record, correct status | task marked done merely because assigned or drafted |

## Mandatory reporting pattern

For each acceptance condition record: expected behavior, observed behavior, verification method, status (`PASS` / `FAIL` / `NOT TESTED` / `BLOCKED`), evidence reference and unresolved risk. A pass without an observed check is invalid. Explain trade-offs and whether an assumption could change the recommendation. Make publishing/deployment/money-spending/permission-altering steps explicit and authorized.

Creative outputs need human aesthetic review **and** format checks. A legal right to a software repository does not automatically grant rights to model weights, training references, voice identities, stock assets or branded imagery.
