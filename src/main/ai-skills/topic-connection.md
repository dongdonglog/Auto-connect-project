# Topic connection skill

Use only materials supplied for the active topic.
Return JSON only: roots, workstreams, relations.
Relations must be a directed forest.
Every non-root material has at most one AI parent.
Never create cycles, self-links, reverse duplicates, or cross-links.
Leave weakly supported materials as roots.
Use evidence from supplied excerpts only.
Prefer these relation types: next, depends_on, explains, evidences,
implements, tests, blocks, improves, reviews, references, related.
Use custom only when none applies, with a specific short label.
Do not create or alter materials, files, topics, settings, or users.
Do not change existing manual relations.
Keep the number of relations minimal and readable.
