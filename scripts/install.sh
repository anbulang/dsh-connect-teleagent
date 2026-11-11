#!/usr/bin/env bash
# 把 @anbulang/dsh-connect-teleagent 安装进 DSH 的 desktop profile。
# 幂等：重复执行只会覆盖 plugin 目录与同一条 bundle 注册。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
# 插件身份：profile 里的依赖键与 dsh.profile.bundles 都用这个名字。
PKG_NAME="@anbulang/dsh-connect-teleagent"
# 安装目录名：保持扁平（与包名无关），方便文档里写路径。
PKG_DIR="dsh-connect-teleagent"
# Loader 条目 id（同时是 settings 命名空间）：改名时刻意保持不变，用户设置不丢。
ENTRY_ID="dsh-connect-teleagent"

[ -d "$PROFILE" ] || { echo "找不到 DSH profile：$PROFILE" >&2; exit 1; }

# 插件本体放在 node_modules 之外，通过 file: 依赖让包管理器自己建链接，
# 这样 profile 重新 install 不会把插件目录清掉。
PLUGIN_ROOT="${DSH_PLUGIN_ROOT:-$HOME/.dsh/plugins}"
DEST="$PLUGIN_ROOT/$PKG_DIR"
echo "==> 1/3 复制插件到 $DEST"
mkdir -p "$PLUGIN_ROOT"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/lib" "$SRC/package.json" "$SRC/cordis.patch.yml" "$SRC/README.md" "$DEST/"
[ -d "$SRC/docs" ] && cp -R "$SRC/docs" "$DEST/"
[ -d "$SRC/test" ] && cp -R "$SRC/test" "$DEST/"

echo "==> 2/3 在 profile package.json 里加入 bundle"
python3 - "$PROFILE/package.json" "$PKG_NAME" "$DEST" "$PKG_DIR" <<'PY'
import json, sys
path, name, dest, legacy = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = json.load(open(path))
deps = d.setdefault('dependencies', {})
# 0.13 及更早用的是无 scope 的包名，一并迁到新名字
deps.pop(legacy, None)
deps[name] = "file:" + dest
profile = d.setdefault('dsh', {}).setdefault('profile', {})
bundles = [b for b in profile.setdefault('bundles', []) if b != legacy]
if name not in bundles:
    bundles.append(name)
profile['bundles'] = bundles
json.dump(d, open(path, 'w'), ensure_ascii=False, indent=2)
print('   bundles:', bundles)
PY

echo "==> 3/3 确认 profile 的 cordis.patch.yml 没有残留的明文条目"
python3 - "$PROFILE/cordis.patch.yml" "$ENTRY_ID" <<'PY'
import sys
path, entry_id = sys.argv[1], sys.argv[2]
text = open(path).read()
# bundle 自带 patch，无需在 profile patch 里再插一条；如之前手工加过则移除
lines = text.splitlines()
out, skip = [], 0
for line in lines:
    if line.strip() == f"- id: {entry_id}":
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
