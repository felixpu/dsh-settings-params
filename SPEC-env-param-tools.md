# 规格：env_param_list / env_param_get 两个受控环境变量读取工具

> 本文档是 **task-1 的产出**，也是 **task-2 的实现依据**。
> 所有契约均由本机已安装的 DSH 源码**实际读取并实测**得出，每条附 `file:line` 证据。
> 实现时若与本文档冲突，以本文档为准；若发现本文档与源码不符，先修正文档再改代码。

---

## 0. 问题与立论（先讲清为什么需要这两个工具）

### 0.1 现象

用户变量 `DSH_SQL_PASSWORD_OPENCROWD` 在插件侧报告「已注入」，但**模型侧读不到**：

```
$ echo "DSH_SQL_PASSWORD_OPENCROWD=[${DSH_SQL_PASSWORD_OPENCROWD:-<<空>>}]"
DSH_SQL_PASSWORD_OPENCROWD=[<<空>>]
```

### 0.2 根因（已实测）

DSH 在 spawn 子进程时调用 `scrubbedParentEnv()` 剥离凭证形态变量：

- 证据：`/Users/felix/.nvm/versions/node/v22.22.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js:50-56`

```js
function scrubbedParentEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== void 0 && !SENSITIVE_ENV_PATTERN.test(key) && !key.toUpperCase().startsWith("DSH_")) env[key] = value;
	...
}
```

两条规则：

| 规则 | 定义处 | 命中 `DSH_SQL_PASSWORD_OPENCROWD`？ |
|---|---|---|
| `DSH_` 前缀 | `dsh-subprocess/lib/index.js:52`（`key.toUpperCase().startsWith("DSH_")`） | **是** |
| 敏感名 | `dsh-subprocess/lib/index.js:32`：`const SENSITIVE_ENV_PATTERN = /KEY\|PASSWORD\|SECRET\|TOKEN/i;` | **是**（含 `PASSWORD`） |

本机实测（直接调用官方导出的函数）：

```
SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i
DSH_ENV_PREFIX = "DSH_"
剥离后 DSH_SQL_PASSWORD_OPENCROWD 是否存在: false
父进程里是否存在: false 长度= 0
  DSH_SQL_PASSWORD_OPENCROWD: 命中DSH_前缀=true 命中敏感模式=true 是否保留=false
  PATH: 命中DSH_前缀=false 命中敏感模式=false 是否保留=true
  HOME: 命中DSH_前缀=false 命中敏感模式=false 是否保留=true
```

注：上面的「父进程里是否存在: false」是因为**那一次 shell 本身就是被剥离过的子进程**；
宿主真实进程内该键是有值的（由本插件 `EnvLedger` 写入），这正是「插件说已注入、
模型侧读不到」这一矛盾的来源。

### 0.3 官方设计意图：隐式继承被禁，显式提供放行

`dsh-subprocess/lib/index.js:36-39` 的注释原文：

> harness identity never leaks implicitly (**a deliberately forwarded credential or
> current `DSH_*` fact goes through the spec's explicit `env`, which merges after
> this scrub**)

即：**剥离针对的是「隐式继承」，不是「凭证本身不可用」**。宿主刻意保留了一条
「显式提供即放行」的正路。

### 0.4 本方案的立论基础（task-4 要求核验的论证）

**工具调用不经过 spawn。** 工具是宿主进程内的普通 JS 函数调用：

- 注册：`ctx.tools.register(definition)`（`@deepseek-ai/dsh-tools/lib/types/index.d.ts:636`）
- 调用：`ToolRuntime.execute(exec)` → `createExecution` → 直接 `await` 工具的 `execute`
  （`@deepseek-ai/dsh-tools/lib/index.js:3117-3132`、`:3133-3145`）

整条链路是 `process.env` → 同一进程内的 JS 函数 → 返回值，**没有任何 `spawn`**，
因此 `scrubbedParentEnv()` 根本不在这条路径上。**这就是子代理也能读到值的原因。**

补充证据（子代理为何也能看到这些工具）：`register()` 的文档写明
「Register globally or in the calling agent scope」（`.../dsh-tools/lib/types/index.d.ts:630-636`），
全局注册的工具对每个 agent 作用域可见；作用域内注册只是**遮蔽**全局同名工具，
不会砍掉全局工具（同文件 `:664-669`）。因此两个工具注册后，主代理与子代理都能调用。

### 0.5 必须写进文档的固有代价

**工具结果会进入模型上下文与对话记录。** 这条通路一旦取到明文，该明文就被写进
tool result，进而：

1. **进入模型上下文** —— 会被发送给上游模型服务，可能被其记录；
2. **留在本次会话的对话记录/日志中** —— 可被回看、导出、检索；
3. 因此**高敏感密钥不建议开启**。

此代价无法通过实现消除（`tools/post-execute` 的替换只影响「落盘副本」的展示，
程序本身已收到完整值，且渲染给模型的 content 仍含明文 —— 见
`.../dsh-tools/lib/types/index.d.ts:71-84`）。**唯一正确的处置是如实告知用户**，
故客户端文案必须同时覆盖上述三点（见 §4.3）。

---

## A. 工具定义契约

### A1. ToolDefinition 完整形状

类型定义：`.../dsh-tools/lib/types/index.d.ts:115-191`（`interface ToolDefinition extends ToolSchema`）。

必需字段：

| 字段 | 类型 | 证据 | 说明 |
|---|---|---|---|
| `name` | `string` | `ToolSchema` | 工具名 |
| `description` | `string` | `ToolSchema` | 模型可见描述 |
| `parameters` | JSON Schema | `ToolSchema` | 参数 schema |
| `output` | `ToolOutputDefinition` | `:117`「**Mandatory** canonical output declaration」 | **必需** |
| `execute` | `(args, exec) => Promise<unknown>` | `:119-128` | 只返回 canonical 值 |

可选字段（本任务可用）：

| 字段 | 证据 | 本任务用法 |
|---|---|---|
| `timeoutMs` | `:151-158` | 不设（纯内存读，无需超时预算） |
| `isConcurrencySafe` | `:159-172` | 不设（默认不并行，安全） |
| `presentCall` / `presentResult` | `:173-190` | 不设，用通用展示 |

**不设 `timeoutMs` 是刻意的**：文档写明「Declaring it asserts this tool forwards `exec.signal`
to a cooperative implementation that can reach quiescence when the signal aborts」
（`:155-157`）。本任务不做异步 IO，无需声明。

### A2. output 是必需的，且形状为 `{ schema, render }`

- 证据 `:105-113`：

```ts
export interface ToolOutputDefinition {
    /** Raw supported JSON Schema enforced against every successful canonical value. */
    readonly schema: JsonSchemaNode;
    /** Pure projection from validated arguments and value to Native/model content. */
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
```

**`execute` 只返回 canonical JSON 值，模型可见内容由 `render` 产生。**

本机实测（用真实 `ToolRuntime` + `SystemPrompt` 驱动）：

```
ctx.tools: object ctx.systemPrompt: object
register 返回 disposer: function
模型可见 schema: {"name":"probe_env_get","description":"探针","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}}
成功 content: [{"type":"text","text":"OK X=secret-value"}] isError= false
拒绝 content: [{"type":"text","text":"Error: 拒绝：未授权变量"}] isError= true
```

要点：

- `render` 收到的 `value` 是 `execute` 的返回值；返回 `ContentBlock[]`（本任务只用 `{ type: 'text', text }`）。
- **`execute` 抛错会被注册表捕获并渲染为 `Error: <message>` 的 text block**（实测第二行）。
  因此「拒绝」既可在 `execute` 里 `throw`，也可返回错误态值后由 `render` 表达。
  本规格选择 **抛错**：拒绝发生在取明文之前，连 canonical 值都不构造，语义最短。
- **`render` 必须 total（不得抛错）**，且应当对 `value` 做保守取值（`Array.isArray` / `typeof` 判定），
  因为 `schema` 校验失败时 `value` 可能不是预期形状。
- 实测到的一个硬约束：**`execute` 的成功返回值必须是 lossless JSON**。
  非 lossless（如含 `undefined` 字段）会被注册表替换为
  `Error: tool "probe_env_get" returned invalid output: value is not lossless JSON`。
  故两个工具的返回值里**不要出现 `undefined`**，缺省值一律用 `''` / `false` / `null`。

### A3. 注册方式与 inject

- `register(definition: ToolDefinition): () => void`
  —— `.../dsh-tools/lib/types/index.d.ts:630-636`，返回**精确的 disposer**。
- 插件必须显式声明依赖，否则 `apply()` 内 `ctx.tools` 不可用：

  dsh-sql 范例：`/Users/felix/.dsh/profiles/web/node_modules/dsh-sql/lib/index.js:13-15`

  ```js
  /** cordis 服务注入：apply 里要用 ctx.tools，必须显式声明。 */
  export const name = 'sql';
  export const inject = ['tools'];
  ```

  **本插件现状**：`packages/dsh-settings-params/lib/index.js:93`

  ```js
  export const inject = ['webServer', 'loader'];
  ```

  → **task-2 必须改为 `['webServer', 'loader', 'tools']`。**

- disposer 交由 `ctx.effect` 托管（与现有路由同构）。dsh-sql 用的是
  `ctx.on('dispose', ...)` 手动收集（`dsh-sql/lib/index.js:34-43`），
  但**本插件既有约定是 `ctx.effect`**，应保持一致：

  ```js
  ctx.effect(() => ctx.tools.register(def), 'dsh-settings-params: 工具 xxx');
  ```

  证据（现有路由写法）：`packages/dsh-settings-params/lib/index.js:990-1009` 起。

### A4. compileParameters 用法

dsh-sql 自带一个 14 行的 schema 小工具（`dsh-sql/lib/tools.js:7-21`）：

```js
function compileParameters(spec) {
    const properties = {};
    const required = [];
    for (const [key, prop] of Object.entries(spec)) {
        if (prop?.required === true) required.push(key);
        const node = {};
        if (typeof prop?.type === 'string') node.type = prop.type;
        if (typeof prop?.description === 'string') node.description = prop.description;
        properties[key] = node;
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}
```

**本插件不应把这个函数复制进来**（会把 dsh-sql 的实现细节耦合进本包）。
直接手写等价的字面量即可 —— 两个工具的参数极简：

```js
// env_param_list：无可选参数
parameters: { type: 'object', properties: {} }

// env_param_list：带可选 pattern
parameters: { type: 'object', properties: { pattern: { type: 'string', description: '…' } } }

// env_param_get：name 必填
parameters: {
  type: 'object',
  properties: { name: { type: 'string', description: '环境变量名（必填）。' } },
  required: ['name'],
}
```

本机实测：上述两种形状均被 `assertSupportedJsonSchema` 接受。

```
可选参数 → 接受
必填参数 → 接受
```

**注意运行时校验**：`arguments` 是模型给的，不可信。参考 dsh-sql 的做法
（`dsh-sql/lib/tools.js:22-34`）自带 `asRecord` / `optionalString` / `requiredString`
做类型收敛，**不要**假定 `args.name` 一定是 string。

---

## B. 关键安全事实

### B5. 工具结果进入对话历史并被模型看到 —— 固有代价

见 §0.5。规格要求：**写入客户端风险提示文案时必须覆盖三点**
（模型上下文 / 对话记录与日志 / 高敏感密钥不建议开启）。

### B6. 工具调用不走 spawn —— 协议成立的根本原因

见 §0.4，已给出完整证据链：

1. `scrubbedParentEnv()` 只在 spawn 路径生效（`dsh-subprocess/lib/index.js:50-56`）；
2. 工具执行路径为进程内函数调用（`dsh-tools/lib/index.js:3117-3132`）；
3. 全局注册的工具对子代理可见（`dsh-tools/lib/types/index.d.ts:630-669`）。

**结论：本方案成立。** 且注意其安全含义：
DSH 的剥离**本来就不是防模型的安全边界**（模型本来就能通过工具读到宿主的一切），
它只是**惰性防泄漏**。因此本次改动的**真实安全增量完全等于 expose 白名单的强度**。

---

## C. 本插件现有结构

### C7. params.yml 的读写 —— 新增顶层 `expose` 需要改哪几处

**目标格式**（与 `variables`、`reload` 并列的顶层键）：

```yaml
variables:
  DSH_SQL_PASSWORD_OPENCROWD:
    value: "..."
    note: "生产库"

# 允许模型通过 env_param_get 读取明文的变量（默认空）。
# 注意：开启后明文会进入模型上下文与会话记录。
expose:
  - "DSH_SQL_PASSWORD_OPENCROWD"

reload:
  targets:
    - "dsh-sql"
```

#### C7.1 `serializeYamlDocument` —— `lib/index.js:282-313`

现状签名 `(variables, targets)`，只写 `variables` 与 `reload.targets`。

**改法**：签名扩为 `(variables, targets, expose)`，在 `variables` 段与 `reload` 段
**之间**插入 `expose` 段。序列化样式照抄现有 `reload.targets`（空时写 `expose: []`，
非空时逐行 `  - "NAME"`，用 `toYamlScalar` 转义）：

```js
lines.push('# 允许模型通过 env_param_get 读取明文的变量（默认空）。');
lines.push('# 开启后明文会进入模型上下文与会话记录，高敏感密钥不建议开启。');
if (expose.length === 0) {
  lines.push('expose: []');
} else {
  lines.push('expose:');
  for (const key of expose) lines.push('  - ' + toYamlScalar(key));
}
```

#### C7.2 `parseYamlDocument` —— `lib/index.js:218-274`

新增 `expose` 数组的解析。**关键风险点**：现有解析器用
`section` 变量做顶层分派，且**顶层的 `- "NAME"` 序列项没有 section 的前置判定**
（`:263-270` 是 `if (section === 'reload')` 里面判断 `body.startsWith('- ')`）。

因此实现时**必须在 `section === 'expose'` 分支里**判断 `- ` 前缀，写法照抄 reload：

```js
if (section === 'expose') {
  if (body.startsWith('- ')) {
    const item = parseYamlScalar(body.slice(2));
    if (item !== '' && expose.length < EXPOSE_LIMIT) expose.push(item);
  }
  continue;
}
```

同时 `return { variables, targets }` 要扩为 `{ variables, targets, expose }`。

**兼容性检查**：旧文件没有 `expose:` 顶层键时，`section` 会被设为 `''`，
落到所有分支之外被忽略 —— 行为安全，解析结果 `expose` 为空数组。

#### C7.3 新增 `sanitizeExpose` —— 照 `sanitizeTargets`（`lib/index.js:433-443`）写

`sanitizeTargets` 的现有逻辑：非数组 → 空；逐项 `typeof === 'string'` 后 `trim()`；
空串或超长跳过；已存在跳过（去重）；达到上限 `break`。

`sanitizeExpose` 与它的**唯一差别**：条目必须是合法变量名，用现有的
`NAME_PATTERN`（`lib/index.js:102`：`/^[A-Za-z_][A-Za-z0-9_]*$/`）与 `NAME_MAX`（`:105`，128）。

```js
function sanitizeExpose(input) {
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    const key = typeof item === 'string' ? item.trim() : '';
    if (key === '' || key.length > NAME_MAX) continue;
    if (!NAME_PATTERN.test(key)) continue;   // 非法变量名直接丢弃，不抛错
    if (out.includes(key)) continue;
    out.push(key);
    if (out.length >= EXPOSE_LIMIT) break;
  }
  return out;
}
```

新增常量 `EXPOSE_LIMIT`（建议 64，与 `TARGET_LIMIT` 对齐）。

**语义要点**：非法条目**静默丢弃**（与 `sanitizeTargets` 一致），
因为这是「文件被手改坏了」的降级场景，**降级方向必须是「更少的授权」**，
绝不能因为文件畸形就放宽。丢弃 = 拒绝 = 安全。

#### C7.4 `readDocument` —— `lib/index.js:413-426`

现状：文件不存在或 `catch` 时返回 `{ variables: new Map(), targets: [] }`。

**改法**：
- 成功路径增加 `parsed.expose = sanitizeExpose(parsed.expose);`
- **两处兜底返回值都要加 `expose: []`**（`:414` 与 `:424`），否则调用方拿到
  `undefined` 会在 `.includes()` 处崩溃 —— 这属于「文件损坏时必须安全降级」，是硬要求。

#### C7.5 其余调用点（**容易漏**）

`serializeYamlDocument` 的调用点共 4 处，改成三参后**全部**要跟着改，
且**都必须把 `doc.expose` 原样传回**，否则保存变量会把白名单静默清空：

| 行 | 路由 | 现有调用 | 必须改为 |
|---|---|---|---|
| `:399` | `migrateLegacyIfNeeded` | `serializeYamlDocument(legacy, [])` | `serializeYamlDocument(legacy, [], [])` |
| `:1031` | `POST /set` | `serializeYamlDocument(doc.variables, doc.targets)` | `…, doc.expose)` |
| `:1061` | `POST /unset` | `serializeYamlDocument(doc.variables, doc.targets)` | `…, doc.expose)` |
| `:1122` | `POST /apply` | `serializeYamlDocument(doc.variables, nextTargets)` | `…, doc.expose)` |

> 这是本任务最容易出错的地方：漏传 `expose` 会让用户在改一个无关变量时**静默撤销授权**。
> 反向若写成「漏传时保留旧白名单」也可接受，但**显式传参更清晰**，推荐上表做法。

### C8. 现有路由模式 —— 新增 `/expose` 照 `:990` 起写

模板（以 `POST /set` 为例，`lib/index.js:1012-1042`）：

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/dsh-settings-params/set',
  handler: async (request, response) => {
    if (!isTrustedPost(request)) {
      sendJson(response, 403, { ok: false, error: '本接口仅接受同源 POST 请求。' });
      return;
    }
    const body = await readJsonBody(request);
    ...
    sendJson(response, 200, { ok: true, ... });
  },
}), 'dsh-settings-params: set route');
```

**必须遵守的三点**：

1. `kind: 'exact'` + 完整路径前缀 `/dsh-settings-params/`；
2. **第一个动作就是 `isTrustedPost(request)`**（`:707-718`），失败即 403 —— 该路由能改授权，属高权限操作；
3. `readJsonBody` 解析请求体（`:725-745`），写文件用 `atomicWrite`（`:379-384`），
   用 `sendJson`（`:753-759`）回包，**且绝不回传任何明文**。

### C9. 已有的 pre-execute 门参考（**本任务不实现，仅备查**）

dsh-sql 的写法（`dsh-sql/lib/index.js:22-33`）：

```js
if (cfg.writeApproval) {
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.name !== 'sql_exec') return next();
        const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {});
        const sql = typeof args.sql === 'string' ? args.sql : '';
        return { kind: 'ask', reason: 'sql_exec 写操作需要确认：' + sql.slice(0, 200) + (sql.length > 200 ? '…' : '') };
    });
}
```

契约：`'tools/pre-execute'(exec, next) => Promise<PreToolDecision>`，
`next()` = 放行，返回 `{ kind: 'ask', reason }` = 请求审批
（`.../dsh-tools/lib/types/index.d.ts:44-52`）。

> **本任务明确不做审批门**（用户已决策：只靠白名单）。此处仅记录写法，供将来需要时参考。

---

## D. 实现规格（task-2 直接照此写）

### D1. 新增常量

| 常量 | 值 | 说明 |
|---|---|---|
| `EXPOSE_LIMIT` | `64` | expose 条目上限，与 `TARGET_LIMIT`（`:117`）对齐 |

复用现有 `NAME_PATTERN`（`:102`）、`NAME_MAX`（`:105`）。

### D2. 工具一：`env_param_list`

**用途**：让模型看到「哪些变量可读」，但**只回掩码状态，任何情况下不回明文**。

| 项 | 值 |
|---|---|
| name | `env_param_list` |
| parameters | `{ type: 'object', properties: { pattern: { type: 'string', description: '可选：按子串过滤变量名（大小写不敏感）。' } } }` |
| output.schema | `{ type:'object', properties:{ items:{ type:'array', items:{ type:'object', properties:{ name:{type:'string'}, note:{type:'string'}, masked:{type:'string'}, hasValue:{type:'boolean'} }, additionalProperties:true } } }, additionalProperties:true }` |
| execute 返回 | `{ items: [{ name, note, masked, hasValue }] }` —— **无 `value` 字段** |

**`masked` 的构造**：照 `collectManaged`（`:454-471`）的既有做法，
**只暴露长度信息**，不暴露任何字符。建议形如 `'•'.repeat(Math.min(len, 12))`
（或直接沿用页面语义：`''` 时回 `''`）。**严禁**回 `value.slice(0, 2) + '…'` 之类带真实字符的掩码。

**数据来源**：以 `readDocument(filePath)` 为唯一事实来源（即只看文件里定义过的变量）。
`note` 直接取文件里的备注。

**过滤**：`pattern` 非空时做 `name.toLowerCase().includes(pattern.toLowerCase())`。
**顺带说明**：本工具**不读 `process.env`**，只列白名单内变量 ——
因为 `collectManaged` 会把宿主的 `DSH_*` 也列进来，而工具侧没有理由暴露
非白名单变量的存在与长度。这是**比 `/list` 更严的**选择，符合「最小暴露」原则。

### D3. 工具二：`env_param_get`

**用途**：取明文。**这是唯一会泄漏值的出口，安全属性全在这里。**

| 项 | 值 |
|---|---|
| name | `env_param_get` |
| parameters | `{ type:'object', properties:{ name:{ type:'string', description:'环境变量名（必填）。' } }, required:['name'] }` |
| output.schema | `{ type:'object', properties:{ name:{type:'string'}, value:{type:'string'}, note:{type:'string'} }, additionalProperties:true }` |
| execute 返回 | `{ name, value, note }` |

**逻辑顺序（不许调整）——「先判白名单、再取值」**：

```
1. 取 name，校验类型与非空；不合法 → 抛错（错误信息不含任何值）
2. NAME_PATTERN 校验；不合法 → 抛错
3. ★ 每次调用重新 readDocument(filePath) —— 不缓存白名单
4. ★ name 不在 doc.expose 中 → 抛错，且错误信息不得包含该变量的任何值片段
5. name 不在 doc.variables 中 → 抛「未配置」错（仍未取值，无泄漏面）
6. ★ 通过以上全部检查，才读取 entry.value 并返回明文
```

**第 3、4 步是本任务的核心安全属性**，实现要点：

- **绝不**用模块级变量缓存 expose 集合，也**绝不**在 `apply()` 里读一次存起来。
  必须每次调用都 `readDocument(filePath)`。
  理由：用户从白名单撤销授权后，**下一次工具调用必须立即失效**，
  不能等到插件重载或进程重启。这是撤销语义能否成立的分界线。
- 第 4 步的**拒绝信息必须完全不含值**，包括**长度**与**首尾字符**。
  正确写法：

  ```js
  throw new Error('变量 ' + name + ' 未授权读取，请先在 dsh-settings-params 插件页开启「允许模型读取」。');
  ```

  错误示范（**严禁**）：`'未授权：值 ' + entry.value.slice(0,4) + '… 不可读'`。

- 抛错即可：注册表会把它渲染成 `Error: <message>` 的 text block（§A2 实测），
  且 `render` 不会被调用，所以未授权路径上**根本不会构造 canonical 值**。

### D4. 工具注册

```js
ctx.effect(() => ctx.tools.register(envParamListDef), 'dsh-settings-params: env_param_list tool');
ctx.effect(() => ctx.tools.register(envParamGetDef), 'dsh-settings-params: env_param_get tool');
```

并在 `export const inject` 中加 `'tools'`（见 §A3）。

### D5. 路由 `POST /expose`

| 项 | 值 |
|---|---|
| path | `/dsh-settings-params/expose` |
| 请求体 | `{ name: string, exposed: boolean }` **或** `{ keys: string[] }`（整表替换） |
| 返回 | `{ ok, expose: string[], count, message }` —— **不含任何明文** |

行为：

1. `isTrustedPost(request)` 校验，失败 403；
2. `readJsonBody`；
3. `readDocument(filePath)` 拿到当前 `doc`；
4. 按请求算出新的 expose 集合，**一律经 `sanitizeExpose` 收敛**：
   - `{ name, exposed }` 形式：`exposed === true` 时加入（先校验 `NAME_PATTERN`），否则移除；
   - `{ keys }` 形式：直接 `sanitizeExpose(body.keys)` 整表替换；
5. `atomicWrite(filePath, serializeYamlDocument(doc.variables, doc.targets, nextExpose))`；
6. 回 `{ ok: true, expose: nextExpose, count: nextExpose.length, message }`。

**注意**：
- 只改 `expose`，**不得触碰 `variables` 与 `reload.targets`**；
- **不调用 `syncFromFile()`** —— expose 只影响工具读取授权，与 `process.env` 注入无关，
  不能顺手改动注入轨道；
- 不用回传任何变量的值（本路由根本不需要读值）。

### D6. `GET /list` 追加 `expose` 字段

在现有响应对象（`lib/index.js:996-1007`）里**追加**一个键：

```js
expose: doc.expose,
```

**硬约束：既有键一个都不能动、不能删、不能改名**（`ok` / `file` / `legacyFile` /
`migrated` / `variables` / `targets` / `profileDir` / `depCount` / `whitelist` / `bootInjected`）。

### D7. 不得触碰的部分

- **不改** `EnvLedger`（`:886-945`）与其调用点；
- **不改**启动灌入逻辑（`:968-977`）与 `syncFromFile`（`:987`）；
- **不写** `process.env`（本任务全程只读，不回写）；
- **不新增** `package.json` 的 dependencies；
- **不触碰** `~/.dsh/profiles/` 下的任何文件，不重装插件。

---

## E. 客户端规格（`client/client.js`）

### E1. 每行加「允许模型读取」开关

在现有「参数设置」页的变量行（`.sp-row`）上加一个开关，**默认关**。

- 复用现有 `.sp-*` 样式与平台 `Tooltip`（`client/client.js:26-31` 已有惰性获取写法，
  `primitives.Tooltip` 不可用时降级为 `null`）；
- 开关状态来自 `/list` 新增的 `expose` 字段（`expose.includes(v.key)`）；
- 切换时 `POST /expose`，成功后用返回值刷新本地状态。

**权限边界**：只有「文件中定义」（`source === 'file'`）的变量才显示开关。
`source === 'host'` 的变量不在本页管理范围内，没有可写的地方，
显示开关会误导用户以为开了就能读。

### E2. 开关旁必须有明确风险提示（**硬门槛，三件事缺一不可**）

文案必须同时说明：

1. 明文会进入**模型上下文**（即会被发送给上游模型服务，可能被其记录）；
2. 明文会留在**本次会话的对话记录/日志**中；
3. 因此**高敏感密钥不建议开启**。

**推荐实现**：`Tooltip` 承载完整三点（悬浮/聚焦可见，不占版面），
开关旁同时保留一行极简的常驻小字，避免用户根本不 hover 就开启。

- **Tooltip 全文（建议）**：

  > 开启后，模型与子代理均可通过 env_param_get 读取该变量的**明文**。
  > 注意三点：① 明文会进入**模型上下文**，即会被发送给上游模型服务，可能被其记录；
  > ② 明文会留在**本次会话的对话记录与日志**中，可被回看和导出；
  > ③ 因此**高敏感密钥不建议开启**。仅在确需让模型使用该值时才打开。

- **行内常驻小字（建议）**：`模型可读明文（会进入模型上下文与会话记录）`

**措辞红线**：不得使用「安全读取」「加密」「仅本机可见」等**会让用户低估风险**的表述。
不得把「会进入对话记录」写成次要补充 —— 三点必须同等显著。

### E3. 客户端实现约束

- 只用 `require` **平台 seed 表内**模块（`react`、`@deepseek-ai/dsh-client-ui-primitives` 等）
  + 运行时 `try/catch` 兜底，本文件现有写法即范例（`client/client.js:8`、`:28`）；
- **不得新增 package.json dependencies**；
- 不引入任何表外模块（会导致整页 `Failed to load plugins`）。

---

## F. 验收与自测（task-2 必须逐条真实执行并贴输出）

### F1. 必须实测的项

| # | 验收项 | 方法 | 通过标准 |
|---|---|---|---|
| 1 | 未授权必被拒 | 对**不在** expose 的变量调用 `env_param_get` | 抛错，返回 `isError: true` |
| 2 | 拒绝信息不泄漏值 | 检查错误文本 | **逐字符**确认不含真实值的任何片段（含长度、首尾字符） |
| 3 | 授权后可读 | 加入 expose 后再调用 | 返回正确明文与 note |
| 4 | **撤销后立即失效（证明不缓存）** | 授权→读成功→撤销→**立即**再读 | 第二次必须失败，且未重载插件 |
| 5 | `node --check` | 对两个改动文件执行 | 均通过 |
| 6 | 宿主模块可加载 | `import()` 该 `lib/index.js` | 成功，导出 `apply` / `inject` / `name` |
| 7 | `/list` 向后兼容 | 对比改动前后键集合 | 既有键**全部保留**，仅新增 `expose` |
| 8 | 旧文件兼容 | 用无 `expose` 的 params.yml | 正常读取，expose 为 `[]`，不崩溃 |
| 9 | 非法 expose 安全降级 | 手写非数组/非法名/超长/重复 | 全部被丢弃，不崩溃、不放行 |
| 10 | 回归：注入轨道 | 检查 `EnvLedger` 行为 | 未被改动，variables 仍正常注入 |

### F2. 环境限制（**必须如实说明**）

运行中的 3080 端口加载的是 **profile 安装副本**
（`~/.dsh/profiles/web/node_modules/dsh-settings-params/`），
**工作区改动不会自动生效**。

因此自测采用**独立加载**方式：自行构造最小上下文（真实 `Context` + `SystemPrompt` +
`ToolsRuntime`），直接把工作区的 `lib/index.js` 的辅助函数与工具定义**按真实代码驱动**，
从而验证逻辑本身。若要**真机端到端**验证，需要重装插件 —— **本任务不做**（用户已禁止）。

`client/client.js` 的 UI 效果**无法在独立加载中验证**，只能做静态核对
（`require` 是否表内、开关渲染分支、文案是否三点齐全），并如实说明这一限制。

### F3. 测试数据规范（**安全要求**）

- **真实值 `DSH_SQL_PASSWORD_OPENCROWD` 的值绝不出现在任何测试脚本、注释、
  示例或落盘文件中**，报告中也不出现；
- 常规测试使用**临时假值**（建议变量名 `DSH_TEST_FAKE`，值用明显的假串如 `fake-value-123`）；
- 仅在「证明拒绝路径不泄漏真实值」这一项上，用真实值做**对比断言**
  （例如：断言错误文本中 `!error.includes(realValue)`，且不打印该值本身），
  **且不落盘**；
- 临时脚本一律 **stdin 直通**（`node --input-type=module <<'EOF'`），不写 `/tmp` 文件。

---

## G. 文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `packages/dsh-settings-params/SPEC-env-param-tools.md` | **新增**（task-1 产出，即本文档） | 规格 |
| `packages/dsh-settings-params/lib/index.js` | 修改（task-2） | 常量、YAML 读写、两工具、两路由 |
| `packages/dsh-settings-params/client/client.js` | 修改（task-2） | 开关 + 风险提示 |

**不新增任何其他文件**（一次性脚本不落盘）。
