# Technical SEO audit finding schema

For each finding record:

```json
{
  "issue_id": "SEO-001",
  "page_template": "article",
  "sample_url": "https://example.invalid/article",
  "observed_evidence": "HTTP 200 page with canonical pointing to unrelated URL",
  "data_source": "rendered HTML + crawler output; Search Console not available",
  "affected_urls_count": 1,
  "mechanism": "Unintended canonical prevents target page from being a distinct index candidate",
  "business_impact": "High-value article not reliably discoverable",
  "confidence": "high",
  "severity": "high",
  "recommended_fix": "Canonicalize to self after verifying article uniqueness",
  "owner": "web platform team",
  "validation": "Re-crawl, check rel=canonical, URL Inspection where authorized",
  "status": "open"
}
```

Replace example values with real evidence. **Do not infer indexing or ranking from a crawler alone.** Compare against Search Console, server logs, published sitemaps, rendered DOM and actual canonical targets where access exists.

Suggested prioritization inputs: likely index/crawl impact; affected pages and conversions; user-visible harm; reproduction confidence; engineering effort; rollout risks; ability to validate. A 404 intentionally returning for retired content is not automatically an SEO defect.
