<!--
Keep the section order below. Delete any section that does not apply.
Summary and Validation are required on every pull request; Database and
Operational notes are conditional.
-->

## Summary

<!--
One bullet per user-visible or contract-level change, in the imperative.
Describe what changed and why, not the file-by-file diff.
HTTP route or behavior changes must keep `public/openapi.json` aligned. Event
or broker behavior changes must keep `public/asyncapi.json` aligned. Contract
changes belong in `CHANGELOG.md` under `[Unreleased]`.
-->

-

## Database

<!--
Delete this section when the change adds no migration.
Cover the schema change, any back-fill, and what happens to rows that
already exist. Migrations are additive and are never edited after
deployment; see the Database rules in AGENTS.md.
-->

-

## Validation

<!--
List what you actually ran. The CI block is:

  npm run release:validate
  npm run db:validate
  npm run api:validate
  npm run lint
  npm run build
  npm run test:postgresql

Cite the integration test count. If your environment differed from CI in
any way that weakens a check, say so plainly rather than implying a clean
run on the supported stack.
-->

-

## Operational notes

<!--
Delete this section when the change needs nothing from an operator and
raises nothing for a reviewer to weigh.
Use it for required configuration, back-fill consequences, deliberate
trade-offs, and judgement calls that reviewers should confirm.
-->

-
