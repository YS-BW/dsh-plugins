#!/usr/bin/env node
/**
 * 契约门禁的自测。逐个注入真实的失败模式，确认 check-plugin.mjs 都能拦住。
 *
 * 这个脚本存在的意义：门禁本身如果没有测试，就只是装饰。每次放宽或新增规则后
 * 跑一遍，确保「发布不了」和「发布了用不了」两类问题仍然会被抓住。
 *
 *   node scripts/test-checks.mjs
 *
 * 退出码非 0 表示有某个失败模式没被拦住。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKER = join(REPO_ROOT, 'scripts', 'check-plugin.mjs')
const TEMPLATE = join(REPO_ROOT, 'packages', 'dsh-hello')
const WORK = join(tmpdir(), `dsh-check-selftest-${process.pid}`)

function freshCopy(name) {
  const dest = join(WORK, name)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(TEMPLATE, dest, {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  })
  return dest
}

function editJson(dir, mutate) {
  const file = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  mutate(manifest)
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

function editText(file, mutate) {
  writeFileSync(file, mutate(readFileSync(file, 'utf8')))
}

function runChecker(dirs, { dist = false } = {}) {
  const argv = [CHECKER, ...(dist ? ['--dist'] : []), ...dirs]
  try {
    const stdout = execFileSync(process.execPath, argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output: stdout }
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** 把包改名（package.json / patch / clientBundle 三处一起改），保持契约自洽。 */
function renamePackage(dir, fullName, rowId) {
  const base = fullName.replace(/^@[^/]+\//, '')
  const short = base.replace(/^dsh-/, '')
  editJson(dir, (manifest) => {
    manifest.name = fullName
  })
  editText(join(dir, 'cordis.patch.yml'), (text) =>
    text.replace(/^(\s*)-\s*id:.*$/m, `$1- id: ${rowId}`).replace(/^(\s*)name:.*$/m, `$1name: '${fullName}'`))
  editText(join(dir, 'tsdown.config.ts'), (text) =>
    text.replace(/clientBundle\('[^']+'/, `clientBundle('${fullName}'`))
  editText(join(dir, 'lib', 'client.js'), (text) =>
    text.replace(/id:\s*"[^"]+"/, `id: "${fullName}"`))
  return short
}

const cases = [
  {
    name: '基线：未改动的包必须通过',
    expectOk: true,
    setup: () => [freshCopy('baseline')],
  },
  {
    name: 'clientBundle id 与包名不一致（浏览器半区会静默不注册）',
    expect: /clientBundle/,
    setup: () => {
      const dir = freshCopy('bundle-id')
      editText(join(dir, 'tsdown.config.ts'), (t) => t.replace(/clientBundle\('[^']+'/, "clientBundle('@lixklv/dsh-wrong'"))
      return [dir]
    },
  },
  {
    name: 'cordis.patch.yml 的 name 与包名不一致（loader 解析不到）',
    expect: /的 name .* 与 package\.json 的 name/,
    setup: () => {
      const dir = freshCopy('patch-name')
      editText(join(dir, 'cordis.patch.yml'), (t) => t.replace(/^(\s*)name:.*$/m, "$1name: '@lixklv/dsh-wrong'"))
      return [dir]
    },
  },
  {
    name: 'cordis.patch.yml 结构被写坏（缺 insert 块）',
    expect: /insert/,
    setup: () => {
      const dir = freshCopy('patch-broken')
      editText(join(dir, 'cordis.patch.yml'), (t) => t.replace(/^-\s*insert:\s*$/m, '- something-else:'))
      return [dir]
    },
  },
  {
    name: '两个包用了相同的 patch 行 id（挂载冲突）',
    expect: /重复/,
    setup: () => {
      const a = freshCopy('dup-row-a')
      const b = freshCopy('dup-row-b')
      renamePackage(a, '@lixklv/dsh-dupa', 'dsh-shared-id')
      renamePackage(b, '@lixklv/dsh-dupb', 'dsh-shared-id')
      return [a, b]
    },
  },
  {
    name: '两个包包名重复',
    expect: /重复/,
    setup: () => [freshCopy('dup-name-a'), freshCopy('dup-name-b')],
  },
  {
    name: 'files 漏掉 lib（用户装上没有代码）',
    expect: /files 必须包含/,
    setup: () => {
      const dir = freshCopy('files-lib')
      editJson(dir, (m) => { m.files = ['cordis.patch.yml', 'README.md'] })
      return [dir]
    },
  },
  {
    name: 'files 漏掉 cordis.patch.yml（装上但插件不挂载）',
    expect: /files 必须包含/,
    setup: () => {
      const dir = freshCopy('files-patch')
      editJson(dir, (m) => { m.files = ['lib', 'README.md'] })
      return [dir]
    },
  },
  {
    name: 'tarball 里缺 exports 指向的文件',
    expect: /tarball 里没有这个文件/,
    dist: true,
    setup: () => {
      const dir = freshCopy('exports-missing')
      editJson(dir, (m) => { m.exports['./client'] = './lib/nope.js' })
      return [dir]
    },
  },
  {
    name: '缺 dsh.engines.dsh（插件管理器拒绝安装）',
    expect: /dsh\.engines\.dsh/,
    setup: () => {
      const dir = freshCopy('no-engines')
      editJson(dir, (m) => { delete m.dsh.engines })
      return [dir]
    },
  },
  {
    name: 'dsh.client.platform 不是 web',
    expect: /platform/,
    setup: () => {
      const dir = freshCopy('bad-platform')
      editJson(dir, (m) => { m.dsh.client.platform = 'node' })
      return [dir]
    },
  },
  {
    name: 'version 不是合法 semver',
    expect: /semver/,
    setup: () => {
      const dir = freshCopy('bad-version')
      editJson(dir, (m) => { m.version = 'v1' })
      return [dir]
    },
  },
  {
    name: 'private: true（发布不了）',
    expect: /private/,
    setup: () => {
      const dir = freshCopy('is-private')
      editJson(dir, (m) => { m.private = true })
      return [dir]
    },
  },
  {
    name: '缺 README.md',
    expect: /README/,
    setup: () => {
      const dir = freshCopy('no-readme')
      rmSync(join(dir, 'README.md'), { force: true })
      return [dir]
    },
  },
  {
    name: 'scope 与仓库约定不一致',
    expect: /dshPlugins\.scope/,
    setup: () => {
      const dir = freshCopy('bad-scope')
      renamePackage(dir, '@someone-else/dsh-hello', 'dsh-hello')
      return [dir]
    },
  },
  {
    name: 'tsdown.config.ts 引用仓库根 shared/（破坏自足性）',
    expect: /自足性/,
    setup: () => {
      const dir = freshCopy('not-standalone')
      editText(join(dir, 'tsdown.config.ts'), (t) => `${t}\n// see ../../shared/tsdown.client.ts\n`)
      return [dir]
    },
  },
  {
    name: '构建产物里注册的 id 不对（装了但界面无反应）',
    expect: /lib\/client\.js 里没有 id/,
    dist: true,
    setup: () => {
      const dir = freshCopy('dist-bundle-id')
      editText(join(dir, 'lib', 'client.js'), (t) => t.replace(/id:\s*"[^"]+"/, 'id: "@lixklv/dsh-other"'))
      return [dir]
    },
  },
  {
    name: '构建产物里泄漏本机绝对路径',
    expect: /绝对路径/,
    dist: true,
    setup: () => {
      const dir = freshCopy('dist-abs-path')
      editText(join(dir, 'lib', 'client.js'), (t) => `${t}\n// /Users/someone/secret/dir/\n`)
      return [dir]
    },
  },
  {
    name: '客户端 bundle 引用了平台模块表之外的 @deepseek-ai/*',
    expect: /平台模块表之外/,
    dist: true,
    setup: () => {
      const dir = freshCopy('dist-purity')
      editText(join(dir, 'lib', 'client.js'), (t) => `${t}\n// require("@deepseek-ai/dsh-tools")\n`)
      return [dir]
    },
  },
]

let failed = 0
for (const testCase of cases) {
  const dirs = testCase.setup()
  const result = runChecker(dirs, { dist: testCase.dist === true })
  let pass
  if (testCase.expectOk === true) {
    pass = result.ok
  } else {
    pass = !result.ok && testCase.expect.test(result.output)
  }

  if (pass) {
    console.log(`  PASS  ${testCase.name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${testCase.name}`)
    console.log(`        期望：${testCase.expectOk === true ? '检查通过' : `拒绝并报 ${testCase.expect}`}`)
    console.log(`        实际：${result.ok ? '检查通过了（漏检！）' : result.output.trim().split('\n').map((l) => `          ${l}`).join('\n')}`)
  }
}

rmSync(WORK, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n[test-checks] 失败：${cases.length} 个用例中有 ${failed} 个没被正确拦住`)
  process.exit(1)
}
console.log(`\n[test-checks] OK：${cases.length} 个用例全部符合预期`)
