# Implementation Intelligence Library

This local-first foundation lives in **Workspace settings → Implementation intelligence**. It is separate from Nexus production and from implementation-specific documents.

## Working now

- Workspace owners and admins can create playbooks with stages, entry/exit criteria, target durations, approval-gate flags, tasks, and milestones.
- The overview shows published knowledge coverage across playbooks, BRD/UAT templates, standards, knowledge sources, and AI instructions. This is a presence check, not an AI quality score.
- A playbook has an editable draft and append-only published versions. Each new implementation can select a published playbook. Project creation is one database transaction and copies that exact version into `implementations.playbook_snapshot` while creating stages, tasks, and milestones.
- Owners and admins can store and publish templates, organization documents, standards, AI instructions, and knowledge sources. Each item has a stated authority level and immutable publication history. Bulk import accepts up to 25 files per batch and creates private editable drafts with per-file results and retry. Single-item library import, implementation documents, and meeting transcripts use the same file reader.
- Supported imports: text/Markdown/VTT, CSV, PDF, DOCX, and XLSX. Files are limited to 10 MB each. Only extracted text is saved; the original binary, spreadsheet formulas, and document layout are not retained. A scanned PDF needs OCR before import, and legacy DOC/XLS files must be converted to DOCX/XLSX. The UI checks duplicates by title within each library destination.
- Workspace membership, PostgreSQL row-level security, audit records, and tenant-scoped foreign keys protect the library. Viewers cannot edit. Projects in another workspace cannot use a playbook by guessing its ID.
- Published versions remain available after their editable drafts change; an existing project does not silently inherit later revisions.
- The implementation view identifies its launch playbook version, and a selected stage shows its entry/exit criteria and approval requirement beside its tasks.

## Deliberate boundaries

- Library and project document text is **not** sent to an AI provider on upload or publication. In an implementation's Plan tab, an authorized manager may explicitly select up to six sources and opt in to sending bounded text snapshots to the configured provider for a cited plan proposal. The UI discloses the provider and outbound fields first. AI instructions and templates are not silently applied to generation.
- OCR, synchronized Google Drive/Slack sources, knowledge search/embeddings, conflict resolution, automatic playbook compilation, impact preview, collaborative review, and learning from completed implementations are not in this first local build.
- A blank manual implementation remains available so existing workflows are not broken. Select a published playbook to generate the initial plan.

## Evidence-to-Plan workflow

- The implementation Plan tab selects a source package, previews captured text, prepares either a conservative source-only outline or an AI-generated proposal, and retains immutable source snapshots with the proposal.
- AI suggestions require exact source quotations for every proposed stage, task, and milestone. Missing facts become open questions. Managers can edit drafts; human-authored additions require a review note.
- The change preview compares proposed items with current project records. Approval is a single tenant-checked database transaction that appends missing stages, tasks, milestones, and dependencies without overwriting existing records. Approval and proposal revisions appear in the audit trail. No external messages are sent.
- This remains local for review. The local server at `127.0.0.1:5185` can use the server-side NVIDIA key with `AI_E2E_LIVE=1`; a source package is sent only after the manager selects sources and explicitly consents. The default isolated test mode still uses a deterministic document stand-in and does not generate plans.

## NVIDIA model selection for local review

- `AI_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b` drafts storyboards and documents. It returned the structured BRD response in a live synthetic check in about 12 seconds.
- `AI_PLAN_MODEL=nvidia/nemotron-3-ultra-550b-a55b` produces cited plans. It passed the full structured-plan and citation checks. The plan API retries once if NVIDIA returns invalid structure or unverifiable citations; it never saves an invalid draft.
- Nemotron 3 Super returned `404` for the configured test key. Nemotron 3.5 Super VL and Lightning produced invalid technical stage/task keys in the plan probe, so they are not used for plans. These are observations from the current test account, not general model-quality claims.
- No key is included in frontend code or this document. Keep `AI_API_KEY` only in the local `.env` or a server-side secret store. The model/provider choice is visible in the app before generation. Human approval is still required before the proposal changes project records.
