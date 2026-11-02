/**
 * 包元数据校验。
 *
 * 这些字段不是"好看"，而是市场/设置页读取的契约：
 * 缺 `icon` 卡片没图标，缺 `author`/`repository` 市场条目无法溯源。
 * 用测试锁住，避免以后被误删。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('package.json: 必需的展示/溯源字段齐全', () => {
  for (const key of ['name', 'version', 'description', 'license', 'displayName', 'author', 'icon', 'repository', 'homepage', 'bugs']) {
    assert.ok(pkg[key] !== undefined && pkg[key] !== '', `缺少字段 ${key}`)
  }
})

test('package.json: name 与 locale 的 meta.title 一致（两者会同时出现在界面上）', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(fs.readFileSync(path.join(root, 'locale', 'en.json'), 'utf8'))
  assert.equal(zh.meta.title, pkg.name)
  assert.equal(en.meta.title, pkg.name)
  assert.ok(zh.meta.description.length > 10, '中文描述过短')
  assert.ok(en.meta.description.length > 10, '英文描述过短')
})

test('package.json: version 为合法 semver 且处于 0.x（未稳定）', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.version.split('.')[0], '0', '尚未稳定，应为 0.x')
})

test('locale: meta.detail 指向包内空文档（配置页不展示 README）', () => {
  // DSH 的文档顺序：locale 的 meta.detail 优先，没有才回退到 README。
  // 我们用一个 **空的** .md 顶掉 README，让插件详情面板没有内容可渲染
  //（宿主对空 markdown 用 :empty{display:none} 折叠）。
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${lang}.json`), 'utf8'))
    const detail = locale?.meta?.detail
    assert.equal(typeof detail, 'string', `${lang}.json 缺少 meta.detail`)
    // 契约：相对路径、/ 分隔、以 .md 结尾、无 ..、无 scheme
    assert.match(detail, /\.(md|markdown)$/)
    assert.ok(!detail.startsWith('/'))
    assert.ok(!detail.includes(':'), 'meta.detail 不能带 URL scheme')
    assert.ok(!detail.split('/').includes('..'))

    const file = path.join(root, detail)
    assert.ok(fs.existsSync(file), `${lang}.json 的 meta.detail 指向不存在的文件：${detail}`)
    assert.equal(fs.readFileSync(file, 'utf8').trim(), '', '该文档必须为空，否则配置页又会出现内容')
  }
})

test('README 仍然保留（只影响详情面板，不影响仓库文档）', () => {
  const readme = path.join(root, 'README.md')
  assert.ok(fs.existsSync(readme), 'README.md 不应被删除')
  assert.ok(fs.readFileSync(readme, 'utf8').length > 1000, 'README 内容不应被清空')
})

test('package.json: exports 覆盖宿主需要的入口', () => {
  for (const key of ['.', './client', './cordis.patch.yml', './locale/*.json', './package.json']) {
    assert.ok(pkg.exports[key] !== undefined, `exports 缺少 ${key}`)
  }
})

test('icon.png: 存在且为 128×128 PNG', () => {
  const file = path.join(root, 'icon.png')
  assert.ok(fs.existsSync(file), '缺少 icon.png')
  const buf = fs.readFileSync(file)
  // PNG magic
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  // IHDR: 宽高在 16..24 字节
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  assert.equal(width, 128)
  assert.equal(height, 128)
})

test('files 清单包含运行所需目录与文档', () => {
  for (const entry of ['lib', 'locale', 'icon.png', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(entry), `files 缺少 ${entry}`)
  }
})

test('bin 指向存在的多子命令入口', () => {
  const bin = pkg.bin[pkg.name]
  assert.ok(typeof bin === 'string', 'bin 未配置')
  assert.ok(fs.existsSync(path.join(root, bin)), `bin 指向的文件不存在: ${bin}`)
})
