#!/bin/sh
# package-chart.sh -- package charts/uploadmyshit for one build, ready to publish.
#
#   scripts/package-chart.sh PATCH APP_VERSION IMAGE_REPOSITORY OUT_DIR
#
# The chart in the tree is the source. What a registry serves must also say which build it
# is for, so this packages a copy with three fields set, and leaves the tree alone:
#
#   version            Chart.yaml's major.minor, and PATCH. CI passes its pipeline number,
#                      which only rises, so a plain `helm upgrade` finds the newest -- a
#                      prerelease suffix would hide every build behind `--devel`.
#   appVersion         APP_VERSION: the image tag the build pushed, which the chart pulls
#                      when image.tag is left empty.
#   image.repository   IMAGE_REPOSITORY. The tree holds a placeholder, because the real
#                      registry's path must not appear in a published repository.
#
# Prints the path of the package. Exit 1 when an argument or the chart is not what this
# expects, and when the package, rendered, would not pull IMAGE_REPOSITORY:APP_VERSION --
# a substitution that matched nothing would otherwise publish a chart that pulls from
# example.com, and say nothing.
#
# POSIX sh: it runs in the alpine/helm image and on a stock macOS.

set -u

die() { printf 'package-chart: %s\n' "$1" >&2; exit 1; }

[ $# -eq 4 ] || die "usage: $0 PATCH APP_VERSION IMAGE_REPOSITORY OUT_DIR"
PATCH=$1
APP_VERSION=$2
REPOSITORY=$3
OUT=$4

# Each lands inside a sed expression or a SemVer, so each is held to what those accept.
case $PATCH in ''|*[!0-9]*|0?*) die "PATCH must be a number without leading zeros, got '$PATCH'" ;; esac
case $APP_VERSION in ''|*[!A-Za-z0-9_.-]*) die "APP_VERSION must be an image tag, got '$APP_VERSION'" ;; esac
case $REPOSITORY in ''|*[!a-z0-9._/:-]*) die "IMAGE_REPOSITORY must be an image repository, got '$REPOSITORY'" ;; esac

command -v helm >/dev/null 2>&1 || die "helm not found"

CHART="$(dirname "$0")/../charts/uploadmyshit"
[ -f "$CHART/Chart.yaml" ] || die "no chart at $CHART"

MINOR=$(sed -n 's/^version: *"\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\)\.[0-9][0-9]*"\{0,1\} *$/\1/p' "$CHART/Chart.yaml")
[ -n "$MINOR" ] || die "no major.minor.patch version in $CHART/Chart.yaml"
VERSION=$MINOR.$PATCH

TMP="${TMPDIR:-/tmp}/package-chart.$$"
mkdir "$TMP" || die "cannot create temporary directory"
trap 'rm -rf "$TMP"' EXIT INT TERM

cp -R "$CHART" "$TMP/uploadmyshit" || die "cannot copy the chart"
sed -e "s/^version:.*/version: $VERSION/" \
    -e "s/^appVersion:.*/appVersion: \"$APP_VERSION\"/" \
    "$CHART/Chart.yaml" > "$TMP/uploadmyshit/Chart.yaml" || die "cannot write Chart.yaml"
sed -e "s|^  repository: registry\.example\.com/uploadmyshit/uploadmyshit\$|  repository: $REPOSITORY|" \
    "$CHART/values.yaml" > "$TMP/uploadmyshit/values.yaml" || die "cannot write values.yaml"

mkdir -p "$OUT" || die "cannot create $OUT"
helm package "$TMP/uploadmyshit" --destination "$OUT" >/dev/null || die "helm package failed"
PACKAGE="$OUT/uploadmyshit-$VERSION.tgz"
[ -f "$PACKAGE" ] || die "helm package did not write $PACKAGE"

# Read the package back, as an install would: the image it pulls with no values given.
helm template check "$PACKAGE" --show-only templates/deployment.yaml \
  | grep -qF "image: \"$REPOSITORY:$APP_VERSION\"" \
  || die "$PACKAGE would not pull $REPOSITORY:$APP_VERSION"

printf '%s\n' "$PACKAGE"
