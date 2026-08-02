# Topic connection skill

Use only materials supplied for the active topic.
Return JSON only with relations and optional workstreams. No markdown or prose.
Relations must be a directed forest when dependencies are clear.
Every target material has at most one AI parent.
Never create cycles, self-links, reverse duplicates, or cross-links.
Omit weakly supported materials rather than forcing a connection or a workstream.
Use evidence from supplied excerpts only.
Prefer these relation types: next, depends_on, explains, evidences,
implements, tests, blocks, improves, reviews, references, related.
Use custom only when none applies, with a specific short label.
Do not create or alter materials, files, topics, settings, or users.
Do not change existing manual relations.
Keep the number of relations minimal and readable. Every relation must include a
specific evidence string, a supported relationType, and a confidence from 0 to 1.
