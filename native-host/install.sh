#!/bin/bash

# Install the native messaging host for AI Chat Downloader
# Usage: ./install.sh <chrome-extension-id>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.aichatdl.native_host"
MANIFEST_SRC="$SCRIPT_DIR/$HOST_NAME.json"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
TARGET="$TARGET_DIR/$HOST_NAME.json"

if [ -z "$1" ]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo ""
  echo "Find your extension ID at chrome://extensions (enable Developer mode)"
  exit 1
fi

EXTENSION_ID="$1"

# Make save_file.js executable
chmod +x "$SCRIPT_DIR/save_file.js"

# Create target directory if needed
mkdir -p "$TARGET_DIR"

# Generate manifest with correct path and extension ID
cat > "$TARGET" <<EOF
{
  "name": "$HOST_NAME",
  "description": "AI Chat Downloader - Native file writer for batch downloads",
  "path": "$SCRIPT_DIR/save_file.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Native messaging host installed successfully."
echo "  Manifest: $TARGET"
echo "  Script:   $SCRIPT_DIR/save_file.js"
echo "  Extension ID: $EXTENSION_ID"
echo ""
echo "Restart Chrome for changes to take effect."
