#!/usr/bin/env bash
# 把 dsh-connect-teleagent 安装进 DSH 的 desktop profile。
# 幂等：重复执行只会覆盖 plugin 目录与同一条 patch 记录。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
PKG_NAME="dsh-connect-teleagent"

[ -d "$PROFILE" ] || { echo "找不到 DSH profile：$PROFILE" >&2; exit 1; }

# 插件本体放在 node_modules 之外，通过 file: 依赖让包管理器自己建链接，
# 这样 profile 重新 install 不会把插件目录清掉。
PLUGIN_ROOT="${DSH_PLUGIN_ROOT:-$HOME/.dsh/plugins}"
DEST="$PLUGIN_ROOT/$PKG_NAME"
echo "==> 1/3 复制插件到 $DEST"
mkdir -p "$PLUGIN_ROOT"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/lib" "$SRC/package.json" "$SRC/cordis.patch.yml" "$SRC/README.md" "$DEST/"
[ -d "$SRC/docs" ] && cp -R "$SRC/docs" "$DEST/"
[ -d "$SRC/test" ] && cp -R "$SRC/test" "$DEST/"

echo "==> 2/3 在 profile package.json 里加入 bundle"
python3 - "$PROFILE/package.json" "$PKG_NAME" "$DEST" <<'PY'
import json, sys
path, name, dest = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(path))
d.setdefault('dependencies', {})[name] = "file:" + dest
bundles = d.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
if name not in bundles:
    bundles.append(name)
json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
print('   bundles:', bundles)
PY

echo "==> 3/3 确认 cordis.patch.yml 没有残留的明文条目"
python3 - "$PROFILE/cordis.patch.yml" "$PKG_NAME" <<'PY'
import sys
path, name = sys.argv[1], sys.argv[2]
text = open(path).read()
# bundle 自带 patch，无需在 profile patch 里再插一条；如之前手工加过则移除
lines = text.splitlines()
out, skip = [], 0
for i, line in enumerate(lines):
    if line.strip() == f"- id: {name}":
        skip = 1
    elif skip and (line.startswith("  ") or line.strip() == ""):
        continue
    elif skip:
        skip = 0
    if not skip:
        out.append(line)
open(path, 'w').write("\n".join(out) + ("\n" if out else ""))
print('   profile patch 已清理（bundle 模式下不需要显式条目）')
PY

echo
echo "完成。请完全退出 DeepSeek Harness 后重新打开。"
echo "重启后：设置 → 模型，应出现 TeleAgent 的 5 个模型（智能 · x0.6 等）。"
echo "日志：~/.dsh/profiles/desktop 下或宿主日志中搜索 dsh-connect-teleagent"
