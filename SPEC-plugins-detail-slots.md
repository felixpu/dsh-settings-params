# 实现规格：用官方详情页槽位为第三方插件页加「环境变量密钥」区块与徽章

> 目的：为 `dsh-sql` 等消费 `process.env` 的第三方插件详情页，追加「环境变量密钥」提示区块与徽章，
> 指引用户前往 `dsh-settings-params` 已提供的「设置 → 参数设置」页配置。
>
> ⚠️ **本文是当时点的实现记录，部分内容已随实现演进过时，不要当作现行说明使用。**
> 尤其是文中反复提到的页面位置「设置 → 参数设置」：该页后来已搬到本插件自己的插件
> 详情页（`plugins.bundle.config`），设置导航里不再有该项。现行入口见 [README](./README.md)。
> 原文保留不改，是为了留下「当时为什么这样决策」的依据。
>
> **本文只依据已安装 DSH 源码写就，不含记忆推断。** 每条结论后附证据行号。
> 约束：**绝对不修改任何第三方插件**；本次改造只落在 `dsh-settings-params` 自己的浏览器半身。

安装根：`/Users/felix/.nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`

---

## 1. 槽位契约（`plugins.detail.section` / `plugins.detail.badge`）

### 1.1 两个槽位的性质

| 项 | 值 |
|---|---|
| 槽位名 | `plugins.detail.section`、`plugins.detail.badge`（另有 `plugins.detail.actions`） |
| `kind` | `list`（可多个条目并存，按 `order` 升序排列） |
| `scope` | `root` |
| 宣告方 | `main` 槽位里的一个条目（`client-ui-plugin-manager`）——**页面挂载期间才存在** |
| `replaceRisk` | `none` |

证据：
- 契约元数据：`dsh-cordis-client-runner/lib/client.js:4059-4148`（badge 在 4059、section 在 4105）
- 页面侧的 children 声明：`dsh-client-ui-plugin-manager/lib/client.js:3461-3468`
- TS 契约（含 `declare module` 合并）：`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:117-146`

### 1.2 `register` 选项要求（两个槽位完全相同）

| 选项 | 要求 | 类型 | 说明 |
|---|---|---|---|
| `name` | **必填** | `string` | 必须是槽位名原文，如 `'plugins.detail.section'` |
| `id` | **必填（list 槽位）** | `string` | 单元格键。**用你自己的新 id**：新 id 会与官方条目并列；复用已存在的 id 会顶替那一格 |
| `order` | 可选 | `number` | 同槽位条目排序，升序，默认 `0` |
| `label` | 可选 | `string \| (() => string)` | 在 owner 需要投影文本处显示（导航行、标签页）。thunk 每次投影都重新求值，故本地化文本跟随当前语言而无需重新注册 |

**`id` 必填是运行期硬校验，不是类型约定**：`dsh-client-ui-slots/lib/index.js:182`

```js
case "list": {
  if (options.id === void 0) throw new Error(`list slot "${options.name}" requires options.id`);
```

`order` 的排序实现见 `dsh-client-ui-slots/lib/index.js:221`（list 槽位按 `priority` 再按 `order` 升序）。

### 1.3 ⚠️ label 在本场景无用户可见效果

`label` 的文档措辞限定为「owner projects one（导航行、标签页）处显示」。
本次两个槽位的 owner 渲染路径**都不读 `label`**：

- section：`renderSlot("plugins.detail.section", { subject })` — `dsh-client-ui-plugin-manager/lib/client.js:1785 / 1855 / 1985`
- badge：`renderSlot("plugins.detail.badge", { subject })` — `dsh-client-ui-plugin-manager/lib/client.js:1770 / 1829 / 1933`

owner props 只有 `subject` 一个字段（见第 2 节），渲染期 props 组合为
「标准件 + 条目 inject + slot inject + ownerProps」，owner 从不传 `label` 下去
（`dsh-client-ui-renderer/lib/client.js:767-779`）。

**结论**：`label` 可以填（便于诊断/工具投影），但**不要指望它变成标题**——
区块标题必须由组件自己 `h3`/`p` 绘制。这也正是合约里「an entry draws its own section chrome（条目自绘区块外观）」的含义：
`dsh-client-ui-plugin-manager/README.zh.md:68`、`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:136-141`。

---

## 2. owner props：`subject` 的形状

渲染期每条目收到的 owner props 就一个字段（`dsh-cordis-client-runner/lib/client.js:4084`、`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:60-64`）：

```ts
export interface PluginDetailProps {
  /** 打开页面的 subject；条目对无话可说的 subject 返回 null。 */
  readonly subject: PluginsSubject
}
```

`PluginsSubject` 是**三选一联合**，权威定义在
`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:26-59`：

```ts
export type PluginsSubject =
  | { readonly kind: 'bundle'; readonly pkg: PluginPackageRef }
  | { readonly kind: 'row';    readonly pkg: PluginPackageRef; readonly row: PluginRowRef }
  | { readonly kind: 'item';   readonly id: string }
```

### 2.1 `PluginPackageRef`（`pkg`）字段

| 字段 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | `string` | 是 | 包名 |
| `version` | `string` | 否 | Host 报告时才存在（注意：**可能是 `undefined`**） |
| `installed` | `boolean` | 是 | profile 自身依赖是否持有该包；随安装提供的组合包为 `false` |
| `enabled` | `boolean` | 是 | 组合包是否开启 |
| `rows` | `readonly PluginRowRef[]` | 是 | 该组合包声明的行 |

### 2.2 `PluginRowRef`（`row`）字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `rowId` | `string` | 组合包 patch 里声明的行 id |
| `moduleName` | `string` | 该行指名的模块 |
| `enabled` | `boolean` | 该行是否运行 |

### 2.3 构造点（页面侧真实代码，可逐字对照）

- `kind:'item'`：`dsh-client-ui-plugin-manager/lib/client.js:1745-1748` — `{ kind: "item", id: item.id }`
- `kind:'row'`：`dsh-client-ui-plugin-manager/lib/client.js:1798-1802` — `{ kind: "row", pkg: packageRef(pkg), row: rowRef(row) }`
- `kind:'bundle'`：`dsh-client-ui-plugin-manager/lib/client.js:1871-1874` — `{ kind: "bundle", pkg: packageRef(pkg) }`
- 两个投影函数（**字段就是这些，多的没有**）：
  - `rowRef(row)` → `{ rowId, moduleName, enabled }`（`dsh-client-ui-plugin-manager/lib/client.js:1721-1728`）
  - `packageRef(pkg)` → `{ name, version?, installed, enabled, rows: pkg.rows.map(rowRef) }`（`dsh-client-ui-plugin-manager/lib/client.js:1729-1738`）

`packageRef` 里 `version` 是条件展开的：

```js
return {
  name: pkg.name,
  ...pkg.version === void 0 ? {} : { version: pkg.version },
  installed: pkg.installed, enabled: pkg.enabled, rows: pkg.rows.map(rowRef)
};
```

⇒ **实现必须容忍 `pkg.version === undefined`**，不要写 `pkg.version.length`。

### 2.4 三个渲染调用点（`renderSlot` 到底在哪触发）

| 行 | 页面 | 渲染出的 DOM 祖先 |
|---|---|---|
| `1785` | `ItemDetail`（官方插件页） | `.detailSections` 内，在 `plugins.item`（`view:'page'`）配置之后 |
| `1855` | `RowDetail`（组合包某行的配置页） | `.detailSections` 内，在 `plugins.row.config` 之后 |
| `1985` | `PackageDetail`（**组合包详情页**） | `.detailSections` 内，在 `RowsSection`（组件列表）之后 |

badge 的对应位置：`1770`（ItemDetail 标题行）、`1829`（RowDetail 标题行）、
`1933`（PackageDetail 标题行，在 version / beta / problem 三个 Tag **之后**）。

---

## 3. 「无话可说必须返回 null」

三处源码一致要求：

- `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:62-63`：`/** subject of the open page; an entry renders null for a subject it has nothing for. */`
- `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:137-140`：section 槽位「An entry draws its own section chrome and renders null for a subject it has nothing for.」
- `dsh-cordis-client-runner/lib/client.js:4084`（ownerProps 元数据同句）

官方 README 的示例同样是这个写法（`dsh-client-ui-plugin-manager/README.zh.md:75`）：

```tsx
}, ({ t, subject }) => subject.kind === 'bundle' ? <HealthSection pkg={subject.pkg} t={t} /> : null))
```

**本项目的判据**（决定哪些 subject 有话可说）：
只在 `subject.kind === 'bundle'`（或 `'row'`，视最终设计）且该包确实消费 `process.env` 时渲染；
其余一律 `return null`。判定必须**纯函数、无副作用、幂等**——条目在同一页面内会被反复重渲染。

⚠️ 渲染返回 `null` 与「删除注册」语义不同：null 表示本条目在此 subject 下不占位；
list 槽位不会因此塌陷其它条目（`dsh-client-ui-renderer/lib/client.js:1180-1185` 的 list 分支按条目各自渲染）。

---

## 4. 注册方式：`ctx.slots.inject` + `ctx.slots.register`

### 4.1 为什么必须用 `inject` 包一层

`plugins.detail.*` 是**子槽位**：由 `main` 槽位那个条目的 `children` 表声明，
**只在插件管理页条目挂载期间存在**。`ctx.slots.register` 对未声明的槽位直接抛错
（`dsh-client-ui-slots/lib/index.js:165`）：

```js
if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
```

`ctx.slots.inject(key, callback)` 的语义（`dsh-client-ui-renderer/lib/types/client/registry.d.ts:96-111`）：
「为槽位的每个声明生命周期安装一次 effect。声明已存在时回调同步执行；否则在宣告方的 `register()` 提交后执行。声明塌陷会销毁 effect，之后再声明会重新执行。」

⇒ 必须用它做**等待声明**，而不是直接注册。

### 4.2 标准写法

```js
ctx.slots.inject("plugins.detail.section", function () {
  return ctx.slots.register({
    name: "plugins.detail.section",
    id: "dsh-settings-params-env-hint",   // 自有 id，不顶替官方条目
    order: 60,
    label: "环境变量密钥"
  }, EnvHintSection);
});
```

`inject` 的返回值必须是同步 disposer 或其可迭代集合（`SlotInjectionEffect`，`dsh-client-ui-renderer/lib/types/client/registry.d.ts:44`）。
`ctx.slots.register` 本身返回 disposer，直接 `return` 即可——这也是官方示例与
`packages/dsh-settings-params/client/client.js:751-759` 现有 `settings.section` 注册的写法。

### 4.3 是否需要 `inject = ['slots']`？——**需要**

`slots` 是 cordis 服务，`ctx.slots` 在 `apply` 里可用要求插件**先声明依赖**：

- 官方示例逐字如此：`dsh-cordis-client-runner/lib/client.js:4147`
  > `return { inject: ['slots'], apply(ctx) { ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(...)) } }`
- 真实的官方消费者同样声明：`dsh-experimental-client-ui-voice-input/lib/client.js:5746-5751` 的
  `const inject = ["remote", "slots", "locale", "pluginNavigation"]`
- 框架语义：`inject` 里的服务就绪后才加载插件（官方文档 `develop/basic/`「声明依赖」一节）

**现状**：`packages/dsh-settings-params/client/client.js:54` 已经是 `var inject = ["slots"];`
⇒ 若再加 `pluginNavigation`（见第 5 节），需要扩成 `["slots", "pluginNavigation"]`。

⚠️ `dsh.client.inject`（package.json 里那个）与插件对象的 `inject` 是**两回事**：
前者是模块加载器层面的包依赖（`@deepseek-ai/dsh-client-locale` 等），后者是 cordis 服务依赖。
两者都要正确填写。参见 `packages/dsh-settings-params/package.json` 的 `dsh.client.inject`。

---

## 5. `pluginNavigation` 服务：跳转到组合包详情

### 5.1 服务契约（`dsh-client-ui-plugin-manager/lib/types/client/index.d.ts:11-22`）

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 跨插件导航到「插件」面板。 */
    pluginNavigation: {
      /**
       * 打开某组合包的详情，不改变当前 Session。
       * 组合包不存在时，加载完成后显示插件列表。
       * @param packageName - 组合包的 npm 包名。
       */
      openBundle(packageName: string): void;
    }
  }
}
```

### 5.2 提供方实现（`dsh-client-ui-plugin-manager/lib/client.js:3474-3483`）

```js
const disposeNavigation = ctx.reflect.provide("pluginNavigation", { openBundle: (packageName) => {
  ctx.layout.selectPanel(PANEL_ID);          // 切到「插件」面板
  instance.actions.setView({ kind: "package", name: packageName });  // 选中该组合包
} });
```

### 5.3 真实调用范例（`dsh-experimental-client-ui-voice-input/lib/client.js:5754, 5768-5770`）

```js
const inject = ["remote", "slots", "locale", "pluginNavigation"];
// ...
ctx.pluginNavigation.openBundle("@deepseek-ai/dsh-experimental-voice-input-bundle");
```

### 5.4 本项目的用法与「跳去参数设置页」的关系

本次目标是**指引用户去「设置 → 参数设置」**，而 `dsh-settings-params` 自己就是那个页面的所有者。
`pluginNavigation.openBundle(pkg)` 只能打开**插件组合包的详情页**（`setView({kind:'package'})`），
**没有**「打开某个设置页」的 API。

⇒ 因此存在两条可选路线，**实现任务须二选一并写清理由**：

- **路线 A（推荐，零额外服务依赖）**：区块内放一个**说明文案 + 操作指引**，不依赖任何跳转服务。
  参数设置页已在 `settings.section`（id `dsh-settings-params`，`order: 50`）注册，用户在设置里可见。
  优点：不新增 inject，不依赖插件面板是否可用，第三方包不存在也不会出错。
- **路线 B（附加便捷入口）**：额外提供「在插件列表中查看该包」按钮，调用
  `ctx.pluginNavigation.openBundle(pkg.name)`。需把 `pluginNavigation` 加进 `inject`。
  ⚠️ 若插件管理面板/该行未启用，`openBundle` 可能落在「显示列表」的降级路径上——
  按钮语义要写成「查看插件详情」而非「去配置」，避免误导。

**注**：`pluginNavigation` 由 `client-ui-plugin-manager` 提供，而 `plugins.detail.*` 槽位也由它宣告。
只要槽位存在，该服务必然已 provide（同一个 `slots.inject("main", ...)` 作用域内，
`dsh-client-ui-plugin-manager/lib/client.js:3428-3484`）；但把服务写进 `inject` 会让插件在插件管理器缺席时整体不加载——
这点在路线选择时需权衡。

---

## 6. seed 表：允许 `dsh-client-ui-slots` 与 `dsh-client-ui-primitives`

平台种子表在 Web 前端产物里，**已实测提取**（`dsh-web-frontend/dist/assets/index-Q6zc2uHV.js`）：

```js
function WS(){return{
  react: yf,
  "react/jsx-runtime": jf,
  "react-dom": Lf,
  "react-dom/client": Tf,
  "@deepseek-ai/cordis": Jd,
  "@deepseek-ai/dsh-client-store": th,
  "@deepseek-ai/dsh-client-ui-slots": lh,
  "@deepseek-ai/dsh-client-ui-primitives": qb,
  "@deepseek-ai/dsh-client-ui-dockkit": FS
}}
```

⇒ **两个包都在表内**，可安全 `require`：

| 模块 | 状态 | 本项目用途 |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-slots` | ✅ 在表内 | 槽位类型/`resolveSlotLabel`；运行时若只需 `register` 则不必显式 require |
| `@deepseek-ai/dsh-client-ui-primitives` | ✅ 在表内 | `Tag`（徽章）、`Button`、`Pill`、`Tooltip` 等 |

补充事实：
- 表外模块会导致整页 `Failed to load plugins`（`dsh-client-modules/lib/client.js:705` 的 fail-loud 分支）。
- **这两个包是 dsh 自家包的构建期依赖，磁盘 `node_modules` 里没有对应目录**
  ⇒ 绝不能写进 `package.json` 的 `dependencies`（会让 pnpm 去 registry 拉不存在的包而失败）。
  只能在运行时用 `require(...)` 取，并像
  `packages/dsh-settings-params/client/client.js:36-43` 那样 `try/catch` 兜底。
- 现有 client 已经用了 `require("react")` 与 `require("@deepseek-ai/dsh-client-ui-primitives")`，
  并按本仓库约定用 `react.createElement`（无 JSX 打包器）。

`Tag` 的可用 tone 见 `dsh-client-ui-primitives/lib/types/Tag.d.ts`（官方页面自身用
`tone: "neutral" | "info" | "danger"`，见 `dsh-client-ui-plugin-manager/lib/client.js:1918-1932`）。

---

## 7. 实现清单（供后续实现任务直接依据）

1. **文件**：只改 `packages/dsh-settings-params/client/client.js`（浏览器半身）。
   不改 `lib/`；**绝不触碰任何第三方插件包**。
2. **inject**：视路线选择决定是否把 `pluginNavigation` 加入 `var inject = [...]`（当前为 `["slots"]`）。
3. **新增两个组件**：
   - `EnvHintSection({ subject })` → `kind`/包名判定，无话可说 `return null`；
     有话说则自绘区块外观（参考现有 `.sp-*` 类名风格 + `--dsw-*` 变量）。
   - `EnvHintBadge({ subject })` → 同样先判定再渲染；用 primitives 的 `Tag`。
4. **两次注册**：分别 `ctx.slots.inject("plugins.detail.section", ...)` 与
   `ctx.slots.inject("plugins.detail.badge", ...)`，**各自独立的 id**（例如
   `dsh-settings-params-env-hint-section` / `-badge`）。
5. **幂等**：判定函数只读 `subject`，不 fetch、不写状态；重渲染不得有副作用。
6. **样式**：沿用现有 `installStyles()` 注入的 `<style>`，类名不与既有冲突。
7. **容错**：`pkg.version` 可能 `undefined`；`pkg.rows` 可能是空数组。

---

## 8. 证据索引（全部来自已安装源码）

| 事实 | 文件:行 |
|---|---|
| badge 槽位契约元数据 | `dsh-cordis-client-runner/lib/client.js:4059-4103` |
| section 槽位契约元数据 | `dsh-cordis-client-runner/lib/client.js:4105-4149` |
| 官方 register 示例（含 `inject: ['slots']`） | `dsh-cordis-client-runner/lib/client.js:4147` |
| `PluginDetailProps` / `subject` | `dsh-cordis-client-runner/lib/client.js:4084, 4130` |
| 三槽位 children 声明 | `dsh-client-ui-plugin-manager/lib/client.js:3457-3468` |
| `PluginsSubject` 权威定义 | `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:26-59` |
| `PluginDetailProps` 定义 | `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:60-64` |
| `SlotMap` 合并声明 | `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:73-147` |
| `rowRef` / `packageRef` 投影 | `dsh-client-ui-plugin-manager/lib/client.js:1721-1738` |
| ItemDetail（`item` subject + section/badge 调用点） | `dsh-client-ui-plugin-manager/lib/client.js:1744-1789` |
| RowDetail（`row` subject + 调用点） | `dsh-client-ui-plugin-manager/lib/client.js:1794-1859` |
| PackageDetail（`bundle` subject + 调用点） | `dsh-client-ui-plugin-manager/lib/client.js:1868-1990` |
| `pluginNavigation` 服务类型 | `dsh-client-ui-plugin-manager/lib/types/client/index.d.ts:11-22` |
| `pluginNavigation` 提供方实现 | `dsh-client-ui-plugin-manager/lib/client.js:3474-3483` |
| `pluginNavigation` 真实消费者 | `dsh-experimental-client-ui-voice-input/lib/client.js:5746-5751, 5768-5770` |
| list 槽位 `id` 必填校验 | `dsh-client-ui-slots/lib/index.js:182` |
| list 排序（order 升序） | `dsh-client-ui-slots/lib/index.js:221` |
| 未声明槽位注册报错 | `dsh-client-ui-slots/lib/index.js:165` |
| `slots.inject` 语义与签名 | `dsh-client-ui-renderer/lib/types/client/registry.d.ts:96-111` |
| `SlotInjectionEffect` | `dsh-client-ui-renderer/lib/types/client/registry.d.ts:44` |
| 渲染 props 组合顺序 | `dsh-client-ui-renderer/lib/client.js:752-779` |
| list 分支的 entries 渲染 | `dsh-client-ui-renderer/lib/client.js:1180-1185` |
| seed 表（`staticModules`）实测 | `dsh-web-frontend/dist/assets/index-Q6zc2uHV.js`（函数 `WS()`） |
| 表外模块 fail-loud | `dsh-client-modules/lib/client.js:705` |
| 官方 README 槽位说明 | `dsh-client-ui-plugin-manager/README.zh.md:68-77` |
| 官方文档（服务依赖 / inject） | <https://deepseek-harness.github.io/deepseek-harness/develop/basic/> |

---

## 9. 验证方式（本规格自身的可核验性）

上述源码行号均以 `sed -n '<n>p' <file>` 逐条复核。核验命令示例：

```sh
D=/Users/felix/.nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
sed -n '4105,4149p' "$D/dsh-cordis-client-runner/lib/client.js"   # section 契约 + 官方示例
sed -n '26,64p'     "$D/dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts"  # subject 三形态
sed -n '1721,1738p' "$D/dsh-client-ui-plugin-manager/lib/client.js"  # rowRef / packageRef
sed -n '174,185p'   "$D/dsh-client-ui-slots/lib/index.js"            # list 槽位 id 必填
```
