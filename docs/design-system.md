# AI Implementation OS — visual system

Source: user-supplied AI Implementation OS Design System Board. This is a new brand, not the discarded Apple redesign or Nexus palette.

## Tokens

Inter 400/500/600/700. Iris `#584FE9`, pressed iris `#4338B8`, light iris `#EEEAFF`, subtle iris `#F7F5FF`. Cyan `#00A1B7`, light cyan `#DDF4F7`, subtle cyan `#F0FAFC`, dark cyan `#0E687A`. White surfaces, `#F8F9FB` canvas, ink `#1B1822`, graphite `#343A46`, slate `#687085`, muted `#969BA9`, border `#E5E7EC`, divider `#EDF0F4`.

Semantic success `#059B78`, amber `#C37A11`, danger `#DC454F`. Colors communicate state, not decoration. Iris represents intelligence and primary actions; cyan represents connected data. No decorative gradients.

Spacing uses 4/8/12/16/24/32/48. Controls 36–40px desktop; 44px mobile touch targets. Radii 8px controls, 12px grouped surfaces. Pill badges only for statuses. Tables have subtle horizontal separators and sticky headings.

Typography: page title 28/36 semibold; section 18/26 semibold; subsection14/20 semibold; body14/20; metadata12/16; tracked labels11/14. Keep large 40px type for onboarding only. Tabular numerals for progress and dates.

## Information architecture

Reference update (21 October 2026): the user’s AI Studio Implementation OS is the layout reference. Use a compact top navigation with brand, Catalog launcher, workspace context, search, settings and account. Do not reserve a permanent sidebar on portfolio screens. Catalog contains Command center, Implementations, Tasks, Documents, Integrations and Settings.

Command center: greeting and concise portfolio context → three prioritized delivery briefs → portfolio pulse and delivery radar → Attention engine and Workspace work → connected context resources. Implementation detail: identity → tabs → implementation pulse → chronological stages → next actions and their reasons → evidence. Meaningful panels have 12–16px radii; nested briefs use 10–12px. Controls retain 8px radii. The reference informs structure, not fabricated data or simulated functionality.

The shared visual layer is `apps/web/src/workspace-design.css`; existing component foundations remain in `styles.css`. Header/body typography is 30/16/14/12px with 10–11px metadata; compact chart labels may be smaller. Iris is softened to `#6256D9`, primary ink to `#20242F`, canvas to `#F8F9FC`, and border to `#E7E9F0` for the reference-led workspace. No decorative gradients or oversized hero panels.

The delivery brief is rule-based, sourced from existing health signals. Radar plots stored task completion against computed health; unassessed records are explicitly excluded. Workspace work is not labeled “My work” because personal assignment filtering is not implemented. AI generation and connected integrations must never be implied when unavailable.

Document Studio: a compact registry for implementation BRDs, solution and integration specifications, UAT plans/results, charters, enablement, cutover and RAID logs. Use the user's S2P BRD format as the baseline, with explicit open-item placeholders instead of invented scope. Editing, preview, Markdown import/export, review status, grounded-source notes and immutable revision comparison stay beside the authored document. AI generation is opt-in and discloses the configured provider and data fields before use; without a server-side provider, the product offers editable templates and clearly says AI is not connected.

## Interaction contract

All controls have keyboard focus, hover, disabled and loading states. 160ms transitions, reduced-motion support. Forms use visible labels, field errors and full-page layout for new implementations. Dense desktop tables become readable cards or horizontally scrollable data regions on mobile. Navigation collapses without hiding the current context. Demo mode is visibly labeled and uses a separate local dataset. Unknown AI values display “Not assessed,” not invented scores.

## Components

Layered geometric brand icon (code-native SVG), Lucide outline icons at 16–18px, compact primary/secondary buttons, semantic dot badges, accessible stage track, evidence drawer, actionable task list, quiet activity stream, progress bar with text equivalent, empty/error/loading states. Implementation health is explained beside the score; an unconfigured AI provider is explicitly described.
