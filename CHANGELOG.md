# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project uses Semantic
Versioning.

## [Unreleased]

## [0.3.0] - 2026-07-28

### Added

- Added the forward conversation API V2 with a dedicated bearer credential,
  required structured From and Reply-To identities, and database-managed,
  role-specific exact-address authorization.
- Added direct operator control of V2 identity authorization through the
  `email_address_allowlist_entries` table; no allowlist management API is
  exposed.

### Changed

- Designated V1 as the frozen, environment-driven legacy API with no planned
  sunset, while preserving its existing `RESEND_FROM` and `RESEND_REPLY_TO`
  behavior.
- Added one-way V1-to-V2 conversation promotion, fixed per-conversation Reply-To
  bases with existing routing tokens, and V1 write rejection after promotion.
- Defined allowlist revocation to block new V2 intent without cancelling
  already-persisted outbox work.

## [0.2.0] - 2026-07-21

### Changed

- Migrated the application runtime from Next.js to Express 5 while preserving
  the public API contract and local Swagger UI.

## [0.1.0] - 2026-07-21

### Added

- Added outbound delivery-state projection from Resend lifecycle webhooks while
  preserving provider send acceptance as the existing message `state`.
- Added optional per-message Reply-To display names for conversation sends and
  outbox sends.

## [0.0.1] - 2026-07-21

### Added

- Initial public release process with SemVer metadata, changelog tracking, and
  tag-triggered Docker Hub publication guidance.
