# Releasing

## Versioning policy

This project follows [Semantic Versioning 2.0.0](https://semver.org/). Treat the
specification as the governing guideline; the rules below record how it is
applied here and do not override it.

- Git tags use stable Semantic Versioning with a `v` prefix, such as `v0.0.1`.
- Repository metadata uses the same version without the `v` prefix.
- Until `1.0.0`, treat `0.x.0` releases as the place for contract or behavior
  changes that may require consumer updates. SemVer treats major version zero as
  initial development whose public API should not be considered stable, so a
  breaking change does not force a major bump while the version stays below
  `1.0.0`.
- `x.y.z` tags are immutable release identifiers. Docker aliases such as `x.y`,
  `x`, and `latest` move forward with each stable release.

### Reaching `1.0.0`

Publishing `1.0.0` declares the public API stable and, under SemVer, commits
every later backwards-incompatible change to a major bump. Do not bump to
`1.0.0` merely because a release removes a legacy surface. Two things should be
true first:

- `public/openapi.json` matches runtime behavior. The "Compatibility and known
  gaps" section of [api-consumer-guide.md](api-consumer-guide.md) currently
  records places where they diverge.
- A written deprecation policy exists, so the major-version promise has
  something behind it. There is none today, and releases through `0.5.0` have
  removed surfaces that were documented as having no announced sunset.

## Files that must stay aligned

- `package.json`
- `package-lock.json`
- `public/openapi.json`
- `docs/api-consumer-guide.md`
- `CHANGELOG.md`

Run `npm run release:validate` before opening or merging a release PR.

## Release workflow

1. Update repository metadata to the next version.
2. Move the release notes from `## [Unreleased]` into a new dated section in
   `CHANGELOG.md`.
3. Run verification locally:

   ```bash
   npm run release:validate
   npm run db:validate
   npm run api:validate
   npm run lint
   npm run build
   npm run test:postgresql
   ```

4. Open a pull request into `main` with the version and changelog updates.
5. After the PR is merged and `main` CI passes, create and push an annotated
   tag for the merged commit:

   ```bash
   git checkout main
   git pull --ff-only
   git tag -a v0.0.1 -m "Release v0.0.1"
   git push origin v0.0.1
   ```

6. The tag-triggered publish workflow builds and pushes these Docker tags to
   Docker Hub for stable releases:

   - `castab/resend-service:x.y.z`
   - `castab/resend-service:x.y`
   - `castab/resend-service:x`
   - `castab/resend-service:latest`

7. After Docker publication succeeds, create a GitHub Release from the matching
   `CHANGELOG.md` section and include the published image digest.

## Required repository settings

- Protect `main` with required pull request reviews and required status checks.
- Protect `v*` tags so only release maintainers can create or update them.
- Set these GitHub Actions secrets before publishing:
  - `DOCKERHUB_USERNAME`
  - `DOCKERHUB_TOKEN`

The release image runs the bundled Node 22 ESM Express server from `dist/server.js`; verify both the non-default `PORT` smoke test and Prisma migration command before publishing.
