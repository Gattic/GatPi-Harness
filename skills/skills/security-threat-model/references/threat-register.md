# Threat register schema and severity rules

For each item document: **ID**, asset, data classification, entry point, trust boundary, attacker capability, causal sequence, preconditions, consequence, current controls, likelihood evidence, impact, detection, mitigation, owner, due date, verification, status and accepted residual risk.

## Priority rubric

- **Critical:** likely path to irreversible compromise or sensitive data at scale; stop shipping until mitigated/accepted by authorized accountable owner.
- **High:** substantial impact under credible preconditions; remediation prior to public deployment is default.
- **Medium:** constrained exploitability/impact with compensating controls; schedule and monitor.
- **Low:** limited harm or unlikely preconditions; document owner and revisit triggers.

Do not reduce severity solely because a tool cannot reproduce a finding in a different test environment. Conversely, a generic tool warning is not proof of exploitability. Reconcile source, preconditions, reachability and operational context.

### Example (fabricated, illustrative only)

| ID | Boundary | Threat | Control | Validation |
|---|---|---|---|---|
| TM-01 | customer browser → multi-tenant API | tenant ID provided by browser is trusted for resource lookup | server-side tenant lookup from authorized principal and ownership query | negative tests with two real isolated test tenants |
| TM-02 | build CI → production secrets | untrusted PR job can read deployment token | split contexts, scoped ephemeral credentials, protected environment | submit a forked PR and confirm secret is not present |

This template is for **defensive** authorized design review. Do not add production secrets to the risk register.
