#!/usr/bin/env bash
# 从 DSH profile 卸载 dsh-connect-teleagent。
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PKG_NAME="dsh-connect-teleagent"

[ -d "$PROFILE" ] || { echo "找不到 DSH profile：$PROFILE" >&2; exit 1; }

echo "==> 移除 $PROFILE/node_modules/$PKG_NAME"
rm -rf "$PROFILE/node_modules/$PKG_NAME"

echo "==> 从 profile package.json 移除依赖与 bundle"
python3 - "$PROFILE/package.json" "$PKG_NAME" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
d = json.load(open(path))
d.get('dependencies', {}).pop(name, None)
bundles = d.get('dsh', {}).get('profile', {}).get('bundles', [])
if name in bundles:
    bundles.remove(name)
json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
print('   bundles:', bundles)
PY

echo "完成。重启 DeepSeek Harness 生效。"
