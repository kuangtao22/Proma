#!/bin/bash
# DutyDeck 图标生成入口（保留旧路径，兼容既有文档与习惯用法）。
#
# 实际生成逻辑在 scripts/generate-brand-icons.ts：SDF 光栅化 + 自带 PNG/ICO/ICNS 编码，
# 只依赖 Node 内置模块，不再需要 rsvg-convert / ImageMagick（本机未安装时旧脚本跑不通）。
# 品牌几何的源文件是同目录下的 icon.svg 与 dutydeck-logos/icon.svg。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

bun run scripts/generate-brand-icons.ts
