#!/bin/sh
# White-label guard: fails if any denylisted brand term appears in source that ships to customers.
#
# The denylist is NOT stored in this repository (so the terms themselves never land in the code).
# Provide it as a comma-separated environment variable, e.g. in CI as a repository variable:
#   BRAND_DENYLIST="term-one,term-two" sh scripts/check-brand-leak.sh
#
# See docs/architecture/05-white-label-branding.md.
set -eu

if [ -z "${BRAND_DENYLIST:-}" ]; then
  echo "check-brand-leak: BRAND_DENYLIST is not set; skipping." >&2
  exit 0
fi

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
SCAN_PATHS="apps packages"
status=0

OLD_IFS=$IFS
IFS=','
for term in $BRAND_DENYLIST; do
  IFS=$OLD_IFS
  trimmed=$(printf '%s' "$term" | sed 's/^ *//;s/ *$//')
  [ -z "$trimmed" ] && continue
  # shellcheck disable=SC2086
  if (cd "$ROOT_DIR" && grep -rIniF \
      --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next --exclude-dir=coverage \
      -- "$trimmed" $SCAN_PATHS); then
    echo "check-brand-leak: denylisted term found (see matches above)." >&2
    status=1
  fi
  IFS=','
done
IFS=$OLD_IFS

if [ "$status" -eq 0 ]; then
  echo "check-brand-leak: OK"
fi
exit "$status"
