#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo '未找到 .env。请在项目根目录配置 TYPESAFE_API_KEY。' >&2
  exit 1
fi

mkdir -p .build
mkdir -p .build/clang-module-cache .build/swift-module-cache
if [[ ! -x .build/jev-draft-advisor || \
      macos/DraftElementResolver.swift -nt .build/jev-draft-advisor || \
      macos/FocusedApplicationResolver.swift -nt .build/jev-draft-advisor || \
      macos/KeyboardDraftCapture.swift -nt .build/jev-draft-advisor || \
      macos/JevDraftAdvisor.swift -nt .build/jev-draft-advisor ]]; then
  CLANG_MODULE_CACHE_PATH="$PWD/.build/clang-module-cache" \
  SWIFT_MODULE_CACHE_PATH="$PWD/.build/swift-module-cache" \
  swiftc -parse-as-library macos/DraftElementResolver.swift macos/FocusedApplicationResolver.swift \
    macos/KeyboardDraftCapture.swift \
    macos/JevDraftAdvisor.swift \
    -o .build/jev-draft-advisor -framework AppKit -framework ApplicationServices -framework Carbon
fi

export JEV_NODE_BIN="$(command -v node)"
exec .build/jev-draft-advisor
