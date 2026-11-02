#!/usr/bin/env bash
# Run the Desktop release workflow's shell steps locally, without publishing.
#
#   scripts/ci-release-local.sh [--version v0.0.0-local.1] [--keep]
#
# Clones the committed HEAD of this checkout into a fresh temporary directory
# (like actions/checkout: no untracked files, no build output, no node_modules),
# creates the tag there only, and runs scripts/ci-release.sh with the same
# subcommands and environment shape as .github/workflows/desktop-release.yml for
# a tag push: resolve, preflight, pnpm install --frozen-lockfile, build,
# artifacts (including the check-app GUI smoke), verify, notes, and publish in
# print-only mode. Nothing is pushed; no tag or release is created on GitHub.
# `preflight` does query GitHub read-only (`gh release view`) to prove the
# "release already exists" guard, so gh must be authenticated.
#
# Requirements: macOS arm64 with an unlocked graphical session, Node 22.23.3
# first on PATH, pnpm 8.15.5, gh. Uncommitted changes in this checkout are NOT
# included. The release files and notes are copied to an evidence directory
# under $TMPDIR (printed at the end); the clone is removed unless --keep.
set -euo pipefail

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TAG=v0.0.0-local.1
KEEP=false
while [ $# -gt 0 ]; do
  case "$1" in
    --version) TAG=${2:?--version requires a value}; shift 2 ;;
    --version=*) TAG=${1#--version=}; shift ;;
    --keep) KEEP=true; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac

# Managed agent sessions export workspace routing variables; a release build must not inherit them.
unset STONEFORGE_ROOT STONEFORGE_DESKTOP_INSTANCE_ID STONEFORGE_DB_PATH STONEFORGE_UPLOAD_DIR ELECTRON_RUN_AS_NODE STONEFORGE_RELEASE_VERSION

SHA=$(git -C "$SOURCE" rev-parse HEAD)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASE=$(cd "${TMPDIR:-/tmp}" && pwd -P)
WORK="$BASE/stoneforge-ci-release-$STAMP"
EVIDENCE="$BASE/stoneforge-ci-release-evidence-$STAMP"
mkdir -p "$WORK" "$EVIDENCE"
cleanup() {
  if [ "$KEEP" = false ]; then rm -rf "$WORK"; else echo "[local] kept clone: $WORK/checkout"; fi
}
trap cleanup EXIT

if [ -n "$(git -C "$SOURCE" status --porcelain --untracked-files=normal)" ]; then
  echo "[local] note: $SOURCE has uncommitted/untracked files; only committed HEAD $SHA is built"
fi
echo "[local] cloning $SHA into $WORK/checkout"
git clone --quiet --no-checkout "$SOURCE" "$WORK/checkout"
git -C "$WORK/checkout" checkout --quiet --detach "$SHA"
git -C "$WORK/checkout" -c user.name=ci-release-local -c user.email=ci-release-local@localhost \
  tag -a "$TAG" -m "local dry run $TAG" "$SHA"

# Same variables GitHub Actions provides for a tag push.
export GITHUB_EVENT_NAME=push GITHUB_REF_TYPE=tag GITHUB_REF_NAME="$TAG" GITHUB_REF="refs/tags/$TAG"
export GITHUB_SHA="$SHA" GITHUB_REPOSITORY=imcitius/stoneforge
export RELEASE_DRY_RUN_INPUT="" RELEASE_VERSION_INPUT=""
export GITHUB_OUTPUT="$WORK/github-output" GITHUB_ENV="$WORK/github-env" RUNNER_TEMP="$WORK"
: >"$GITHUB_OUTPUT"; : >"$GITHUB_ENV"
STEP="$WORK/checkout/scripts/ci-release.sh"

step() { echo; echo "[local] ===== $* ====="; }
load_env() { # like Actions: later steps see values appended to $GITHUB_ENV
  local key value
  while IFS='=' read -r key value; do [ -n "$key" ] && export "$key=$value"; done <"$GITHUB_ENV"
}

cd "$WORK/checkout"
step "resolve"; bash "$STEP" resolve; load_env
step "preflight"; bash "$STEP" preflight
step "pnpm install --frozen-lockfile"; pnpm install --frozen-lockfile
step "build"; bash "$STEP" build
step "artifacts"; bash "$STEP" artifacts
step "verify"; bash "$STEP" verify
step "notes"; bash "$STEP" notes
step "publish (print only)"; CI_RELEASE_PRINT_ONLY=1 bash "$STEP" publish

cp -R apps/desktop/dist/release "$EVIDENCE/release"
cp apps/desktop/dist/release-notes.md "$GITHUB_OUTPUT" "$EVIDENCE/"
cp "apps/desktop/dist/mac/Stoneforge Desktop-darwin-arm64/Stoneforge Desktop.app/Contents/Resources/app/build-info.json" "$EVIDENCE/"
echo
echo "[local] PASS: $TAG from $SHA; evidence in $EVIDENCE"
