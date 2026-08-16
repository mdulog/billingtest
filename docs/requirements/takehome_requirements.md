# Take-Home Exercise: Multi-Tenant Usage & Billing Schema

**Time expectation:** 2–4 hours. This is intentionally scoped to be finishable in an evening. We're more interested in your reasoning and priorities than a fully polished system.

## Context

Intelitics is a multi-tenant SaaS platform. Many customers have isolated resources, but they also share some underlying infrastructure. This exercise asks you to design a small piece of a system that tracks per-customer usage events and rolls them up into billing summaries.

## What is Provided

A file, `usage_events.json`, containing raw usage events from several different customers. The data is intentionally denormalized and a little messy.

```json
{
  "customer_id": "cust_042",
  "event_type": "api_call",
  "endpoint": "/v1/reports/generate",
  "user_email": "jane@acmeco.com",
  "plan": "pro",
  "occurred_at": "2026-07-14T18:32:11Z",
  "metadata": { "duration_ms": 214, "status": "success" }
}
```

A few notes about this dataset:

- Multiple customers' events are interleaved in the same file.
- Some fields (like `plan`) are repeated on every event for a customer, rather than stored once.
- A few events are duplicates or have missing/malformed fields.
- Not every customer has the same volume of activity. Some are heavy, some barely show up.

## What You Should Build

A small **Node.js/TypeScript** service, backed by **Postgres**, that:

1. **Designs a normalized schema** for this data. Think about what belongs in its own table, what should be a foreign key vs. denormalized for read performance, and how you'd isolate one customer's data from another's at the database level.
2. **Ingests** `usage_events.json` into that schema, handling duplicate/malformed records reasonably (be ready to explain it, but there's no hard rule for "reasonable").
3. **Exposes HTTP endpoint(s)** that answer basic billing-relevant questions. This is intentionally underspecified to allow your design to rely on how you architect and store the underlying data. Some questions that should be answerable:
   - Usage summary (event counts, total `duration_ms`, etc.) per customer in a given date range
   - Top customers by usage over a date range
   - Detailed usage per endpoint for a customer in a given date range
4. **Testing** Includes basic tests for the parts of the logic you think matter most.

We're intentionally not prescribing an ORM or exact schema. Use what you'd reach for on the job. If you use migrations, include them; we're curious how you evolve a schema, not just what it looks like on day one.

## Write-Up

A short doc alongside your code answering:

1. **Schema design:** Walk us through your table design. What tradeoffs did you consider (normalization vs. query performance, one big table vs. several)?
2. **Multi-tenancy:** How does your schema keep one customer's data isolated from another's? What would you change if this needed to scale to hundreds of customers with wildly different data volumes?
3. **Operating it:** What would you want to log or measure to know this pipeline is healthy in production? What would page someone at 2am?
4. **What you'd do next:** If you had another day, what's the next thing you'd add or fix, and why?

## What We're Looking For

We're less interested in a "finished product" than in how you think:

- Whether your schema reflects real Postgres/relational modeling instincts
- How you reason about multi-tenant data isolation when it isn't handed to you as a given
- How clearly you can explain a design decision and its tradeoffs
- Whether your instincts extend past the code itself into how you'd operate this
- How you work, including your approach to problem-solving, prioritization, and handling ambiguity
  - Recommended to use git and commit as if you were working in a real team environment rather than a single upload at the end

There's no single right answer here. We'd rather see good judgment and honest tradeoffs than a system that tries to handle everything.

## Submission

Please share a link to a git repo (public or with access granted or as a `.zip` including the git history), along with your write-up. Happy to answer clarifying questions if anything here is ambiguous. Treat ambiguity the way you would a real, underspecified ticket.
