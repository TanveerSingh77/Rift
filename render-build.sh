#!/usr/bin/env bash
#
# Render build step. Installs the two external binaries the bridge needs.
#
# Neither is committed to the repository: the Linux yt-dlp build is downloaded
# per deploy, and ffmpeg comes from a static tarball rather than apt because the
# distribution package drags in enough dependencies to be a poor fit for a
# 512 MB free instance image.
#
# Nothing here needs root, so it runs the same on Render, Fly, or a laptop.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/bin"
mkdir -p "$BIN"

echo "==> yt-dlp"
# The standalone release binary is self-contained (no Python needed).
curl -fsSL --retry 3 \
  -o "$BIN/yt-dlp" \
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
chmod +x "$BIN/yt-dlp"

echo "==> yt-dlp self-update"
# The release asset can lag behind master, and a stale extractor is the most
# common cause of "it worked yesterday". Never fail the build on this.
"$BIN/yt-dlp" -U || echo "    (self-update skipped)"

echo "==> ffmpeg (static)"
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --retry 3 -o "$TMP/ffmpeg.tar.xz" "$FFMPEG_URL"
tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP"
# The archive unpacks to a versioned directory such as ffmpeg-7.1-amd64-static.
for dir in "$TMP"/ffmpeg-*; do
  [ -d "$dir" ] || continue
  cp "$dir/ffmpeg" "$dir/ffprobe" "$BIN/"
  chmod +x "$BIN/ffmpeg" "$BIN/ffprobe"
done

echo "==> verifying"
"$BIN/yt-dlp" --version
"$BIN/ffmpeg" -version | head -n 1 || true
echo "==> build step complete"