# 发布与登记

本文件是「把 `packages/*` 里的插件发布到 npm，并登记进 dsh-web 社区索引」的完整清单。

## 先明确边界

dsh-web 仓库对外部贡献者**只接受四类 PR**：社区插件索引登记、新皮肤、新宠物、新预设。
新增内建插件包**不在其中**，提了会被 `reject-non-content-pr.yml` 自动关闭。

所以插件的正规出口是：

> 代码留在本仓库 → 发布 npm → 往 dsh-web 提一个**只改 `packages/dsh-community-plugins/community.json`** 的 PR
> → 收录进创意工坊（dsh-market.com）→ 用户从 Web GUI 的「设置 → 创意工坊 → 插件」一键安装。

dsh-web 不搬你的代码，索引只存链接。

## 一、发布到 npm

### 1. 账号与登录（一次性）

1. 在 <https://www.npmjs.com/signup> 注册账号（若用 scoped 包名，用户名就是默认 scope：`@用户名/...`）。
2. 在本机登录：

```sh
npm login          # 按提示输入用户名/密码/邮箱；开了 2FA 会要求一次性验证码
npm whoami         # 必须能打印出用户名，否则后面 publish 一定失败
```

3. 确认 registry 指向官方源：

```sh
npm config get registry     # 必须是 https://registry.npmjs.org/
```

> 国内镜像（npmmirror 等）**只能读不能发布**。若这里指向镜像，先改回来：
> `npm config set registry https://registry.npmjs.org/`。
>
> 认证令牌由 `npm login` 写进**用户级** `~/.npmrc`，不要提交进仓库。

### 1b. 2FA：npm 只认安全密钥（重要，实测）

npm 现在对**所有包**强制要求 2FA 或「带 bypass 2FA 的 granular access token」，否则
`npm publish` 会被 registry 直接以 E403 拒绝：

```text
403 Forbidden - PUT https://registry.npmjs.org/<pkg>
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

**必须知道的三个事实（都是实测/源码确认，别再走弯路）：**

1. **网站已经彻底取消验证器 App（TOTP）。** 2FA 设置页的 METHOD 步只有一个选项
   `security-key`，页面 DOM 里连 `authenticator` / `TOTP` 字样都不存在。
   所以「用 Google/Microsoft Authenticator 扫二维码」这条路在 npm 上**已经不可能**，
   不要在这上面浪费时间。
2. **验证器 App 只存在于 CLI 的老接口** `npm profile enable-2fa auth-and-writes`
   （它会返回 `otpauth://` URL 并打印二维码与 base32 密钥）。但这个命令在 2FA 非
   pending 状态下会先要求 `Enter one-time password:`，而它的实现
   （`lib/utils/read-user-info.js` 的 `readOTP`）**只是纯文本输入，不支持安全密钥**。
   于是「只绑了安全密钥、没有 TOTP」时该命令会卡死。结论：**别指望它**。
3. **安全密钥 = Touch ID / iCloud 钥匙串 / passkey。** 在 Chrome 弹框里选
   「iCloud 钥匙串」或「您的 Chrome 个人资料」都能用 Touch ID；
   选「使用手机或平板电脑」会给出一个 WebAuthn 跨设备二维码——
   **那不是 TOTP 密钥，扫进任何验证器 App 都不会出码**（这是最容易搞错的一步）。

**发布时的 2FA 流程（CLI 交互式）：**

```text
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
Authenticate your account at:
https://www.npmjs.com/auth/cli/<uuid>
Press ENTER to open in the browser...
```

回车后浏览器打开认证页，点 `Use security key` 并验证指纹即可，CLI 会自动轮询并继续发布。

> 认证页上有个复选框：**Do not challenge npm publish from IP address \<你的 IP\>
> for the next 5 minutes**。连续发多个版本时勾上，5 分钟内免再按指纹。

**TTY 是硬要求。** npm 的 2FA 握手第一句就是
`if (!process.stdin.isTTY || !process.stdout.isTTY) throw err`
（`lib/utils/auth.js` 的 `otplease`）。所以：

- **必须由人坐在终端前发布**，agent / CI / 管道里跑不通。
- 本仓库的 `scripts/publish.mjs` 已经处理了这点：检测到 TTY 且未传 `--otp` 时用
  `stdio: 'inherit'` 把终端交给 npm，让上面的浏览器认证流程能正常发生。

**写脚本 / CI 的话**（例如将来做自动发布）：只能走带 bypass 2FA 的 granular token，
并且要留意官方的时间线（npm 站点横幅原文）：

| 用途 | bypass token 可用到 |
| --- | --- |
| 账号变更 | 2026 年 8 月起**已禁用** |
| 直接发布 | 2027 年 1 月起禁用 |

也就是说 bypass token 只是过渡方案，长期仍要落到安全密钥上。

### 2. 决定包名

- 无 scope（如 `dsh-hello`）：安装命令最短，但 `dsh-*` 好名字基本被占了，先去 npm 搜一下。
- 有 scope（如 `@your-scope/dsh-hello`）：不撞名，多插件仓库更整齐。首次发布需要
  `--access public`（scoped 包默认 private，别人装不了）；更省事的做法是在 `package.json`
  里写死：

```json
{ "publishConfig": { "access": "public" } }
```

改包名要同步改这几处（**必须一致**）：

| 位置 | 值 |
| --- | --- |
| `package.json` 的 `name` | npm 包名 |
| `cordis.patch.yml` 的 `name` | **npm 包名**（带 scope） |
| `tsdown.config.ts` 的 `clientBundle(id, ...)` | **npm 包名**（带 scope） |
| `cordis.patch.yml` 的 `id` | loader 内部唯一键，可以短（如 `dsh-hello`） |

> 为什么 `name` 必须是完整包名：客户端模块表的键就是**包名**
> （host 侧 `reconcilePackage(packageName)`），而 bundle 里注册的 id 必须与它一致。
> 同一个包名被两个 loader 行解析会直接报
> `package X resolves from multiple active Loader sources`——这就是重复挂载的失败模式。

### 3. 检查 package.json 的发布面

必须存在且正确：

```json
{
  "dsh": {
    "engines": { "dsh": ">=0.1.5-rc.1" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js"
  },
  "scripts": { "prepack": "npm run build" }
}
```

- `dsh.engines.dsh` 是插件管理器兼容检查的读取位，缺了用户装不上。
- `files` 必须包含 `lib`（构建产物才是真正被加载的东西）、`cordis.patch.yml`（bundle 清单）
  与 `README.md`。
- `exports` 必须提供 `.`（host 半区）与 `./client`（browser 半区）。
- `prepack` 在 `npm publish` 时自动构建，所以 `lib/` 不需要提交进 git。
- 建议补上 `author` / `repository` / `keywords`：`repository` 会出现在 npm 页面，
  也是社区索引核对来源的凭据。

### 4. 预检（不要跳过）

仓库提供了预检脚本，把常见失败点一次查完（未登录、版本号已占用、缺元数据、
tarball 内容不对、scoped 包没开 public）：

```sh
node scripts/publish.mjs dsh-hello            # 只预检 + dry-run，不会发布
```

它会依次做：读元数据并校验必填字段 → `npm whoami` → 查该版本是否已存在 →
跑 `pnpm gate` → `npm publish --dry-run` 并打印 tarball 清单。

确认 tarball 里有 `lib/`、`cordis.patch.yml`、`README.md` 之后进入下一步。

### 5. 发布

```sh
node scripts/publish.mjs dsh-hello --publish
```

脚本会复用前面的预检，然后**把终端交给 npm**（`stdio: 'inherit'`），浏览器打开认证页后
按 Touch ID 即可。

或者手动两步（等价）：

```sh
cd packages/dsh-hello
npm publish --dry-run     # 先看内容
npm publish               # scoped 包加 --access public
```

> **这一步必须由你在自己的终端里跑**（不要用 agent 代跑）：npm 的 2FA 握手要求 TTY，
> 而且会打开浏览器让你按 Touch ID。说明见「### 1b. 2FA：npm 只认安全密钥」。

### 6. 验证

```sh
npm view @lixklv/dsh-hello version            # 应打印刚发的版本
npm view @lixklv/dsh-hello dist.tarball       # 确认 tarball 地址
```

真实装一遍（**用临时 profile，不要动你自己的 `web` profile**）：

```sh
dsh plugin --profile dsh-hello-verify add @lixklv/dsh-hello
dsh --profile dsh-hello-verify --dump-config | grep -A2 "@lixklv/dsh-hello"
# 应看到： # == @lixklv/dsh-hello / - id: dsh-hello / name: '@lixklv/dsh-hello'
dsh plugin --profile dsh-hello-verify remove @lixklv/dsh-hello
rm -rf ~/.dsh/profiles/dsh-hello-verify
```

### 7. 之后的版本更新

索引条目**不用动**（它只存包名）。每次更新只要：

```sh
# 1. 改 package.json 的 version（遵循 semver）
# 2. 再走一遍预检 + 发布
node scripts/publish.mjs dsh-hello --publish
```

> 同一版本号不能重复发布（npm 直接拒绝），已发布的版本也基本不可撤回。
> 所以永远先 `--dry-run`，确认无误再发。
>
> `lib/` 被 `.gitignore` 忽略，靠 `prepack` 在 `npm publish` 时现场构建并打进 tarball。
> 如果哪天想让用户**不经 npm、直接 git 安装**（索引里不写 `npm` 字段），
> 就必须把 `lib/` 提交进仓库——`dsh plugin add <git-url>` 装的是仓库内容本身。

## 二、登记进 dsh-web 社区索引

### 1. 需要改的文件

只改一个：`packages/dsh-community-plugins/community.json`（一个 JSON 数组，追加一条）。

### 2. 字段契约

来自 dsh-web 的校验脚本 `scripts/community-index`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 全局唯一，例如 `dsh-hello` |
| `name` | 是 | 中文展示名 |
| `nameEn` | 是 | 英文展示名 |
| `author` | 是 | 作者标识（GitHub 登录名） |
| `repo` | 是 | `https://` 仓库地址，只能含路径安全字符（市场会把它拼进 shell 命令） |
| `npm` | 否 | npm 包名，可带 `@scope`；填了就优先用它作为安装命令 |
| `description` | 否 | 中文描述 |
| `descriptionEn` | 否 | 英文描述 |
| `category` | 否 | 一级分类 |
| `subcategory` | 否 | 二级分类，**必须**在所属 category 的合法列表内，且不能脱离 category 单独出现 |

`category` 合法枚举与各自的 `subcategory`：

```text
ui          → terminal, chat, render, panel
agent       → preset
tools       → context, browser, api, model, dev
knowledge   → memory, reading, qa
integration → remote, bridge, sync, external-ai
security    → access, policy
utility     → cleanup, stats, notify, net
```

同一条目示例：

```json
{
  "id": "dsh-hello",
  "name": "示例徽标",
  "nameEn": "Hello Badge",
  "author": "YS-BW",
  "description": "在 Web GUI 右下角显示一个插件徽标，用于验证插件管线。",
  "descriptionEn": "Shows a plugin badge in the bottom-right corner of the Web GUI to verify the plugin pipeline.",
  "repo": "https://github.com/YS-BW/dsh-plugins",
  "npm": "dsh-hello",
  "category": "ui",
  "subcategory": "panel"
}
```

> 多插件同仓库是允许的：`wingsky-1/dsh-plugin-hub` 就用同一个 `repo` 登记了两条，
> 靠不同的 `npm` 名区分。这也是本仓库采用 monorepo 的前提——
> **monorepo 必须靠 `npm` 字段落地安装命令**，因为 `repo` 装的是仓库根，
> 而安装说明符只接受「npm 包名」或「https:// git URL」两种形态，表达不了子目录。

### 3. 重新生成产物

索引的校验与生成需要 dsh-web 的一份检出（不需要全量历史）：

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
git sparse-checkout set packages/dsh-community-plugins scripts market/dist
pnpm install
node scripts/community-index     # 校验 community.json（CI 同款门禁）
node scripts/market-build        # 重新生成 market/dist 清单，必须提交生成物
```

### 4. 提交 PR

- **base 必须是 `dev`**，不是 `main`。
- 分支从最新 `origin/dev` 起：`git fetch origin dev && git rebase origin/dev`。
- PR 描述里的「PR 类别」勾 **社区插件索引**，决定自动分派给哪位协作者。
- 必须附：本地测试证据 + 同步上游最新 `dev` 后复测的证据。
- 改动含用户可见界面时附截图。

`dev` 的合并门禁是三个必需检查全绿，**不要求人工审批**：

```text
CI checks / plugin-mount / Validate PR contribution evidence
```

### 5. 收录之后

用户侧就一条命令：

```sh
dsh plugin --profile web add dsh-hello
```

之后版本更新只需要 `npm publish` 新版本，索引条目不用动。改名、换仓库、补 `npm` 字段时才需要再提一个单行 PR。

## 三、git 提交规范（本仓库）

沿用 dsh-web 的约定，方便将来对照：

```text
type(scope): subject
```

`type` 用 `feat` / `fix` / `chore` / `docs` / `test` / `refactor` / `perf`，`scope` 是包名。
禁止 emoji。示例：`feat(dsh-hello): add settings card for badge text`。

## 四、检查清单

发 npm 前：

- [ ] `npm whoami` 能打印用户名，`npm config get registry` 是官方源
- [ ] **账号已绑定安全密钥**（`https://www.npmjs.com/settings/<用户名>/tfa/list` 里能看到
      Security Key）。没绑的话发布必被 E403 拒绝，见「### 1b」
- [ ] 包名已定（无 scope 或 scoped + `publishConfig.access: public`），四处标识一致
- [ ] `author` / `repository` / `keywords` 已补
- [ ] `node scripts/publish.mjs <包名>` 预检通过
- [ ] tarball 里有 `lib/`、`cordis.patch.yml`、`README.md`
- [ ] 把该包目录**单独复制到仓库外**跑一遍 `pnpm install && pnpm build && pnpm test`，
      确认不依赖仓库根（本仓库的每个包都应该是自足的）
- [ ] 本地用**临时 profile** 装一遍验证挂载：
      `dsh plugin --profile dsh-hello-verify add link:"$PWD"`
- [ ] `package.json` 的 `dsh.engines.dsh` 与实际运行的 DSH 版本相符

`npm publish` 时（由本人终端操作）：

- [ ] 在**自己的终端**里跑，不要用 agent / CI 代跑（2FA 握手要求 TTY）
- [ ] 浏览器认证页出现后点 `Use security key` 并验证指纹
- [ ] 连续发多版本时，勾上认证页的「5 分钟内免再挑战」复选框

提索引 PR 前：

- [ ] `node scripts/community-index` 校验通过
- [ ] `node scripts/market-build` 已重新生成并提交 `market/dist`
- [ ] PR base 是 `dev`，已 rebase 到最新 `origin/dev`
- [ ] `category` / `subcategory` 取值在合法枚举内
- [ ] `npm` 字段与 `package.json` 的 `name` 完全一致
