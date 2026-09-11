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

- `public/openapi.json` and `public/asyncapi.json` match runtime behavior. The
  "Compatibility and known gaps" section of
  [api-consumer-guide.md](api-consumer-guide.md) currently records places where
  implementation and contract diverge.
- A written deprecation policy exists, so the major-version promise has
  something behind it. There is none today, and releases through `0.5.0` have
  removed surfaces that were documented as having no announced sunset.

## Files that must stay aligned

- `package.json`
- `package-lock.json`
- `public/openapi.json`
- `public/asyncapi.json`
- `docs/api-consumer-guide.md`
- `docs/api-agent-handoff.md`
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
   npm run test:unit
   npm run test:postgresql
   ```

   `npm run test:postgresql` runs against an application started without
   `ATTACHMENTS_ENABLED` and asserts that attachments stay invisible in that
   mode. Cover the enabled path too, against a second application process with
   the flag on and the Compose MinIO service running:

   ```bash
   docker compose up -d postgresql minio minio-init
   npm run test:postgresql:attachments
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

6. For a release candidate, follow [Release candidates](#release-candidates)
   below. The RC workflow publishes only the exact candidate Docker tag, such
   as `castab/resend-conversation-service:0.7.2-rc.2`, and creates a GitHub
   prerelease; it does not move `latest` or any stable aliases.

7. The stable tag-triggered publish workflow builds and pushes these Docker tags to
   Docker Hub for stable releases:

    - `castab/resend-conversation-service:x.y.z`
    - `castab/resend-conversation-service:x.y`
    - `castab/resend-conversation-service:x`
    - `castab/resend-conversation-service:latest`

8. After Docker publication succeeds, create a GitHub Release from the matching
   `CHANGELOG.md` section and include the published image digest.

## Release candidates

Two version strings are in play for a candidate, and they are deliberately not
the same. Getting them backwards is the most common way an RC fails, so the
rule is:

| Where | Value for the first candidate of 0.7.2 | Why |
| --- | --- | --- |
| Git tag | `v0.7.2-rc.1` | Identifies this exact candidate |
| `package.json` and every other aligned file | `0.7.2-rc.1` | `validate-release-version.mjs` requires an **exact** match with the tag, minus the `v` |
| `CHANGELOG.md` section heading | `## [0.7.2] - YYYY-MM-DD` | Names the **release**, not the candidate |

**The changelog heading does not carry the `-rc.N` suffix.** `publish-rc.yml`
strips the suffix and reads the section for the release the candidate is for,
so every candidate publishes that release's notes and there is one section per
release to maintain. Do not add a `## [0.7.2-rc.1]` section.

This is easy to get wrong because the failure is both late and expensive.
The notes lookup runs *after* the Docker image has been pushed, so a mismatch
leaves a published image with a red workflow and no GitHub release. It is also
easy to mis-test: the lookup behaves differently under `gawk` and `mawk`, and
the CI runner uses `mawk`. Check it the way the runner will:

```bash
docker run --rm -v "$PWD":/w -w /w ubuntu:24.04 bash -c '
  version=0.7.2-rc.1
  awk -v version="${version%%-rc.*}" '"'"'
    $0 ~ "^## \\[" version "\\]" { capture = 1; next }
    capture && /^## \[/ { exit }
    capture { print }
  '"'"' CHANGELOG.md | wc -c'
```

A nonzero byte count means the prerelease step will find its notes. On Git Bash
for Windows, prefix the command with `MSYS_NO_PATHCONV=1` and use `$(pwd -W)`
so the bind mount path is not rewritten.

Increment only the RC number for subsequent candidates, so `0.7.2-rc.2` keeps
pointing at the same `## [0.7.2]` section. When the release goes stable, drop
the suffix from the aligned files; the changelog heading is already correct and
does not change.

## Docker repository migration

`castab/resend-service` is the frozen legacy Docker Hub repository. Its tags
through `0.5.0` must be copied to `castab/resend-conversation-service` before
the next release. Do not delete or transfer the legacy repository: Docker
clients do not follow repository renames.

1. Create `castab/resend-conversation-service` in Docker Hub and ensure the
   existing `DOCKERHUB_TOKEN` can push to it.
2. Manually run the `Migrate Docker Hub Images` workflow with the confirmation
   value `COPY-HISTORICAL-IMAGES`. It copies every tag from the legacy repository
   without rebuilding and fails if any target manifest digest differs.
3. Confirm the copied tags in Docker Hub, then enable immutable exact-version
   tags in the new repository. Keep `x.y`, `x`, and `latest` mutable.
4. Delete `.github/workflows/migrate-docker-images.yml` in a follow-up pull
   request. Future releases publish only to
   `castab/resend-conversation-service`.

## Required repository settings

- Protect `main` with required pull request reviews and required status checks.
- Protect `v*` tags so only release maintainers can create or update them.
- Set these GitHub Actions secrets before publishing:
  - `DOCKERHUB_USERNAME`
  - `DOCKERHUB_TOKEN`

The release image runs the bundled Node 22 ESM Express server from `dist/server.js`; verify both the non-default `PORT` smoke test and Prisma migration command before publishing.
