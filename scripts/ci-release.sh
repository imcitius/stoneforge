#!/usr/bin/env bash
# Stoneforge Desktop release steps (macOS, Apple Silicon, ad-hoc signed).
#
# Shared by .github/workflows/desktop-release.yml (one workflow step per
# subcommand) and scripts/ci-release-local.sh (runs the same subcommands in a
# clean clone on a developer Mac). Usage:
#
#   scripts/ci-release.sh resolve    # tag/version/prerelease/dry-run -> outputs
#   scripts/ci-release.sh preflight  # toolchain pins, clean tree, HEAD, no existing release
#   scripts/ci-release.sh build      # apps/desktop/README.md sequence + package:mac release mode
#   scripts/ci-release.sh artifacts  # zip, dmg, SHA256SUMS.txt + codesign/inventory/check-app smoke
#   scripts/ci-release.sh verify     # independent checks of the files that would be published
#   scripts/ci-release.sh notes      # release notes (fixed first-launch section)
#   scripts/ci-release.sh publish    # gh release create (CI_RELEASE_PRINT_ONLY=1 prints it instead)
#
# Inputs (environment): GITHUB_EVENT_NAME, GITHUB_REF_TYPE, GITHUB_REF_NAME,
# GITHUB_SHA, GITHUB_REPOSITORY, RELEASE_DRY_RUN_INPUT, RELEASE_VERSION_INPUT,
# GH_TOKEN (preflight/publish only). `resolve` writes TAG, VERSION, PRERELEASE
# and DRY_RUN to $GITHUB_OUTPUT and $GITHUB_ENV when those files are set; later
# steps read them from the environment. Every failure exits nonzero.
# TAG, VERSION, PRERELEASE and DRY_RUN come from the environment (written by `resolve`).
# shellcheck disable=SC2153
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DESKTOP="$ROOT/apps/desktop"
DIST=${CI_RELEASE_DIST:-$DESKTOP/dist}   # override only for tests of resolve/notes/publish
APP="$DIST/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app"
OUT="$DIST/release"
NOTES="$DIST/release-notes.md"
NODE_PIN=22.23.3   # apps/desktop/package.json "node" devDependency (bundled runtime)
PNPM_PIN=8.15.5    # root package.json packageManager
REPO=${GITHUB_REPOSITORY:-imcitius/stoneforge}

log() { printf '[ci-release] %s\n' "$*"; }
die() { printf '::error::ci-release: %s\n' "$*" >&2; exit 1; }
need() { [ -n "${!1:-}" ] || die "$1 is not set (run 'resolve' first)"; }

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"; fi
  if [ -n "${GITHUB_ENV:-}" ]; then printf '%s=%s\n' "$1" "$2" >>"$GITHUB_ENV"; fi
}

# Strict semver via the same parser package:mac uses (leading v stripped).
parse_version() {
  node --input-type=module -e '
    const { parseReleaseVersion } = await import(process.argv[1]);
    try { console.log(parseReleaseVersion(process.argv[2])); }
    catch (error) { console.error(error.message); process.exit(1); }
  ' "$DESKTOP/scripts/release.mjs" "$1"
}

artifact_names() {
  ZIP="Stoneforge-Desktop-$VERSION-arm64.zip"
  DMG="Stoneforge-Desktop-$VERSION-arm64.dmg"
  SUMS="SHA256SUMS.txt"
}

# JSON field of a packaged app's build-info.json.
build_info() {
  node -e 'const b = require(process.argv[1]); console.log(String(b[process.argv[2]]));' \
    "$1/Contents/Resources/app/build-info.json" "$2"
}

expected_sha() {
  if [ -n "${GITHUB_SHA:-}" ]; then printf '%s\n' "$GITHUB_SHA"; else git -C "$ROOT" rev-parse HEAD; fi
}

assert_clean_head() {
  local head expected status
  head=$(git -C "$ROOT" rev-parse HEAD)
  expected=$(expected_sha)
  [ "$head" = "$expected" ] || die "checkout HEAD $head != GITHUB_SHA $expected"
  status=$(git -C "$ROOT" status --porcelain --untracked-files=normal)
  [ -z "$status" ] || die "working tree is not clean:
$status"
  log "HEAD $head = expected commit; working tree clean"
}

# Fails when a release (published or draft) already exists for $TAG.
assert_no_release() {
  local err
  if err=$(gh release view "$TAG" --repo "$REPO" --json tagName 2>&1); then
    die "GitHub release $TAG already exists in $REPO; refusing to overwrite it (delete it deliberately or use a new tag)"
  fi
  case "$err" in
    *"release not found"*) log "no existing GitHub release for $TAG in $REPO" ;;
    *) die "could not determine whether release $TAG exists: $err" ;;
  esac
}

cmd_resolve() {
  local event=${GITHUB_EVENT_NAME:-workflow_dispatch} ref_type=${GITHUB_REF_TYPE:-} ref_name=${GITHUB_REF_NAME:-}
  local dry_run input_version=${RELEASE_VERSION_INPUT:-} raw tag version
  case "$event" in
    push)
      [ "$ref_type" = tag ] || die "push runs must be for a tag (got $ref_type $ref_name)"
      dry_run=false; raw=$ref_name ;;
    workflow_dispatch)
      dry_run=${RELEASE_DRY_RUN_INPUT:-true}
      case "$dry_run" in true|false) ;; *) die "dry_run input must be true or false, got '$dry_run'" ;; esac
      if [ "$dry_run" = true ]; then
        if [ -n "$input_version" ]; then raw=$input_version
        elif [ "$ref_type" = tag ]; then raw=$ref_name
        else raw="0.0.0-dryrun.${GITHUB_RUN_NUMBER:-0}"; fi
      else
        [ "$ref_type" = tag ] || die "a non-dry-run dispatch must be started on a v* tag ref (got $ref_type $ref_name)"
        raw=$ref_name
      fi ;;
    *) die "unsupported event $event" ;;
  esac
  version=$(parse_version "$raw") || die "invalid release version '$raw'"
  if [ "$dry_run" = false ]; then
    case "$raw" in v*) ;; *) die "release tags must start with v (got $raw)" ;; esac
    if [ -n "$input_version" ]; then
      local wanted
      wanted=$(parse_version "$input_version") || die "invalid version input '$input_version'"
      [ "$wanted" = "$version" ] || die "version input $wanted does not match tag $raw"
    fi
    tag=$raw
  else
    tag="v$version"
  fi
  emit TAG "$tag"
  emit VERSION "$version"
  case "$version" in *-*) emit PRERELEASE true ;; *) emit PRERELEASE false ;; esac
  emit DRY_RUN "$dry_run"
}

cmd_preflight() {
  need VERSION; need TAG; need DRY_RUN
  [ "$(uname -s)" = Darwin ] || die "release builds run on macOS (got $(uname -s))"
  [ "$(uname -m)" = arm64 ] || die "release builds are arm64 only (got $(uname -m))"
  [ "$(node -p process.arch)" = arm64 ] || die "Node must be arm64 (got $(node -p process.arch))"
  [ "$(node -v)" = "v$NODE_PIN" ] || die "Node $(node -v) on PATH; the Desktop pin is v$NODE_PIN"
  [ "$(pnpm -v)" = "$PNPM_PIN" ] || die "pnpm $(pnpm -v) on PATH; the repository pin is $PNPM_PIN"
  local tool
  for tool in /usr/bin/codesign /usr/bin/ditto /usr/bin/hdiutil /usr/bin/shasum /usr/bin/lipo /usr/bin/plutil; do
    [ -x "$tool" ] || die "missing $tool"
  done
  log "macOS $(sw_vers -productVersion) $(uname -m), Node $(node -v), pnpm $(pnpm -v)"
  assert_clean_head
  if [ "$DRY_RUN" = false ]; then
    local tag_commit
    tag_commit=$(git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG^{commit}") || die "tag $TAG is not present in the checkout"
    [ "$tag_commit" = "$(expected_sha)" ] || die "tag $TAG points to $tag_commit, not $(expected_sha)"
    command -v gh >/dev/null || die "GitHub CLI (gh) is required to publish"
    assert_no_release
  else
    log "dry run: version $VERSION, no GitHub release will be created"
  fi
}

cmd_build() {
  need VERSION
  cd "$ROOT"
  # Same sequence as apps/desktop/README.md "Build and run" (after pnpm install --frozen-lockfile).
  pnpm --filter '@stoneforge/smithy...' build
  pnpm --filter @stoneforge/smithy-web build:web
  pnpm --filter @stoneforge/desktop build
  # Release mode: refuses a dirty tree or build-info commit != HEAD, rebuilds, writes the version.
  STONEFORGE_RELEASE_VERSION="$VERSION" pnpm --filter @stoneforge/desktop package:mac
}

cmd_artifacts() {
  need VERSION
  # Creates zip/dmg/SHA256SUMS.txt, verifies codesign + inventory of the extracted zip and the
  # mounted dmg, and runs scripts/check-app.mjs (GUI smoke) on the extracted zip app.
  # The release app has the production identity (ai.stoneforge.desktop), which check scripts refuse
  # to launch by default (TCC grants are keyed by bundle ID, el-3qg5my). Release verification is the
  # one path that must launch it: opt in for this step only.
  STONEFORGE_DESKTOP_ALLOW_PRODUCTION_IDENTITY=1 \
    node "$DESKTOP/scripts/release-artifacts.mjs" --version "$VERSION" --app "$APP" --out "$OUT"
}

cmd_verify() {
  need VERSION
  artifact_names
  local expected listing tmp app commit
  expected=$(expected_sha)
  [ -d "$APP" ] || die "packaged app missing: $APP"
  listing=$(cd "$OUT" && /bin/ls -1 | sort | tr '\n' ' ')
  [ "$listing" = "$(printf '%s\n' "$ZIP" "$DMG" "$SUMS" | sort | tr '\n' ' ')" ] \
    || die "unexpected release files in $OUT: $listing"
  (cd "$OUT" && /usr/bin/shasum -a 256 -c "$SUMS") || die "SHA256SUMS.txt does not match"
  /usr/bin/hdiutil verify "$OUT/$DMG" >/dev/null || die "hdiutil verify failed for $DMG"

  tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/stoneforge-release-verify.XXXXXX")
  VERIFY_TMP=$tmp
  trap 'rm -rf "$VERIFY_TMP"' EXIT
  /usr/bin/ditto -x -k "$OUT/$ZIP" "$tmp"
  for app in "$APP" "$tmp/Stoneforge Desktop.app"; do
    commit=$(build_info "$app" commit)
    [ "$commit" = "$expected" ] || die "$app build-info commit $commit != $expected"
    [ "$(build_info "$app" dirty)" = false ] || die "$app build-info dirty is not false"
    [ "$(build_info "$app" release)" = true ] || die "$app is not a release-mode build"
    [ "$(build_info "$app" version)" = "$VERSION" ] || die "$app build-info version != $VERSION"
    [ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")" = "$VERSION" ] \
      || die "$app CFBundleShortVersionString != $VERSION"
    # Releases keep the installed app's identity; dev/test packages are ai.stoneforge.desktop.dev.
    [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" = ai.stoneforge.desktop ] \
      || die "$app CFBundleIdentifier is not ai.stoneforge.desktop"
    [ "$(/usr/bin/lipo -archs "$app/Contents/MacOS/Stoneforge Desktop")" = arm64 ] || die "$app is not arm64-only"
    /usr/bin/codesign --verify --deep --strict "$app" || die "codesign --verify failed for $app"
    log "verified $app: commit $commit, dirty=false, release=true, version $VERSION, ai.stoneforge.desktop, arm64, codesign OK"
  done
  assert_clean_head
}

cmd_notes() {
  need VERSION; need TAG
  artifact_names
  local sha run_url=""
  sha=$(expected_sha)
  if [ -n "${GITHUB_RUN_ID:-}" ]; then
    run_url="${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/$GITHUB_RUN_ID"
  fi
  mkdir -p "$(dirname "$NOTES")"
  cat >"$NOTES" <<EOF
## Stoneforge Desktop $VERSION for macOS (Apple Silicon)

**Download** \`$DMG\` (open it and drag Stoneforge Desktop to Applications) or \`$ZIP\`.
Check downloads with \`shasum -a 256 -c SHA256SUMS.txt\`.

- **Apple Silicon (arm64) only.** Intel Macs are not supported.
- **Ad-hoc signed and not notarized** (no Apple Developer ID yet), so macOS blocks the
  first launch. After copying the app to \`/Applications\`, either right-click
  (Control-click) **Stoneforge Desktop** → **Open** → **Open** (on macOS 15 and later:
  try to open it once, then System Settings → Privacy & Security → **Open Anyway**), or run:

  \`\`\`sh
  xattr -dr com.apple.quarantine '/Applications/Stoneforge Desktop.app'
  \`\`\`

- **Requirements:** the Codex and/or Claude Code CLIs must already be installed and
  authenticated on this Mac. The app bundles its own Node.js runtime, SQLite and \`sf\` CLI.

Built from commit \`$sha\`${run_url:+ by [this workflow run]($run_url)}.
EOF
  log "wrote $NOTES"
  cat "$NOTES"
}

cmd_publish() {
  need VERSION; need TAG; need PRERELEASE; need DRY_RUN
  [ "$DRY_RUN" = false ] || die "dry run: refusing to publish"
  artifact_names
  [ -f "$NOTES" ] || die "release notes missing; run 'notes' first"
  local args=(release create "$TAG" --repo "$REPO" --verify-tag
    --title "Stoneforge Desktop $TAG" --generate-notes --notes-file "$NOTES")
  if [ "$PRERELEASE" = true ]; then args+=(--prerelease); fi
  args+=("$OUT/$ZIP" "$OUT/$DMG" "$OUT/$SUMS")
  if [ "${CI_RELEASE_PRINT_ONLY:-}" = 1 ]; then
    log "print only (not executed):"
    printf ' %q' gh "${args[@]}"; printf '\n'
    return
  fi
  # Re-check immediately before creating: the tag must still point at the built commit and no
  # release may have appeared meanwhile. gh release create itself also fails on an existing release.
  local remote_sha
  remote_sha=$(gh api "repos/$REPO/commits/$TAG" --jq .sha) || die "cannot resolve tag $TAG on $REPO"
  [ "$remote_sha" = "$(expected_sha)" ] || die "tag $TAG on $REPO now points to $remote_sha, not $(expected_sha)"
  assert_no_release
  gh "${args[@]}"
  log "published release $TAG: $(gh release view "$TAG" --repo "$REPO" --json url --jq .url)"
}

case "${1:-}" in
  resolve) cmd_resolve ;;
  preflight) cmd_preflight ;;
  build) cmd_build ;;
  artifacts) cmd_artifacts ;;
  verify) cmd_verify ;;
  notes) cmd_notes ;;
  publish) cmd_publish ;;
  *) die "usage: $0 resolve|preflight|build|artifacts|verify|notes|publish" ;;
esac
