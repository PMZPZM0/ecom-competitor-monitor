#!/usr/bin/env bash
set -euo pipefail

readonly REPOSITORY="PMZPZM0/ecom-competitor-monitor"
readonly RELEASE_API="https://api.github.com/repos/${REPOSITORY}/releases/latest"
readonly RELEASE_ROOT="${RELEASE_ROOT:-/srv/ecom-monitor}"
readonly PUBLIC_BASE="${PUBLIC_BASE:-https://jvsppl.vip/ecom-monitor/releases}"
readonly KEEP_RELEASES="${KEEP_RELEASES:-3}"

umask 022
mkdir -p "$RELEASE_ROOT/releases"
release_json="$(mktemp)"
staging=""
checksums=""
cleanup() {
  rm -f "$release_json"
  if [[ -n "$checksums" ]]; then rm -f "$checksums"; fi
  if [[ -n "$staging" && -d "$staging" ]]; then rm -rf -- "$staging"; fi
}
trap cleanup EXIT

curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
  --header "Accept: application/vnd.github+json" \
  --header "User-Agent: ecom-competitor-monitor-release-mirror" \
  --output "$release_json" "$RELEASE_API"

tag="$(jq -er '.tag_name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+([-.][A-Za-z0-9.-]+)?$"))' "$release_json")"
version="${tag#v}"
published_at="$(jq -er '.published_at' "$release_json")"
escaped_version="${version//./\\.}"
asset_pattern="^EcomMonitor-${escaped_version}-(win-x64\\.exe|mac-x64\\.dmg|mac-arm64\\.dmg)$"
asset_count="$(jq --arg pattern "$asset_pattern" '[.assets[] | select(.name | test($pattern))] | length' "$release_json")"
[[ "$asset_count" == "3" ]] || { echo "Expected three release assets, found $asset_count" >&2; exit 1; }

target="$RELEASE_ROOT/releases/$tag"
checksums="$(mktemp)"
jq -r --arg pattern "$asset_pattern" '.assets[] | select(.name | test($pattern)) | ((.digest | sub("^sha256:"; "")) + "  " + .name)' "$release_json" | sort > "$checksums"
if [[ ! -d "$target" ]]; then
  staging="$(mktemp -d "$RELEASE_ROOT/releases/.${tag}.XXXXXX")"
  chmod 0755 "$staging"
  while IFS=$'\t' read -r name url size digest; do
    [[ "$url" == "https://github.com/${REPOSITORY}/releases/download/${tag}/"* ]] || { echo "Untrusted asset URL: $url" >&2; exit 1; }
    [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Missing SHA-256 for $name" >&2; exit 1; }
    curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$staging/$name" "$url"
    [[ "$(stat -c '%s' "$staging/$name")" == "$size" ]] || { echo "Size mismatch for $name" >&2; exit 1; }
    printf '%s  %s\n' "${digest#sha256:}" "$staging/$name" | sha256sum --check --strict
  done < <(jq -r --arg pattern "$asset_pattern" '.assets[] | select(.name | test($pattern)) | [.name, .browser_download_url, (.size | tostring), .digest] | @tsv' "$release_json")
  install -m 0644 "$checksums" "$staging/.verified-sha256"
  mv "$staging" "$target"
  staging=""
fi

while IFS=$'\t' read -r name size; do
  [[ -f "$target/$name" ]] || { echo "Mirrored asset is missing: $name" >&2; exit 1; }
  [[ "$(stat -c '%s' "$target/$name")" == "$size" ]] || { echo "Mirrored size mismatch: $name" >&2; exit 1; }
done < <(jq -r --arg pattern "$asset_pattern" '.assets[] | select(.name | test($pattern)) | [.name, (.size | tostring)] | @tsv' "$release_json")
if ! cmp --silent "$checksums" "$target/.verified-sha256"; then
  (cd "$target" && sha256sum --check --strict "$checksums")
  install -m 0644 "$checksums" "$target/.verified-sha256"
fi
rm -f "$checksums"
checksums=""

manifest_tmp="$RELEASE_ROOT/latest.json.tmp"
jq -n \
  --arg version "$version" \
  --arg tag "$tag" \
  --arg publishedAt "$published_at" \
  --arg publicBase "$PUBLIC_BASE/$tag" \
  --arg assetPattern "$asset_pattern" \
  --slurpfile release "$release_json" \
  '{version: $version, tag: $tag, publishedAt: $publishedAt, assets: ($release[0].assets | map(select(.name | test($assetPattern)) | {name, size, sha256: (.digest | sub("^sha256:"; "")), platform: (if (.name | endswith("win-x64.exe")) then "win32" else "darwin" end), arch: (if (.name | contains("arm64")) then "arm64" else "x64" end), url: ($publicBase + "/" + .name)}))}' \
  > "$manifest_tmp"
mv "$manifest_tmp" "$RELEASE_ROOT/latest.json"

mapfile -t old_releases < <(find "$RELEASE_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -name 'v*' -printf '%T@\t%p\n' | sort -rn | tail -n "+$((KEEP_RELEASES + 1))" | cut -f2-)
for old_release in "${old_releases[@]}"; do
  [[ "$old_release" == "$RELEASE_ROOT/releases/"v* ]] || { echo "Refusing unsafe cleanup path: $old_release" >&2; exit 1; }
  rm -rf -- "$old_release"
done

echo "Release mirror ready: $tag"
