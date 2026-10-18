# Changelog

This file summarizes completed product changes.

## 2026-10-18

- Replaced browser-generated CID admission with server-issued, room-bound
  participant identity proofs; refresh, reconnect and rejoin now preserve the
  authenticated participant state while stale or parallel sockets are fenced.
- Added durable explicit-exit recovery and documented the controlled single-replica
  rollout, legacy client-data cleanup and final iPhone-PWA verification gate.

## 2026-10-16

- Centered the mobile voting grid on shared fixed track axes while keeping
  incomplete final rows left-aligned within the centered grid. Chromium and
  WebKit geometry checks cover 320/375/393/430px, multiple decks, an optional
  special card, overflow and an unchanged desktop control.
- Refreshed the bilingual in-room guide, About copy and detailed DE/EN user
  guides against current decks, participant states, permissions, result rules,
  navigation and keyboard behavior. Removed obsolete timing, shortcut and room-
  lifetime claims and consolidated the corresponding style/index guidance.
- Improved the expanded room guide with compact result definitions, a full-
  width result section, calmer spacing and subtle horizontal separators.
- Reduced About and Imprint typography to a compact public-content scale without
  affecting the header, room interface or gameplay controls.
- Deployed the documentation and public-page polish through production commit
  `271f9f7`; the focused release smoke passed 18 Chromium cases plus the
  TypeScript build check.
- Polished room metadata, participant rows, lower actions and pending status.
- Centered the participant-action trigger's three dots independently of font
  metrics and sized its menu to its content, retaining the mobile width cap.
  Focused Chromium/WebKit checks cover DE/EN at 375/393/1280px, menu hit targets,
  keyboard navigation and focus return; trigger dimensions remain unchanged.
- Grouped the participant heading and list inside a transparent, subtly framed
  section, using a weaker border than the estimation topic. Row dimensions and
  vote-chip horizontal positions are preserved; menus remain unclipped.
  Focused Chromium/WebKit validation covers 1/2/5 participants, Light/Dark,
  375/393/1280px, spectator/inactive states and first/last actionable menus.
- Centered the room-share button independently of the metadata value line,
  retaining an 8px text clearance. Mobile room rows shrink from about 75px to
  57px for short values; desktop name and room values now align vertically.
  Chromium/WebKit checks cover short and long values at 320–1280px.
- Kept the host crown directly beside the participant name on mobile by
  preventing the name from growing into unused row space. Chromium and WebKit
  checks at 320/399/587/765/768/769/805/1280px confirmed a consistent 6.4px gap.
- Compacted the mobile room flow: before reveal, the hidden result row no
  longer reserves its 1.6rem minimum height, 1.3rem vertical padding and
  paragraph margins; after reveal, result and card-grid spacing now use
  explicit .75rem/.5rem mobile margins. Desktop spacing is unchanged.
- Fixed the iOS/mobile room layout by stacking room metadata with wrapping
  values, reclaiming participant-name space, stabilizing vote-chip width across
  emoji fonts, and returning the round action to document flow below the card
  grid so it cannot cover cards.
- Replaced person, host, spectator and inactive emoji/status glyphs with a
  shared set of minimalist monochrome icons across room information,
  participants, settings and host actions.
- Extended the shared monochrome icon set to room identifiers, topic edit and
  delete actions, and the participant removal action.
- Aligned the invite-link and topic-action button corners, plus the participant
  counter shape, with the restrained rounded geometry used by header controls.
- Replaced the remaining topic-editor save and cancel emojis with monochrome
  confirm and dismiss icons.
- Arranged the language and theme controls side by side at their compact,
  intrinsic control widths in the responsive mobile settings menu, while
  keeping both preferences exclusively in the header on desktop.
- Added restrained person, spectator and remove icons to the existing host
  participant-action menu without changing its actions or permissions.
- Fixed refresh, reconnect and same-tab rejoin resetting an existing
  participant's spectator status. The room now preserves participation state
  for the existing CID while new participant identities still estimate by
  default.
- Consolidated the interface into the former Clean appearance for all users,
  preserving its layout, typography and colors across Light, Dark and System.
  Removed the style selector, alternate styling, preference API and storage
  access. Historical release records below describe the features at that time.
- Validation: 107 affected browser tests passed, followed by a focused disabled-
  card hover regression test. Maven packaging and CI guards passed. Compared
  computed styles and geometry against checkpoint `pre-single-interface` across
  80 page/theme/viewport cases and 72 interaction cases with no differences
  (excluding the intentionally removed menu section).
- Completed the presentation-only room-interface repolish: compact responsive
  room metadata, clearer topic hierarchy, restrained participant rows and
  centered vote/status geometry across narrow and desktop layouts.
- Replaced duplicated participant action controls with one accessible overflow
  menu for eligible hosts. Mouse, touch and keyboard share one command path;
  host transfer, kick and spectator payload contracts remain unchanged.
- Focused ticket validation covers responsive geometry, Light/Dark/System,
  host/guest/spectator permissions, participant lifecycle, topic behavior,
  result states, voting, guide/exit visibility and mobile sticky clearance.
  Full release regression, merge, deployment and production smoke remain the
  separate release gate.

## 2026-10-15 — Post-redesign UX release

Production commit: `e84cecd`.

- Added a dedicated responsive estimation-topic panel with a clear bilingual
  heading, prominent wrapping title, blue clipboard icon and optional external
  ticket link while retaining host-only edit and delete controls.
- Fixed the empty-topic editor so Save and Cancel reliably close it by removing
  overlapping topic action handlers.
- Replaced the room's four informational FAQ cards with one accessible,
  bilingual guide that is collapsed by default and documents the existing room
  workflow and settings.
- Added a clearly visible individual Leave room action below the room guide.
  Hosts retain Close room for everyone in the menu, while guests see Leave room.
  Leaving follows the existing navigation, disconnect and host-transfer path.
- Added a compact semantic participant heading with a live count of the rows
  currently displayed. Host, spectator and disconnected rows remain counted;
  removed rows do not.
- Matched the participant heading typography to the discreet estimation-topic
  heading in both Dev and Clean interface styles.
- Completed and deployed post-redesign change requests CR-001 through CR-004.

### Validation

- GitHub CI and the complete GitHub Playwright workflow passed for `e84cecd`.
- Koyeb deployed the commit successfully to `https://planning-poker.at`.
- The production smoke covered participant lifecycle/count updates at 375 and
  1280 px plus two-user voting, reveal and reset in Dev and Clean styles
  (5 focused tests passed).

## 2026-10-14 — Major Redesign production release

Release baseline: `major-redesign-prod-v1` (`d42b022`), followed by invitation
hotfix `2518de2`.

### Added

- Introduced the shared responsive app header, centralized UI preferences and a
  responsive settings menu for language, theme and Dev/Clean interface style.
- Integrated the approved Planning Poker brand assets, favicons, PWA icons and
  manifest metadata.
- Added per-tab return-to-room navigation, a bilingual imprint page and
  privacy-conscious analytics limited to public content pages.

### Changed

- Refined the landing/join experience, room controls, settings hierarchy,
  responsive content visibility, shape language and public-page typography.
- Made the header full width while retaining centered game and content areas.
- Improved keyboard, screen-reader and reduced-motion behavior, including card
  selection state and result announcements.

### Fixed

- Prevented vote-selection resynchronization loops and false participant sleep
  transitions during overlapping WebSocket reconnects.
- Aligned the result display, voting grid and animated participant vote chips on
  their intended horizontal axes.
- Corrected the invitation heading so its apostrophe renders normally instead
  of exposing a Unicode escape sequence.

### Validation

- Completed the major-redesign regression with 195 distinct Playwright tests,
  Maven verification and project CI guards.
- The production release and invitation hotfix passed GitHub CI; the release
  smoke covered two participants, voting, reveal, reset, header, menu and room
  return navigation on `https://planning-poker.at`.

## 2026-10-11 — Production domain and repository migration

- Switched the canonical production domain, social metadata, structured data,
  sitemap, robots configuration and production checks to
  `https://planning-poker.at`.
- Retained the old origin during the controlled transition, then removed legacy
  Estimation Poker environment, storage, event and frontend compatibility after
  the cutover.
- Updated active repository references to `nox-vobiscum/planning-poker` and
  documented the production DNS/TLS architecture.
- Corrected public-page footer spacing so landing and About content remain fully
  visible.

## 2026-10-10 — Planning Poker product rebrand

Production checkpoint: `planning-poker-rebrand-prod-v1`.

- Renamed the product from Estimation Poker to Planning Poker across active UI,
  Java packages, application identifiers, browser storage and frontend events.
- Preserved room, voting, persistence and WebSocket behavior throughout the
  staged migration.
- Serialized WebSocket text writes per connection to prevent concurrent-send
  transport failures and strengthened role/readiness coverage in browser tests.
- Completed the rebrand verification with Maven, CI guards and 98 Playwright
  tests without failures or skips.
