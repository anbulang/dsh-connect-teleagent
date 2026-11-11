#!/usr/bin/env bash
# 从 DSH profile 卸载 @anbulang/dsh-connect-teleagent（同时清理 0.13 及更早的无 scope 名字）。
set -euo pipefail

PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PKG_NAME="@anbulang/dsh-connect-teleagent"
LEGACY_NAME="dsh-connect-teleagent"

[ -d "$PROFILE" ] || { echo "找不到 DSH profile：$PROFILE" >&2; exit 1; }

echo "==> 移除 $PROFILE/node_modules/$PKG_NAME 与旧链接"
rm -rf "$PROFILE/node_modules/$PKG_NAME" "$PROFILE/node_modules/$LEGACY_NAME"
rm -rf "${DSH_PLUGIN_ROOT:-$HOME/.dsh/plugins}/dsh-connect-teleagent"

echo "==> 从 profile package.json 移除依赖与 bundle"
python3 - "$PROFILE/package.json" "$PKG_NAME" "$LEGACY_NAME" <<'PY'
import json, sys
path, name, legacy = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
deps = d.get('dependencies', {})
deps.pop(name, None)
deps.pop(legacy, None)
profile = d.get('dsh', {}).get('profile', {})
bundles = [b for b in profile.get('bundles', []) if b not in (name, legacy)]
if 'dsh' in d and 'profile' in d['dsh']:
    d['dsh']['profile']['bundles'] = bundles
json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
print('   bundles:', bundles)
PY

echo "完成。重启 DeepSeek Harness 生效。"
