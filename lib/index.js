/**
 * dsh-settings-params —— 「参数设置」页的宿主半身。
 *
 * 页面挂在**本插件自己的 bundle 详情页**（侧栏「插件」→ dsh-settings-params）。
 *
 * 把环境变量集中到一个 YAML 文件（`~/.dsh/.dsh-settings-params/params.yml`）管理，每个变量
 * 有三个字段：`value`（值）、`note`（备注）。文件形如：
 *
 * ```yaml
 * variables:
 *   DSH_SQL_PASSWORD_OPENCROWD:
 *     value: "secret"
 *     note: 生产库密码
 * reload:
 *   targets:
 *     - dsh-sql
 * ```
 *
 * 提供六条同源路由：
 *
 *  - `GET  /list`    列出已配置变量（**值一律掩码**，只回是否已设置与长度）、
 *                    可勾选的重载目标（白名单候选）与当前白名单、当前读取授权
 *  - `POST /set`     新增或更新一个变量（写文件 + 注入 `process.env`）
 *  - `POST /unset`   删除一个变量（从文件移除 + `delete process.env.X`）
 *  - `POST /reload`  从文件重新灌入 `process.env`；可顺带重载白名单插件
 *  - `POST /apply`   保存白名单并按白名单热重载（页面主按钮）
 *  - `POST /expose`  设置「允许模型读取」授权（只改文件，不碰 `process.env`）
 *  - `POST /restart` 重启宿主进程（最后的兜底手段）
 *
 * ## 面向模型的两个工具：env_param_list / env_param_get
 *
 * 背景：DSH 在 spawn 子进程时会**剥离凭证形态的环境变量**（`DSH_` 前缀，或匹配
 * `/KEY|PASSWORD|SECRET|TOKEN/i`，见 `@deepseek-ai/dsh-subprocess` 的
 * `scrubbedParentEnv()`）。因此 `DSH_SQL_PASSWORD_OPENCROWD` 这类变量虽然被本插件
 * 写进了宿主 `process.env`，子代理的 bash 里却是空的。官方注释写明这是刻意设计：
 * 「隐式继承被禁，显式提供放行」。
 *
 * 工具调用正是「显式提供」的那条路 —— 它是宿主进程内的函数调用，**不经过 spawn**，
 * 因此不受剥离影响，主代理与子代理都能读到值。
 *
 * 授权由 params.yml 顶层的 `expose` 列表决定（默认空 = 不可读）。关键安全属性：
 *
 *  - **先判白名单、再取值** —— 未授权时连值都不读进内存；
 *  - **每次调用重新读文件**，白名单**不缓存** —— 撤销授权后下一次调用立即失效；
 *  - 拒绝信息**不含值的任何片段**（含长度与首尾字符）；
 *  - 文件缺失或损坏时降级为「无任何授权」，绝不放宽。
 *
 * 固有代价：`env_param_get` 返回的明文会进入**模型上下文**（会被发送给上游模型
 * 服务）并留在**本次会话的对话记录**中。这一点无法通过实现消除，只能如实告知，
 * 故页面开关旁给出了三点风险提示。高敏感密钥不建议开启授权。
 *
 * ## 环境变量归属：谁写的，才由谁清理
 *
 * `process.env` **不是 cordis 托管的资源**，官方虽要求「非托管资源必须显式
 * 清理」（见 develop/framework「自动清理机制」），但清理的**范围**必须由插件
 * 自己定义清楚。本插件只对自己**实际写入过**的键有处置权：
 *
 *  - 卸载时只清「本插件写过、且当前值仍等于本插件写下的值」的键 —— 若值已被
 *    他人改写，说明归属已转移，本插件不再触碰；
 *  - 绝不 `delete` 一个本插件没写过的 `DSH_*` 键（那是宿主或其他插件的变量）。
 *
 * 早期实现用「加载前快照 + 卸载时回卷」来处理，在 **HMR / 重载**场景下会把
 * 自己上次写进去的真值当成「宿主的旧值」存档，卸载时执行 `delete` 反而把真值
 * 抹掉（文件里值还在，进程里却空了）。改为「记账式清理」后该问题从根上消失，
 * 因为清理依据是「本次写过哪些键」，而非对历史状态的猜测。
 *
 * ## 持久化：为什么卸载重装不丢配置
 *
 * 数据文件放在 `~/.dsh/.dsh-settings-params/params.yml`，**在插件包目录之外**。
 * 插件代码位于 `~/.dsh/profiles/<name>/node_modules/<pkg>`，可被随意卸载重装，
 * 而数据文件与之无关，因此重装后 `apply()` 立刻读回原有配置（含白名单）。
 *
 * ## 「保存」与「生效」是两件事
 *
 * `process.env` 是**可写**的，赋值立即对「每次调用时读 env」的插件生效。
 * 但有些插件在**加载时解析一次配置**就固化快照，之后不再回头看 env ——
 * dsh-sql 即属此类（`apply()` 里 `resolveConfig(config)` 把密码读成字符串
 * 交给 `buildSqlTools`，此后连接参数不再变）。
 *
 * 对这类插件，本插件提供**白名单热重载**：用 cordis 官方原语
 * `fiber.restart()`（"Dispose and immediately reload this plugin with its
 * current config"）让目标插件重跑 `apply()`，从而重新读取 `process.env`。
 *
 * 这一点**与插件加载顺序无关**：靠 `ctx.loader.entries()` 按条目名定位，
 * 而不是靠「希望我先于它加载」。因此对任何用户、任何安装顺序都成立。
 *
 * **但要真正成立，必须有人去调用它 —— 启动路径也需要**。这里曾有一个缺陷：
 * 白名单只在 `/set` 与 `/apply` 两个手工时机被消费，`apply()` 启动时只注入
 * env、不读白名单。于是宿主每次重启后，排在后面的快照型插件又按加载顺序抢跑，
 * 读到尚未注入的空值（症状：`Access denied ... (using password: NO)`），
 * 用户必须去页面点一次「保存」才恢复。现由 {@link scheduleBootReload} 补上
 * 启动路径：轮询等待目标就绪后自动重载一次，不依赖任何时序假设。
 *
 * ## 设计边界：本插件**不推断**任何插件需要哪些环境变量
 *
 * 用户的模型是**两步声明**，本插件只负责执行：
 *  1. 用**白名单**（`reload.targets`）声明「这个插件要参数」；
 *  2. 用 **`variables`** 声明「具体哪些参数、值是什么」。
 *
 * 本插件要做的只有一件事：**按白名单放行，把 `variables` 注入 `process.env`**
 * （`ledger.setOne`）。若用户配错或漏配，那是用户与插件文档之间的事 ——
 * 「即使配错那是用户的事情」。
 *
 * 因此代码里**不存在**任何「读第三方插件包、猜它要哪些变量」的路径。历史上有过
 * 两版推断，都已被**设计裁决删除**，不要重新引入：
 *  - **扫描层**：读插件 `package.json` 的 `main`/`exports`，扫其运行时入口里的
 *    `process.env.X` 字面量。代价高昂（实测 `@xmanrui/dsh-im` 是 8.3 MB bundle、
 *    单行 227 万字符，需缓存/超时/路径校验），且新增了真实攻击面（包目录被符号
 *    链接到外部时的越界读取）；对**动态拼接**的变量名（`dsh-sql` 的
 *    `env[passwordEnvName(name)]`）原理上永远扫不到。
 *  - **登记层**：解析 dsh-sql 的 `config.connections` 反推
 *    `DSH_SQL_PASSWORD_<连接名>`。范围小，但仍是同一类越界 —— 它读的是插件在
 *    `cordis.patch.yml` 里的配置，而不是用户在 `params.yml` 里定义的参数。
 *
 * 「猜变量名」唯一服务的目的是详情页显示「还缺哪几个」，而这个信息**用户本来
 * 就知道**（他照着插件文档配的）。为纯展示目的承担上述代价，不划算也越界。
 * 详情页现在只如实展示「该插件已在放行名单中」这一**已知事实**。
 *
 * ## 参数名的唯一性
 *
 * 用户要求「不能出现同名参数」。`variables` 在 YAML 里是一个**映射**，映射的键
 * 天然不可重复 —— 同名参数在结构上就无法存在，因此**无需额外校验**。
 *
 * 实测（本文件的解析器，手写重复键的四种写法）：`variables` 始终只有 **1 条**
 * 该名字的记录，同名键会**收敛到同一个槽位**（`Map` 天然如此），字段按出现
 * 顺序填充 —— 即 `A: "v1"` 后跟 `A: "v2"`，结果是一条记录、`value` 为最后
 * 出现的那个。这与 YAML 规范一致：重复键本就是非法的，用户不该这么写；
 * 而我们的行为是**不崩溃、不产生两条冲突记录**，属可接受的安全行为。
 *
 * ## 为什么不用 `yaml` 包
 *
 * profile 的 pnpm-lock 显示本包依赖集为空、且不装本地 node_modules。直接
 * `import 'yaml'` 只能靠 node 向上查找命中「DSH 全局安装目录里的 yaml」——
 * 那是未声明依赖，DSH 换安装方式就会 `ERR_MODULE_NOT_FOUND`。故此处自带一个
 * 只覆盖本文件格式的极简 YAML 读写器，零依赖、任何环境都能跑。
 *
 * ## 安全边界
 *
 *  - 文件权限固定 0600，仅当前用户可读写；
 *  - **值永不回传浏览器**，`/list` 只回 `masked` 占位与 `hasValue`；
 *  - 变量名限定 `[A-Za-z_][A-Za-z0-9_]*`，防注入非法 shell 标识符；
 *  - 仅接受同源 POST，挡住浏览器第三方页面的 CSRF。
 *
 * @module dsh-settings-params
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** cordis 插件名。 */
export const name = 'dsh-settings-params';

/**
 * 路由挂载前必须等 webServer 就绪；loader 用于白名单热重载。
 *
 * 声明 `loader` 依赖可确保 `ctx.loader` 在 `apply()` 内可用，而不是靠
 * 「碰巧先加载了 loader」——这正是本插件此前依赖隐式时序的根源。
 */
export const inject = ['webServer', 'loader', 'tools'];

/**
 * 参数文件的默认路径（YAML）：`~/.dsh/.dsh-settings-params/params.yml`。
 *
 * 放在**本插件的专有目录**里。此前它直接躺在 `~/.dsh/` 根目录，既与用户的
 * 其它文件混在一起，卸载时也无法随插件一起清理。
 *
 * 目录名用 `.dsh-settings-params`（点前缀），与 `~/.dsh-restart-autostart/` 同一
 * 风格 —— 点前缀把「插件私有数据」与用户自己放在 `~/.dsh/` 下的东西区分开。
 *
 * ⚠️ 路径变更靠 `migrateToPluginDirIfNeeded()` 自动完成，用户无需手工搬动。
 */
const DEFAULT_FILE = join(homedir(), '.dsh', '.dsh-settings-params', 'params.yml');

/**
 * 上一个布局的位置：`~/.dsh/dsh-settings-params/params.yml`（无点前缀）。
 *
 * 这个目录只存在过很短一段时间（连同本次改名一起），但仍要在迁移里认它 ——
 * 否则已经搬到那里、且还没重启的用户会在升级后被当成"没有数据"，参数凭空
 * 消失。迁移顺序：本路径 → `DEFAULT_FILE`。
 */
const INTERMEDIATE_FILE = join(homedir(), '.dsh', 'dsh-settings-params', 'params.yml');

/**
 * 最初的布局：`~/.dsh/params.yml`（直接躺在根目录）。
 *
 * 只用于「首次升级时把文件搬到专有目录」，以及判断「用户是否又在旧位置
 * 手工建了文件」（那说明他的修改不会生效，界面要提示）。
 * 这个文件**永不删除** —— 迁移只把它改名成 `.bak-<时间戳>` 留档。
 */
const PREVIOUS_FILE = join(homedir(), '.dsh', 'params.yml');

/** 旧版 env 文件路径：仅在首次迁移时读取一次。 */
const LEGACY_FILE = join(homedir(), '.dsh', 'params.env');

/** 变量名合法性：必须是合法 shell 标识符，杜绝注入与歧义。 */
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 变量名长度上限。 */
const NAME_MAX = 128;

/** 变量值长度上限（防止前端误贴超长内容撑爆文件）。 */
const VALUE_MAX = 8192;

/** 备注长度上限。备注只是给人看的说明，无需容纳长文本。 */
const NOTE_MAX = 200;

/** 白名单条目（插件条目名）长度上限。 */
const TARGET_MAX = 200;

/** 白名单最多条目数，避免把整棵插件树都塞进去。 */
const TARGET_LIMIT = 64;

/** 允许模型读取的变量条数上限，避免把整份文件都授权出去。 */
const EXPOSE_LIMIT = 64;

/**
 * 判断宿主环境里的某个变量是否值得**顺带展示**在本页。
 *
 * ## 为什么这里不是「准入校验」
 *
 * 用户**能定义**哪些变量由 `validatePair` 决定（只要名字合法即可，见那里的
 * 说明）。本函数只用于一件事：从宿主 `process.env` 里捞出「用户可能关心的」
 * 同名变量，让页面能显示它们已存在于进程环境（`source: 'host'`）。
 *
 * 之所以要过滤，是因为宿主环境有几百个变量（`PATH`、`HOME`、
 * `SSH_AUTH_SOCK`…），全量展示既是噪声也是信息泄露。这里按**前缀**粗筛，
 * 属于展示层的取舍，**不是安全边界** —— 真正的边界在 `/set` 的名字校验与
 * `expose` 授权上。
 * @param key - 环境变量名。
 * @returns 是否属于本页的展示范围。
 */
function isManagedName(key) {
  return key.startsWith('DSH_') || key.startsWith('OPENCROWD_');
}

/**
 * 不允许用户从页面定义的**危险变量名**（大小写不敏感）。
 *
 * ## 为什么需要这张表
 *
 * 放宽前缀限制后（见 `UNSAFE_ENV_NAMES` 与 `validatePair`），用户可以为任意合法名定义变量，而
 * 本插件会把它们写进宿主的 `process.env`。绝大多数名字无害，但下面这些能
 * **改变进程自身的行为**：
 *
 *  - `PATH` / `PATHEXT`：可执行文件查找路径 → 劫持后续任何子进程调用；
 *  - `NODE_OPTIONS`：Node 启动参数 → 可注入 `--require` 加载任意代码；
 *  - `LD_PRELOAD` / `LD_LIBRARY_PATH` / `DYLD_INSERT_LIBRARIES` /
 *    `DYLD_LIBRARY_PATH`：动态库预加载/搜索路径（Linux/macOS）→ 同样是代码执行；
 *  - `NODE_PATH` / `PYTHONPATH`：模块解析路径 → 可让 `require`/`import`
 *    命中伪造模块；
 *  - `BASH_ENV` / `ENV` / `ZDOTDIR`：shell 启动时会 source 的文件或目录 →
 *    等价于让 shell 先执行一段任意脚本；
 *  - `PERL5OPT` / `RUBYOPT`：解释器启动参数 → 可加载任意模块/代码；
 *  - `GCONV_PATH`：glibc 已知的提权原语（动态加载伪造的字符集转换模块）；
 *  - `HOME` / `PWD`：会改变插件与工具对"用户目录/当前目录"的判断；
 *  - `DSH_HOME`：DSH 自身的数据目录，改写会让它读写错位置。
 *
 * 这些名字的危害与"前缀正不正当"无关，纯粹是**代码执行原语**，因此单列一张
 * 小表挡掉。
 *
 * ## 这张表的定位：**示例性门槛**，不是安全边界、也不追求穷尽
 *
 * 收录标准是「**设一次就可能任意代码执行**」。但必须说清一件事：**这类原语
 * 无法列全**（符合该标准的原语多于本表所收，属预期，不是遗漏）—— 每个语言/
 * 运行时都可能有一族（`NODE_PATH`/`PYTHONPATH`/`CLASSPATH`/`LUA_PATH`/
 * `PERL5LIB`/`RUBYLIB`…，解释器选项族更是开放集合）。曾一度把标准写成
 * 「同类齐备」，结果每补一批就立刻能找出新的同类漏项 —— 这说明**用枚举去
 * 满足「齐备」是做不到的**。
 *
 * 因此本表的**真实定位**是：把最广为人知的那批原语从"页面上一顺手就能设"
 * 变成"必须显式去编辑文件"，提高误操作与随手滥用的门槛，**如此而已**。
 * 真正的安全边界不在这里，而在：
 *  - `expose` 授权（模型能否读到明文）与同源 POST 校验；
 *  - 以及**用户本人的判断** —— 手工编辑 `params.yml` 写入任何名字都不受本表
 *    限制，这是既有行为，也是刻意的（那是用户对自己的环境负责）。
 *
 * **刻意不收录**（那会变成另一种"替用户判断"，与用户的设计原则冲突）：
 *  - `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 等：**配代理是正常需求**；
 *  - `NODE_TLS_REJECT_UNAUTHORIZED`：用户降低自己的安全标准，不同量级；
 *  - `TMPDIR`/`SHELL`/`IFS`/`SSH_AUTH_SOCK` 等：只在特定子进程上下文起作用，
 *    不是"设一次就任意执行"，且用户常有正当理由改。
 *
 * 挡的方式是**拒绝**（返回 400 并说明原因），而不是静默忽略 ——
 * 静默忽略会让人以为设置成功了。
 *
 * 注：用户手工编辑 `params.yml` 仍可写入这些名字（启动注入不做名字过滤，
 * 那是既有行为）。本表只约束**页面**这条路径，目的是不让 UI 把它变成一件
 * 顺手就能做的事。
 */
const UNSAFE_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH', 'GCONV_PATH',
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'PERL5OPT', 'RUBYOPT',
  'HOME', 'PWD', 'DSH_HOME',
]);

/**
 * 把 YAML 标量文本还原为 JS 字符串。
 *
 * 支持 serializeYaml 写出的两种形态：
 *  - 双引号包裹（含 `\\` `\"` `\n` 转义）—— 写入时一律采用，最保险；
 *  - 单引号包裹（`''` 表示一个单引号，YAML 原生规则）；
 *  - 裸标量 —— 去掉行尾注释（` #` 起）后原样返回。
 * @param raw - 冒号之后的原始文本。
 * @returns 还原后的字符串。
 */
function parseYamlScalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    // 找收尾引号：跳过被转义的双引号。
    let out = '';
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else out += next ?? '';
        i += 1;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  if (text.startsWith("'")) {
    let out = '';
    for (let i = 1; i < text.length; i += 1) {
      if (text[i] === "'" && text[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      if (text[i] === "'") break;
      out += text[i];
    }
    return out;
  }
  // 裸标量：剥掉「空白 + #」起的行尾注释。
  const cut = text.search(/\s#/);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

/**
 * 把字符串序列化为 YAML 双引号标量。
 *
 * 一律用双引号并转义，避免值里的 `:`、`#`、前导空格、`true`/`null` 之类
 * 被 YAML 当成结构或布尔值。换行用 `\n` 转义，保证一条变量占一行。
 * @param value - 待序列化的字符串。
 * @returns YAML 标量文本。
 */
function toYamlScalar(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return '"' + escaped + '"';
}

/**
 * 解析本插件的 YAML 文件。
 *
 * 刻意只实现本文件需要的子集（两层缩进的映射 + 一层序列），因为：
 *  - 文件由本插件自己写出，形状已知；
 *  - 手改场景只需覆盖这几个字段，遇到无法理解的行就跳过，不会误伤。
 *
 * 识别的结构：
 * ```yaml
 * variables:
 *   KEY:
 *     value: "..."
 *     note: "..."
 * expose:
 *   - KEY
 * reload:
 *   targets:
 *     - dsh-sql
 * ```
 * @param text - 文件内容。
 * @returns `{ variables: Map<键, {value, note}>, targets: string[], expose: string[] }`。
 */
function parseYamlDocument(text) {
  const variables = new Map();
  const targets = [];
  const expose = [];
  let section = '';
  let currentKey = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    // 顶层 section：`variables:` / `reload:`
    if (indent === 0) {
      const top = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
      section = top ? top[1] : '';
      currentKey = '';
      continue;
    }

    if (section === 'variables') {
      // 变量名行：缩进 2，形如 `KEY:`
      if (indent <= 2) {
        const m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
        if (!m) {
          currentKey = '';
          continue;
        }
        currentKey = m[1];
        if (!variables.has(currentKey)) variables.set(currentKey, { value: '', note: '' });
        // `KEY: "value"` 单行写法（手改时可能出现）
        if (m[2].trim() !== '') variables.get(currentKey).value = parseYamlScalar(m[2]);
        continue;
      }
      // 字段行：缩进 >= 4，形如 `value: "x"`
      if (currentKey === '') continue;
      const f = body.match(/^(value|note)\s*:\s*(.*)$/);
      if (!f) continue;
      const entry = variables.get(currentKey);
      if (!entry) continue;
      if (f[1] === 'value') entry.value = parseYamlScalar(f[2]);
      else entry.note = parseYamlScalar(f[2]);
      continue;
    }

    if (section === 'expose') {
      // `expose:` 之后的 `- NAME` 序列项（形状与 reload.targets 相同）。
      // 非法变量名在此不判定，统一交给 sanitizeExpose 收敛 —— 保持「解析」与
      // 「校验」分离，避免两处规则漂移。
      if (body.startsWith('- ')) {
        const item = parseYamlScalar(body.slice(2));
        if (item !== '' && expose.length < EXPOSE_LIMIT) expose.push(item);
      }
      continue;
    }

    if (section === 'reload') {
      // `targets:` 之后的 `- name` 序列项
      if (body.startsWith('- ')) {
        const item = parseYamlScalar(body.slice(2));
        if (item !== '' && targets.length < TARGET_LIMIT) targets.push(item);
      }
      continue;
    }
  }

  return { variables, targets, expose };
}

/**
 * 把变量与白名单序列化为 YAML 文本。
 * @param variables - 键 → `{ value, note }`。
 * @param targets - 白名单插件条目名数组。
 * @param expose - 允许模型读取明文的变量名数组。
 * @returns 文件文本（含头部注释）。
 */
function serializeYamlDocument(variables, targets, expose) {
  const lines = [
    '# dsh-settings-params 管理的环境变量与热重载白名单。',
    '# 由 dsh-settings-params 插件页写入，也可手工编辑后用页面上的「重新加载」按钮载入。',
    '# 本文件位于插件目录之外，卸载/重装插件不会丢失配置。',
    '',
  ];

  if (variables.size === 0) {
    lines.push('variables: {}');
  } else {
    lines.push('variables:');
    for (const [key, entry] of variables) {
      lines.push('  ' + key + ':');
      lines.push('    value: ' + toYamlScalar(entry.value ?? ''));
      lines.push('    note: ' + toYamlScalar(entry.note ?? ''));
    }
  }

  // expose 段：授权模型（含子代理）通过 env_param_get 读取这些变量的**明文**。
  // 默认空 —— 不写进文件的变量一律不可读，这是本插件唯一的授权来源。
  lines.push('');
  lines.push('# 允许模型（含子代理）通过 env_param_get 读取明文的变量名，默认空。');
  lines.push('# 开启后明文会进入模型上下文与本次会话的对话记录，高敏感密钥不建议开启。');
  const exposeList = Array.isArray(expose) ? expose : [];
  if (exposeList.length === 0) {
    lines.push('expose: []');
  } else {
    lines.push('expose:');
    for (const key of exposeList) lines.push('  - ' + toYamlScalar(key));
  }

  lines.push('');
  lines.push('# 保存后需要热重载的插件条目名（这些插件只在启动时读一次环境变量，');
  lines.push('# 改完参数需让它们重跑一次 apply()，或重启服务）。');
  if (targets.length === 0) {
    lines.push('reload:');
    lines.push('  targets: []');
  } else {
    lines.push('reload:');
    lines.push('  targets:');
    for (const target of targets) lines.push('    - ' + toYamlScalar(target));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 旧版 `.env` 格式解析（仅用于一次性迁移）。
 *
 * 语法：每行 `KEY=VALUE`，值后可追加 `  # 备注`；值两侧成对引号会被剥掉。
 * 切分顺序很关键：**先按引号状态定位行内注释、再剥引号还原转义**。若反序，
 * `B="p@ss # word"` 这种值内含 `#` 的变量会被从中间切坏。
 * @param text - 旧文件内容。
 * @returns 键 → `{ value, note }`。
 */
function parseLegacyEnv(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!NAME_PATTERN.test(key)) continue;

    const body = line.slice(eq + 1).trim();
    let cut = -1;
    let quote = '';
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i];
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (quote === '') {
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '#' && (i === 0 || /\s/.test(body[i - 1]))) {
          cut = i;
          break;
        }
      } else if (ch === quote) {
        quote = '';
      }
    }
    const note = cut >= 0 ? body.slice(cut + 1).trim() : '';
    let value = (cut >= 0 ? body.slice(0, cut) : body).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        const inner = value.slice(1, -1);
        value = first === '"' ? inner.replace(/\\(.)/g, '$1') : inner;
      }
    }
    map.set(key, { value, note });
  }
  return map;
}

/**
 * 原子写入文件：先写同目录临时文件，再 rename 覆盖。
 *
 * 直接 truncate 写入存在「写一半崩溃 → 文件损坏 → 所有变量丢失」的窗口，
 * rename 在同一文件系统内是原子操作，可消除该窗口。
 * @param filePath - 目标文件路径。
 * @param text - 文件内容。
 */
function atomicWrite(filePath, text) {
  // 目录显式建成 0700：文件本身是 0600，但目录若宽松到 0755，同机其他用户
  // 仍能列目录、看到「有个 params.yml」并推测用途。umask 不可靠，显式设。
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirname(filePath), 0o700);
  } catch {
    /* 目录已存在且权限不符时尽力纠正；失败不阻断写入（例如非属主） */
  }
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, filePath);
}

/**
 * 首次运行时把旧 `params.env` 迁移为 `params.yml`。
 *
 * **旧文件用 rename 改成 `.bak-<时间戳>`，绝不删除**：迁移万一解析有误，
 * 用户手上的原始文件仍在。迁移失败时回退为「什么都不做」，让调用方以空配置
 * 继续，不阻断宿主启动。
 * @returns 迁移是否发生。
 */
function migrateLegacyIfNeeded() {
  if (existsSync(DEFAULT_FILE) || !existsSync(LEGACY_FILE)) return false;
  try {
    const legacy = parseLegacyEnv(readFileSync(LEGACY_FILE, 'utf8'));
    if (legacy.size === 0) return false;
    atomicWrite(DEFAULT_FILE, serializeYamlDocument(legacy, [], []));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(LEGACY_FILE, LEGACY_FILE + '.bak-' + stamp);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把参数文件从历史位置迁到本插件专有目录。
 *
 * 依次尝试两个历史位置（较新者优先）：
 *  1. `~/.dsh/dsh-settings-params/params.yml`（无点前缀目录，短暂存在过）；
 *  2. `~/.dsh/params.yml`（最初的布局，直接躺在根目录）。
 *
 * ## 为什么多一步「回读校验」（与上面那个迁移的关键差异）
 *
 * 上面搬的是 `.env` 格式，最坏情况是解析出来少几个变量；而这里搬的 YAML 里
 * **存着用户的明文密码**。所以本函数在写完之后必须证明「搬过去的东西和原来
 * 一模一样」才允许动旧文件 —— 校验不过就删掉刚写的新文件、旧文件原封不动，
 * 整体退回「什么都没发生」。
 *
 * ## 顺序与安全性
 *
 * 1. 新位置已有文件 → 直接返回（**幂等**，重复启动/重载都安全）；
 * 2. 旧位置没有文件 → 返回（全新安装，无旧数据可搬）；
 * 3. 旧文件读不出/解析为空 → 返回 false，**不碰旧文件**（宁可维持现状）；
 * 4. `atomicWrite` 写新位置（内部走 rename，无「写一半」窗口）；
 * 5. 回读新文件，逐项比对变量集合、白名单、expose 授权；
6. 全部一致 → 把旧文件改名为 `.bak-<时间戳>`（**绝不删除**）。
 *
 * 任何一步异常都被吞掉并返回 false：迁移失败不该阻断宿主启动，用户下次
 * 启动会再试一次。
 * @returns 是否发生了迁移。
 */
function migrateToPluginDirIfNeeded() {
  // 幂等：新位置已有文件就什么都不做（含「上次已迁移成功」与「用户新建」）。
  if (existsSync(DEFAULT_FILE)) return false;

  // 依次尝试两个历史位置。顺序有讲究：`INTERMEDIATE_FILE`（无点前缀目录）
  // 是较新的布局，若它存在说明用户已经搬过一次，只是路径又改了 —— 要以它
  // 为准；`PREVIOUS_FILE`（根目录）是最老的布局。
  for (const source of [INTERMEDIATE_FILE, PREVIOUS_FILE]) {
    if (relocateFrom(source)) return true;
  }
  return false;
}

/**
 * 把一份历史参数文件搬到 `DEFAULT_FILE`，成功则把源文件改名留档。
 *
 * 校验不过就删掉刚写的新文件、源文件原封不动 —— 整体退回「什么都没发生」。
 * @param source - 源文件路径。
 * @returns 是否搬迁成功。
 */
function relocateFrom(source) {
  if (!existsSync(source)) return false;
  try {
    const before = readDocument(source);
    // 空配置不值得搬；同时避免把「解析失败被吞成空文档」误当成有效数据。
    if (before.variables.size === 0) return false;

    // 先写新位置。内容原样沿用旧文件的文本，不做序列化往返 ——
    // 往返会丢掉用户手写的注释与格式，而这里的目标只是「换个位置」。
    const text = readFileSync(source, 'utf8');
    atomicWrite(DEFAULT_FILE, text);

    // 回读校验：确认搬过去的内容与源文件逐项一致。
    // 不一致 → 删除刚写的新文件，源文件保持原样，本次迁移作废。
    const after = readDocument(DEFAULT_FILE);
    if (!sameDocument(before, after)) {
      try { rmSync(DEFAULT_FILE, { force: true }); } catch { /* 删不掉也不致命 */ }
      return false;
    }

    // 校验通过，源文件改名留档（绝不删除）。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(source, source + '.bak-' + stamp);
    return true;
  } catch {
    return false;
  }
}

/**
 * 比较两份解析结果是否**等同**（用于迁移后的回读校验）。
 *
 * 比对变量名集合、每个变量的值与备注、白名单、expose 授权。值也参与比较 ——
 * 迁移场景下「名字对但值丢了」与「整个文件没搬」一样糟。
 * @param a - 迁移前解析结果。
 * @param b - 迁移后解析结果。
 * @returns 是否完全一致。
 */
function sameDocument(a, b) {
  if (a.variables.size !== b.variables.size) return false;
  for (const [key, left] of a.variables) {
    const right = b.variables.get(key);
    if (right === undefined) return false;
    if (left.value !== right.value) return false;
    if ((left.note ?? '') !== (right.note ?? '')) return false;
  }
  if (a.targets.length !== b.targets.length) return false;
  if (a.targets.some((t, i) => t !== b.targets[i])) return false;
  if (a.expose.length !== b.expose.length) return false;
  if (a.expose.some((t, i) => t !== b.expose[i])) return false;
  return true;
}

/**
 * 读取参数文件（含白名单与 expose 授权）。
 * @param filePath - YAML 文件路径。
 * @returns `{ variables: Map, targets: string[], expose: string[] }`；文件不存在或损坏时为空。
 */
function readDocument(filePath) {
  if (!existsSync(filePath)) return { variables: new Map(), targets: [], expose: [] };
  try {
    const parsed = parseYamlDocument(readFileSync(filePath, 'utf8'));
    // 只保留合法变量名，防止手改文件塞进非法标识符。
    for (const key of [...parsed.variables.keys()]) {
      if (!NAME_PATTERN.test(key)) parsed.variables.delete(key);
    }
    parsed.targets = sanitizeTargets(parsed.targets);
    parsed.expose = sanitizeExpose(parsed.expose);
    return parsed;
  } catch {
    // 文件损坏时**一律降级为「无任何授权」**，绝不放宽 —— 这是安全默认值。
    return { variables: new Map(), targets: [], expose: [] };
  }
}

/**
 * 规范化 expose 授权名单：去重、去空、限长限量，且**只接受合法变量名**。
 *
 * 与 sanitizeTargets 的唯一差别是多了 NAME_PATTERN 校验 —— expose 里的每一项
 * 都会成为工具读取明文的目标，非法条目一律**静默丢弃**（丢弃 = 不授权）。
 * 之所以不抛错：该函数的输入可能来自被手改坏的文件，此时正确的降级方向是
 * 「更少的授权」，而不是拒绝启动或放行。
 * @param input - 原始变量名数组。
 * @returns 规范化后的数组。
 */
function sanitizeExpose(input) {
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    const key = typeof item === 'string' ? item.trim() : '';
    if (key === '' || key.length > NAME_MAX) continue;
    if (!NAME_PATTERN.test(key)) continue;
    if (out.includes(key)) continue;
    out.push(key);
    if (out.length >= EXPOSE_LIMIT) break;
  }
  return out;
}

/**
 * 规范化白名单：去重、去空、限长限量。
 * @param input - 原始条目名数组。
 * @returns 规范化后的数组。
 */
function sanitizeTargets(input) {
  const out = [];
  for (const item of Array.isArray(input) ? input : []) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (name === '' || name.length > TARGET_MAX) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= TARGET_LIMIT) break;
  }
  return out;
}

/**
 * 读取当前受管的变量（文件中的定义 + 宿主进程中已存在的同类变量）。
 *
 * 两类来源分开标注：`source: 'file'` 表示由本页管理，`source: 'host'` 表示
 * 变量存在于宿主进程环境但不在此文件中（例如由启动脚本注入的），后者只读展示，
 * 提示用户「写入文件后即可接管」。
 * @param doc - 已解析的文件内容。
 * @returns 用于 /list 返回的精简描述数组（不含任何明文值）。
 */
function collectManaged(doc) {
  const result = new Map();
  for (const [key, entry] of doc.variables) {
    result.set(key, {
      key,
      hasValue: entry.value !== '',
      length: entry.value.length,
      note: entry.note ?? '',
      source: 'file',
    });
  }
  // 顺带捞出「宿主环境里已存在、且用户可能关心」的同名变量，标 source: 'host'。
  //
  // 过滤条件刻意用**前缀粗筛**（isManagedName）而非「用户定义过的名字」：
  // 后者会让用户永远看不到「我还没定义、但宿主里已经有了」的变量，而那正是
  // 他需要知道的信息（说明该名字已被别处占用，或不必再定义）。
  // 前缀粗筛保证不会把 PATH/HOME/SSH_AUTH_SOCK 这类系统变量倒进页面。
  for (const key of Object.keys(process.env)) {
    if (!isManagedName(key) || result.has(key)) continue;
    const value = process.env[key] ?? '';
    result.set(key, { key, hasValue: value !== '', length: value.length, note: '', source: 'host' });
  }
  return [...result.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 读取当前 profile 的 `package.json`，取出用户**显式装配**的插件名集合。
 *
 * 这是区分「用户插件」与「宿主内置插件」的**权威判据**：`dependencies` 里
 * 写着的才是用户主动装的；`@deepseek-ai/dsh-base` 等系统 bundle 会带进上百条
 * 内置插件，它们技术上可重载，但用户没有理由去重载 DSH 自己的内脏。
 *
 * 刻意**不用「包名前缀」判断**：前缀规则会误杀 —— 若官方将来发布一个
 * `@deepseek-ai/dsh-xxx` 让用户装配，前缀过滤就把它藏起来了。
 * @returns `{ deps: Set<string>, profileDir: string }`；读不到时集合为空。
 */
function readProfileManifest() {
  const deps = new Set();
  // 本插件位于 <profileDir>/node_modules/<pkg>/lib/index.js，上溯三层即 profileDir。
  const profileDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  try {
    const text = readFileSync(join(profileDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(text);
    for (const dep of Object.keys(parsed?.dependencies ?? {})) deps.add(dep);
  } catch {
    /* 读不到就退化为「全部算系统插件」，前端仍有搜索可用，不阻断功能 */
  }
  return { deps, profileDir };
}




/**
 * 判断某个插件条目名是否属于「用户显式装配的插件」。
 *
 * 条目名可能是包名的**上级路径**，需要双向包含匹配：
 *  - `@nanmicoder/dsh-agent-teams` 直接等于 dependency 名；
 *  - `dsh-sql/server` 这类子条目，父路径 `dsh-sql` 命中即可。
 * @param entryName - loader 条目名。
 * @param deps - 用户依赖名集合。
 * @returns 是否算用户插件。
 */
function isUserPlugin(entryName, deps) {
  if (deps.has(entryName)) return true;
  for (const dep of deps) {
    // 条目名是某个依赖的父路径（子条目）或反之。
    if (entryName.startsWith(dep + '/') || dep.startsWith(entryName + '/')) return true;
  }
  return false;
}

/**
 * 列出可被热重载的插件条目（供前端勾选白名单）。
 *
 * fiber 状态取值见 cordis `FiberState`：0 PENDING / 1 LOADING / 2 ACTIVE /
 * 3 FAILED / 4 DISPOSED / 5 UNLOADING。**只有 ACTIVE(2) 适合重载**，其余
 * 一律标为不可重载，与 /apply 的实际判定保持一致。
 *
 * 每条附带 `origin`：`user`（用户装配，默认展开）或 `system`（宿主内置，
 * 前端默认折叠）。判定依据是 profile 的 `dependencies`，见 readProfileManifest。
 *
 * **按条目名定位而非按加载顺序**，因此白名单对任意安装顺序都有效。
 * @param ctx - cordis 宿主上下文。
 * @returns 供前端渲染的目标数组。
 */
function listTargets(ctx) {
  const out = [];
  const { deps, profileDir } = readProfileManifest();
  try {
    for (const [entryName, group] of groupEntriesByName(ctx)) {
      // 不把自己列为可重载目标：重载自身会中断正在处理的这次请求。
      if (entryName === name) continue;
      // 同名条目里挑「运行中的」作为代表；其余仅用于标记歧义，不单独成条，
      // 否则同一个名字会在页面上出现多次且状态互相矛盾。
      const entry = pickRestartable(group);
      const fiber = entry.fiber;
      const state = fiber?.state;
      const restartable = typeof fiber?.uid === 'number' && state === 2;
      let label = 'unloaded';
      if (state === 2) label = 'active';
      else if (state === 3) label = 'failed';
      else if (state === 1 || state === 5) label = 'busy';
      else if (state === 4) label = 'disposed';
      else if (state === 0) label = 'pending';
      // 同名且至少有一个可重载 → 标记歧义，重载时若选错也不会静默发生。
      const ambiguous = group.length > 1;
      out.push({
        name: entryName,
        id: entry.id ?? entryName,
        state: label,
        restartable,
        ambiguous,
        duplicateCount: group.length,
        origin: isUserPlugin(entryName, deps) ? 'user' : 'system',
      });
    }
  } catch {
    /* loader 不可用时返回空列表，前端会提示改用「重启服务」 */
  }
  return { targets: out.sort((a, b) => a.name.localeCompare(b.name)), profileDir, depCount: deps.size };
}

/**
 * 按白名单重载指定插件，使其重新读取 `process.env`。
 *
 * 使用 cordis 官方原语 `fiber.restart()`：dispose 后再跑一次 `apply()`，
 * 插件因此拿到新的环境变量。**不修改任何被重载插件的代码**。
 *
 * 条目名可能对应多个 fiber，此处按 `pickRestartable` 选取运行中的那个，
 * 与 /list 展示的状态保持一致；选中项不是运行态时如实报错，不静默跳过。
 * @param ctx - cordis 宿主上下文。
 * @param names - 目标插件条目名数组。
 * @returns 每个目标的执行结果。
 */
async function reloadTargets(ctx, names) {
  const results = [];
  let groups;
  try {
    groups = groupEntriesByName(ctx);
  } catch {
    return names.map((n) => ({ name: n, ok: false, error: 'loader 不可用。' }));
  }

  for (const target of names) {
    const group = groups.get(target);
    if (!group || group.length === 0) {
      results.push({ name: target, ok: false, error: '未找到该插件条目。' });
      continue;
    }
    if (target === name) {
      results.push({ name: target, ok: false, error: '不能重载参数插件自身。' });
      continue;
    }
    const entry = pickRestartable(group);
    const fiber = entry.fiber;
    if (!fiber || typeof fiber.uid !== 'number') {
      results.push({ name: target, ok: false, error: '该插件未处于已加载状态。' });
      continue;
    }
    // 与 /list 的 restartable 判定保持一致：只有 ACTIVE 的 fiber 才可重载。
    // 否则前端置灰了、后端却照重载，界面上的限制形同虚设。
    if (fiber.state !== 2) {
      results.push({ name: target, ok: false, error: '该插件当前不是运行状态，无法重载。' });
      continue;
    }
    if (typeof fiber.restart !== 'function') {
      results.push({ name: target, ok: false, error: '该插件不支持热重载。' });
      continue;
    }
    try {
      await fiber.restart();
      // 同名多条时说明重载的是哪一个，避免用户以为换了另一个实例。
      const note = group.length > 1 ? '（同名条目 ' + group.length + ' 个，已重载运行中的 ' + (entry.id ?? target) + '）' : '';
      results.push({ name: target, ok: true, note });
    } catch (error) {
      results.push({ name: target, ok: false, error: error?.message ?? String(error) });
    }
  }
  return results;
}

/**
 * 宿主启动时按白名单重载插件，使其读到本次启动灌入的环境变量。
 *
 * ## 为什么需要它（此前是一个真实缺陷）
 *
 * `reload.targets` 白名单此前只在两个**手工时机**被消费：调用 `/set` 保存变量、
 * 或点页面「保存」按钮（`/apply`）。启动路径只做「注入 env」，从不读白名单。
 *
 * 后果：每次宿主重启后，快照型插件（在 `apply()` 里把配置读成字符串固化的那些，
 * dsh-sql 即属此类）会按自己的**加载顺序**抢跑 —— 若它排在参数插件之前，
 * 读到的就是尚未注入的空值，于是连接报 `Access denied ... (using password: NO)`。
 * 用户必须在页面上点一次「保存」才恢复，白名单形同虚设。
 *
 * 这与本文档开头「与插件加载顺序无关」的承诺不符：靠 `ctx.loader.entries()`
 * 按条目名定位确实与顺序无关，但**得有人去调用它**。本函数补上的就是这一步。
 *
 * ## 为什么是轮询而不是一次性调用
 *
 * 本插件 `apply()` 执行时，白名单里的目标插件**可能还没加载完成**
 * （目标 fiber 的 `state !== 2`）。`reloadTargets` 对这种条目的判定是
 * 「该插件未处于已加载状态」并跳过 —— 一次性调用会在某些加载顺序下静默失效，
 * 反而制造「有时好有时坏」的偶发故障。
 *
 * 因此这里轮询等待，直到白名单中的目标全部进入 ACTIVE（`state === 2`）再重载；
 * 期间允许目标尚未出现。轮询不假设任何加载顺序，**只等事实就绪**。
 *
 * @param ctx - cordis 宿主上下文。
 * @param options - 可选项。
 * @param options.timeoutMs - 总等待上限，默认 30 秒；超时后对已就绪的目标重载一次。
 * @param options.intervalMs - 轮询间隔，默认 250 毫秒。
 * @param options.onResult - 重载完成后的回调，入参为 `reloadTargets` 的结果数组。
 * @returns 取消函数；调用后停止轮询（用于 `ctx.effect` 的清理）。
 */
function scheduleBootReload(ctx, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30_000;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 250;
  const deadline = Date.now() + timeoutMs;
  let timer = null;
  let cancelled = false;

  /** 判断白名单里的目标是否都已可重载（存在且处于 ACTIVE）。 */
  const allReady = (targets) => {
    let groups;
    try {
      groups = groupEntriesByName(ctx);
    } catch {
      // loader 尚不可用 —— 视为未就绪，继续等。
      return false;
    }
    return targets.every((target) => groups.get(target)?.some((entry) => entry.fiber?.state === 2));
  };

  const tick = () => {
    if (cancelled) return;
    const targets = readDocument(DEFAULT_FILE).targets;
    // 白名单被清空 ⇒ 无事可做，直接结束。
    if (targets.length === 0) return;
    if (allReady(targets) || Date.now() >= deadline) {
      void reloadTargets(ctx, targets).then((results) => {
        if (!cancelled) options.onResult?.(results);
      });
      return;
    }
    timer = setTimeout(tick, intervalMs);
    // 不阻止进程退出：宿主本就长期运行，此处仅为避免拖住重启流程。
    timer.unref?.();
  };

  timer = setTimeout(tick, intervalMs);
  timer.unref?.();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * 收集 loader 条目，并把「同名条目」显式标注出来。
 *
 * loader 里存在**条目名重复**的情况（例如 `@deepseek-ai/cordis-plugin-hmr`
 * 同时有 `include:hmr`（unloaded）与一个运行中的实例）。若简单地以名字为键
 * 建索引，后者会静默覆盖前者：用户勾选后可能重载到错误的那一个，或反过来
 * 被判成「不可重载」。因此这里保留全部条目，并在**至少有一个可重载**时标记
 * `ambiguous`，交给调用方按「运行中优先」挑选并给出明确提示。
 * @param ctx - cordis 宿主上下文。
 * @returns 条目名 → 该名下的全部条目数组。
 */
function groupEntriesByName(ctx) {
  const groups = new Map();
  for (const entry of ctx.loader.entries()) {
    const entryName = entry.options?.name;
    if (typeof entryName !== 'string' || entryName === '') continue;
    if (!groups.has(entryName)) groups.set(entryName, []);
    groups.get(entryName).push(entry);
  }
  return groups;
}

/**
 * 从同名条目组里选出用于重载的那一个：**运行中的优先**。
 *
 * 与 /list 的 `restartable`（`state === 2`）判定完全一致，避免前端置灰了、
 * 后端却重载另一个的错位。
 * @param group - 同名条目数组。
 * @returns 选中的条目；没有运行中的则返回第一个。
 */
function pickRestartable(group) {
  const active = group.find((entry) => entry.fiber?.state === 2);
  return active ?? group[0];
}

/**
 * 校验请求体里的变量名、值与备注。
 *
 * 变量名**不限制前缀**：用户按目标插件文档决定名字（只要名字合法、且不在
 * `UNSAFE_ENV_NAMES` 那张危险名小表里）。
 * @param body - 解析后的请求体。
 * @returns 校验结果；`error` 非空表示不合法。
 */
function validatePair(body) {
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (key === '') return { error: '变量名不能为空。' };
  if (key.length > NAME_MAX) return { error: '变量名过长（上限 ' + NAME_MAX + ' 字符）。' };
  if (!NAME_PATTERN.test(key)) {
    return { error: '变量名非法：只允许字母、数字、下划线，且不能以数字开头。' };
  }
  if (UNSAFE_ENV_NAMES.has(key.toUpperCase())) {
    // 明确说明「为什么这个合法名字也不行」，否则用户会以为是插件出错。
    return { error: '「' + key + '」会改变宿主进程自身的行为（可执行文件/模块/'
      + '动态库的查找路径等），从本页设置风险过高，已拒绝。如确实需要，'
      + '请直接编辑 ~/.dsh/.dsh-settings-params/params.yml（那里的写入不受本页限制）。' };
  }
  const rawValue = body?.value;
  if (rawValue !== undefined && typeof rawValue !== 'string') {
    return { error: '变量值必须是字符串。' };
  }
  const value = rawValue ?? '';
  if (value.length > VALUE_MAX) return { error: '变量值过长（上限 ' + VALUE_MAX + ' 字符）。' };
  if (/[\r\n]/.test(value)) return { error: '变量值不能包含换行。' };

  // 备注是可选的纯展示字段：未传时保留调用方语义（由调用方决定沿用旧备注还是清空）。
  const rawNote = body?.note;
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
    return { error: '备注必须是字符串。' };
  }
  const note = typeof rawNote === 'string' ? rawNote.trim() : null;
  if (note !== null && note.length > NOTE_MAX) {
    return { error: '备注过长（上限 ' + NOTE_MAX + ' 字符）。' };
  }
  if (note !== null && /[\r\n]/.test(note)) return { error: '备注不能包含换行。' };

  return { key, value, note };
}

/**
 * 仅接受本机同源 POST，拒绝跨站请求。
 *
 * 本页能改宿主环境变量，属于高权限操作，必须挡住浏览器里第三方页面的 CSRF。
 * 校验：方法为 POST；Origin（或 Referer 回退）的 hostname 是回环地址。
 * @param request - 传入的 HTTP 请求。
 * @returns 是否为可信请求。
 */
function isTrustedPost(request) {
  if (request.method !== 'POST') return false;
  const raw = request.headers.origin ?? request.headers.referer ?? '';
  if (raw === '') return true; // 非浏览器客户端（curl 等）不发 Origin，放行。
  try {
    // 注意：URL.hostname 对 IPv6 会保留方括号（`[::1]`），不能直接与 `::1` 比较。
    const hostname = new URL(raw).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * 读取并解析 JSON 请求体。
 * @param request - 传入的 HTTP 请求。
 * @returns 解析出的对象；失败返回空对象。
 */
function readJsonBody(request) {
  return new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) {
        request.destroy();
        resolve({});
      }
    });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : {});
      } catch {
        resolve({});
      }
    });
    request.on('error', () => resolve({}));
  });
}

/**
 * 发送 JSON 响应。
 * @param response - 传出响应。
 * @param status - HTTP 状态码。
 * @param payload - 可序列化的响应体。
 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/**
 * 重启宿主进程的 detached 脚本（POSIX 用 lsof+SIGTERM，Windows 用 netstat+taskkill）。
 *
 * 与 `dsh-restart-button` 采用同一套已验证实现，但**关键差异**在这里：拉起
 * 新宿主时显式把参数文件里的键值放进子进程 `env`，因为 `dsh web` 由 detached
 * 进程启动，不会继承调用方对 `process.env` 的改动。
 */
const HOST_RESTART_SCRIPT = String.raw`const C = require('node:child_process')
const F = require('node:fs')
const P = require('node:path')
const O = require('node:os')
const win = process.platform === 'win32'
const port = Number(process.argv[1])
const paramsFile = process.argv[2]

function findPids() {
  if (win) {
    const out = C.spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
    const found = []
    for (const line of String(out.stdout || '').split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const addr = parts[1] || ''
      if (!addr.endsWith(':' + port)) continue
      const pid = parts[parts.length - 1]
      if (pid && /\d+/.test(pid)) found.push(pid)
    }
    return found
  }
  const out = C.spawnSync('lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return String(out.stdout || '').split(/\s+/).filter(Boolean)
}

for (const pid of findPids()) {
  try {
    if (win) C.spawnSync('taskkill', ['/pid', pid, '/t', '/f'])
    else process.kill(Number(pid), 'SIGTERM')
  } catch {}
}

let tries = 0
;(function waitForStop() {
  if (findPids().length === 0 || ++tries > 20) return startHost()
  setTimeout(waitForStop, 250)
})()

function startHost() {
  const dir = P.join(O.homedir(), '.dsh', 'logs')
  F.mkdirSync(dir, { recursive: true })
  const fd = F.openSync(P.join(dir, 'dsh-web-' + port + '.log'), 'a')
  // 解析 YAML 里的 variables 段，显式注入新宿主环境。
  // 只认本插件写出的形状（双引号标量），手改引入的其他 YAML 特性不在支持范围。
  const env = Object.assign({}, process.env)
  try {
    const text = F.readFileSync(paramsFile, 'utf8')
    let inVariables = false
    let currentKey = ''
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, '')
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      const body = line.trim()
      if (indent === 0) {
        inVariables = /^variables\s*:\s*$/.test(body)
        currentKey = ''
        continue
      }
      if (!inVariables) continue
      if (indent <= 2) {
        const m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
        currentKey = m ? m[1] : ''
        continue
      }
      if (currentKey === '') continue
      const f = body.match(/^value\s*:\s*(.*)$/)
      if (!f) continue
      const t = f[1].trim()
      let value = t
      if (t.startsWith('"')) {
        let out = ''
        for (let i = 1; i < t.length; i++) {
          const ch = t[i]
          if (ch === '\\') {
            const n = t[i + 1]
            if (n === 'n') out += '\n'
            else if (n === 't') out += '\t'
            else if (n === 'r') out += '\r'
            else out += (n === undefined ? '' : n)
            i++
            continue
          }
          if (ch === '"') break
          out += ch
        }
        value = out
      }
      env[currentKey] = value
    }
  } catch {}
  const child = C.spawn('dsh', ['web', '--port', String(port), '--no-open'], {
    detached: true,
    shell: win,
    stdio: ['ignore', fd, fd],
    env: env,
  })
  child.unref()
}`;

/** 默认回退端口：请求 Host 头解析失败时使用。 */
const FALLBACK_PORT = 7923;

/**
 * 把「文件中的变量」同步进 `process.env`，并维护一份**所有权账本**。
 *
 * 之所以需要账本：`process.env` 是进程级共享资源，卸载插件时如果无脑删除
 * `DSH_*` 键，就会误伤宿主或其他插件写入的变量；如果按「加载前快照」回卷，
 * 又会在 HMR 重载场景下把上次写入的真值当成旧值删掉。**唯一安全的依据是
 * 「本插件到底写过哪些键、写的是什么值」**，这正是本类记录的内容。
 *
 * 清理规则（`release`）：
 *  - 只处理写过、且**当前值仍等于本插件写下的值**的键；值被他人改过 → 放手；
 *  - 文件里仍然定义着的键 **不清理**（它在下一轮 apply 会被重新写入，清掉会
 *    造成「自己卸载自己」的假象）；
 *  - 其余写过但文件已无定义的键 → 从进程移除，并同步从账本删除。
 */
class EnvLedger {
  constructor() {
    /** 键 → 本插件最后写入的值。 */
    this.written = new Map();
  }

  /**
   * 按文件内容重建受管变量：文件里删掉的键从进程移除，文件里的键写入进程。
   *
   * 文件是唯一事实来源（single source of truth）。移除时同样遵守所有权规则 ——
   * 只删本插件写过、且值未被他人改动的键。
   * @param variables - 文件解析出的键 → `{ value }`。
   * @returns 受管变量数量。
   */
  sync(variables) {
    for (const key of [...this.written.keys()]) {
      if (variables.has(key)) continue;
      this.clearOne(key);
    }
    for (const [key, entry] of variables) this.setOne(key, entry.value);
    return variables.size;
  }

  /**
   * 写入一个键并记账。
   * @param key - 环境变量名。
   * @param value - 要写入的值。
   */
  setOne(key, value) {
    process.env[key] = value;
    this.written.set(key, value);
  }

  /**
   * 移除一个键：仅当它仍等于本插件写下的值。
   * @param key - 环境变量名。
   */
  clearOne(key) {
    if (!this.written.has(key)) return;
    if (process.env[key] === this.written.get(key)) delete process.env[key];
    this.written.delete(key);
  }

  /**
   * 卸载时的清理：收回仍归本插件所有的键，放走已被他人接管的键。
   *
   * **文件里仍有定义的键一律不清理**（由 `keep` 传入）：卸载后文件依旧代表用户
   * 的配置意图，下次加载会重新灌入；此时清空只会制造「文件里有值、进程里是空」
   * 的假故障 —— 正是本次要修的那个现象。需要从进程树彻底摘除某个变量，用
   * `POST /unset`（它同时改文件，语义明确）。
   * @param keep - 仍然定义在文件中的键集合；这些键在卸载时保持不动。
   */
  release(keep) {
    for (const key of [...this.written.keys()]) {
      if (keep.has(key)) continue;
      if (process.env[key] === this.written.get(key)) delete process.env[key];
      this.written.delete(key);
    }
  }
}

/**
 * 把值掩码成不含任何真实字符的占位串。
 *
 * **刻意只回长度、不回任何字符**：`value.slice(0, 3) + '…'` 这类「保留前缀」的
 * 掩码会把真实密钥的头几个字符泄漏给模型，等于把掩码变成弱化版的明文。
 * 这里用圆点数示意长度（上限 16 个，避免超长值把输出撑爆）。
 * @param value - 真实值。
 * @returns 掩码串；空值回空串。
 */
function maskValue(value) {
  const length = typeof value === 'string' ? value.length : 0;
  if (length === 0) return '';
  return '•'.repeat(Math.min(length, 16));
}

/**
 * 从参数对象里安全取字符串（模型给的参数不可信，必须自行收敛类型）。
 * @param args - 工具收到的原始参数。
 * @param key - 参数名。
 * @returns 去空白后的字符串；非字符串或空串返回 `''`。
 */
function toolStringArg(args, key) {
  const source = typeof args === 'object' && args !== null ? args : {};
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 工具一：`env_param_list` —— 列出当前允许模型读取的变量。
 *
 * **只回掩码状态，任何情况下不回明文**。数据来源是 params.yml 的 expose 列表
 * 与 variables 段，**不读 `process.env`**：宿主里可能有大量非本页管理的
 * `DSH_*` 变量，把它们的存在与长度暴露给模型没有正当理由。
 */
const envParamListTool = {
  name: 'env_param_list',
  description: '列出当前允许模型读取的环境变量（在 dsh-settings-params 插件页勾选「允许模型读取」的变量）。只返回变量名、备注、掩码占位与是否已设置，**不返回明文**。读取明文请用 env_param_get。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '可选：按子串过滤变量名（大小写不敏感）。' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        exposed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              note: { type: 'string' },
              masked: { type: 'string' },
              hasValue: { type: 'boolean' },
            },
            additionalProperties: true,
          },
        },
        total: { type: 'integer' },
      },
      additionalProperties: true,
    },
    render: (_args, value) => {
      const record = typeof value === 'object' && value !== null ? value : {};
      const items = Array.isArray(record.exposed) ? record.exposed : [];
      if (items.length === 0) {
        return [{
          type: 'text',
          text: '当前没有任何变量被授权给模型读取。如需开启，请在 dsh-settings-params 插件页对应变量行打开「允许模型读取」。',
        }];
      }
      const lines = ['已授权模型读取的变量（共 ' + items.length + ' 个，值一律掩码）：'];
      for (const item of items) {
        const entry = typeof item === 'object' && item !== null ? item : {};
        lines.push('- ' + entry.name + '：' + (entry.hasValue === true ? entry.masked : '（未设置值）') + (entry.note ? '　备注：' + entry.note : ''));
      }
      lines.push('需要明文请调用 env_param_get（注意：明文会进入模型上下文与本次会话的对话记录）。');
      return [{ type: 'text', text: lines.join('\n') }];
    },
  },
  async execute(rawArgs) {
    // 每次调用都重新读文件：撤销授权后立即生效，不缓存。
    const doc = readDocument(DEFAULT_FILE);
    const pattern = toolStringArg(rawArgs, 'pattern').toLowerCase();
    const exposed = [];
    for (const key of doc.expose) {
      if (pattern !== '' && !key.toLowerCase().includes(pattern)) continue;
      const entry = doc.variables.get(key);
      const value = entry?.value ?? '';
      exposed.push({
        name: key,
        note: entry?.note ?? '',
        masked: maskValue(value),
        hasValue: value !== '',
      });
    }
    return { exposed, total: exposed.length };
  },
};

/**
 * 工具二：`env_param_get` —— 取某个变量的**明文**。
 *
 * ## 唯一会输出明文的地方，安全属性全在这里
 *
 * 执行顺序**必须先判白名单、再取值**：
 *  1. 校验参数与变量名合法性；
 *  2. **每次调用重新读 params.yml**（不缓存白名单）；
 *  3. 不在 expose 中 → 抛错，且错误信息**不含该变量的任何值片段**；
 *  4. 不在 variables 中 → 抛错；
 *  5. 全部通过后才读取值并返回。
 *
 * 第 2 步是核心：用户在页面上撤销授权后，**下一次工具调用立即失效**，
 * 不需要重载插件或重启进程。若这里改成「apply 时读一次存起来」，撤销就只在
 * 重启后生效，等于给出一个用户以为已经关闭、实际仍然敞开的通路。
 *
 * 第 3 步的错误信息刻意只提变量名与操作指引，**不提值的长度、不提首尾字符** ——
 * 拒绝路径上一个字节的真值都不应离开进程。
 *
 * ## 为什么这条路能绕过 DSH 的凭证剥离
 *
 * DSH 只在 spawn 子进程时剥离凭证形态变量（`@deepseek-ai/dsh-subprocess` 的
 * `scrubbedParentEnv()`：`DSH_` 前缀 + `/KEY|PASSWORD|SECRET|TOKEN/i`）。
 * 工具调用是宿主进程内的普通函数调用，**不经过 spawn**，因此不受该剥离影响 ——
 * 这正是子代理也能读到值的原因。
 */
const envParamGetTool = {
  name: 'env_param_get',
  description: '读取某个环境变量的**明文**值。仅对该变量在 dsh-settings-params 插件页已开启「允许模型读取」时可用，否则会被拒绝。注意：返回的明文会进入模型上下文与本次会话的对话记录，高敏感密钥不建议开启授权。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '环境变量名（必填），例如 DSH_SQL_PASSWORD_OPENCROWD。' },
    },
    required: ['name'],
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'string' },
        note: { type: 'string' },
      },
      additionalProperties: true,
    },
    render: (_args, value) => {
      const record = typeof value === 'object' && value !== null ? value : {};
      const note = typeof record.note === 'string' && record.note !== '' ? '（备注：' + record.note + '）' : '';
      return [{ type: 'text', text: record.name + ' = ' + record.value + note }];
    },
  },
  async execute(rawArgs) {
    const name = toolStringArg(rawArgs, 'name');
    // 第 1 步：参数与变量名合法性。此处尚未触碰任何值。
    if (name === '') throw new Error('参数 name 为必填，请提供要读取的环境变量名。');
    if (name.length > NAME_MAX) throw new Error('变量名过长（上限 ' + NAME_MAX + ' 字符）。');
    if (!NAME_PATTERN.test(name)) {
      throw new Error('变量名非法：只允许字母、数字、下划线，且不能以数字开头。');
    }

    // 第 2 步：每次调用重新读文件，白名单**不缓存**（撤销后下一次调用立即失效）。
    // 文件不存在或损坏时 readDocument 会退化为空授权，因此下面的判定必然拒绝。
    const doc = readDocument(DEFAULT_FILE);

    // 第 3 步：先判白名单，未授权直接拒绝 —— 拒绝信息不含值的任何片段。
    if (!doc.expose.includes(name)) {
      throw new Error(
        '变量 ' + name + ' 未授权给模型读取。请在 dsh-settings-params 插件页该变量行开启「允许模型读取」后重试。',
      );
    }

    // 第 4 步：授权项存在但变量未配置。
    const entry = doc.variables.get(name);
    if (entry === undefined) {
      throw new Error('变量 ' + name + ' 已授权但未在 params.yml 中配置，请先在设置页填写其值。');
    }

    // 第 5 步：全部检查通过，此刻才读取明文。
    return { name, value: entry.value ?? '', note: entry.note ?? '' };
  },
};

/**
 * 插件入口：把参数文件灌进 `process.env`，注册全部路由与两个变量读取工具。
 *
 * 加载时先做一次「启动灌入」：把文件里的变量写进 `process.env`。这样无论
 * 宿主是被谁拉起的（终端 `dsh web`、重启按钮、还是本插件的重启路由），
 * 只要文件存在，变量就一定在——这正是「重启之后依然能读取」的保证。
 *
 * 灌入通过 `ctx.effect()` 注册**记账式清理**：卸载时只收回本插件写过、且值未被
 * 他人改动的键，绝不误删宿主或其他插件的同名类变量。早期版本用「加载前快照 +
 * 卸载时回卷」，在 HMR 重载时会把上次写入的真值当作旧值删掉，导致「文件里有值、
 * 进程里却是空」——详见 EnvLedger 的说明。
 * @param ctx - cordis 宿主上下文。
 */
export function apply(ctx) {
  const filePath = DEFAULT_FILE;

  // 先做「搬到插件专有目录」的迁移（旧布局 ~/.dsh/params.yml → 专有目录）。
  // 它内部幂等、带回读校验，失败时旧文件原封不动。
  const relocated = migrateToPluginDirIfNeeded();

  // 再做更早的一次迁移：把旧的 params.env 转成 params.yml（旧文件改名留档）。
  const migrated = migrateLegacyIfNeeded();

  // 启动灌入：文件为准，覆盖同名宿主变量，确保页面里看到的就是生效值。
  // 账本记下「哪些键是本次插件实例写的」，卸载时据此清理，不再猜测历史状态。
  const ledger = new EnvLedger();
  const bootInjected = [];
  for (const [key, entry] of readDocument(filePath).variables) {
    ledger.setOne(key, entry.value);
    bootInjected.push(key);
  }
  // 卸载时按所有权收回，而非回卷到「猜测的旧值」。
  // 传入文件定义集合：文件里仍定义着的键在卸载时不清理 —— 它代表用户的配置意图，
  // 下次加载会重新灌入；此时清空只会制造「文件里有值、进程里是空」的假故障。
  ctx.effect(() => () => ledger.release(readDocument(filePath).variables), 'dsh-settings-params: env injection');

  /**
   * 统一的「保存后同步」：重新从文件读一遍，让 process.env 与文件严格一致。
   *
   * 文件是唯一事实来源：任何写操作后都以文件内容为准重建受管变量。
   * 清扫范围**严格限定在本插件写过的键**，不再按 `DSH_` 前缀全域删除 ——
   * 那是宿主与其他插件的变量，本插件无权处置。
   * @returns 同步后的受管变量数量。
   */
  const syncFromFile = () => ledger.sync(readDocument(filePath).variables);

  // 两个面向模型的工具：让模型（含子代理）能显式请求读取变量明文。
  //
  // 工具调用是宿主进程内的函数调用，**不经过 spawn**，因此不受 DSH 对子进程
  // 的凭证剥离（`DSH_` 前缀 / `/KEY|PASSWORD|SECRET|TOKEN/i`）影响 —— 这正是
  // 本方案成立的原因。工具是否可读由 params.yml 的 expose 列表决定，
  // 该列表在**每次调用时**重新读取，撤销授权后立即失效。
  ctx.effect(() => ctx.tools.register(envParamListTool), 'dsh-settings-params: env_param_list tool');
  ctx.effect(() => ctx.tools.register(envParamGetTool), 'dsh-settings-params: env_param_get tool');

  // GET /list —— 列出受管变量（值掩码）+ 可重载目标 + 当前白名单
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-settings-params/list',
    handler: (_request, response) => {
      const doc = readDocument(filePath);
      const { targets, profileDir, depCount } = listTargets(ctx);
      sendJson(response, 200, {
        ok: true,
        file: filePath,
        legacyFile: existsSync(LEGACY_FILE) ? LEGACY_FILE : '',
        migrated,
        variables: collectManaged(doc),
        targets,
        profileDir,
        depCount,
        whitelist: doc.targets,
        // 追加字段（既有字段一律不动）：允许模型读取明文的变量名。
        expose: doc.expose,
        bootInjected,
        // 保留字段名，**恒为空对象**：插件详情页不再取任何变量清单。
        //
        // 按用户的设计裁决（「用户按插件文档定义参数，插件只需按白名单放行」），
        // 本插件**不再试图推断任何插件需要哪些变量** —— 既不再读第三方插件源码
        // （扫描层），也不再解析它们的 cordis 配置（登记层）。因此这里没有内容
        // 可填，但**保留字段本身**而不删除，是为了让旧版客户端的
        // `pluginEnvHintFrom(body, pkgName)` 拿到 `{}` 而不是 `undefined`，
        // 走「无该包名」分支而非结构异常分支（两条分支都不再渲染清单）。
        pluginEnvHints: {},
      });
    },
  }), 'dsh-settings-params: list route');

  // POST /set —— 新增或更新一个变量
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-settings-params/set',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: '本接口仅接受同源 POST 请求。' });
        return;
      }
      const body = await readJsonBody(request);
      const checked = validatePair(body);
      if (checked.error) {
        sendJson(response, 400, { ok: false, error: checked.error });
        return;
      }
      const doc = readDocument(filePath);
      const previous = doc.variables.get(checked.key);
      // note 为 null 表示请求未提及备注（例如仅改值）→ 沿用旧备注，避免意外抹掉。
      const note = checked.note === null ? (previous?.note ?? '') : checked.note;
      doc.variables.set(checked.key, { value: checked.value, note });
      // expose 原样传回：改变量值绝不能顺手撤销已有的读取授权。
      atomicWrite(filePath, serializeYamlDocument(doc.variables, doc.targets, doc.expose));
      const count = syncFromFile();
      sendJson(response, 200, {
        ok: true,
        key: checked.key,
        note,
        applied: true,
        count,
        message: '已写入文件并注入当前进程；对启动时只读一次环境变量的插件（如 dsh-sql），请在下方勾选后热重载，或重启服务。',
      });
    },
  }), 'dsh-settings-params: set route');

  // POST /unset —— 删除一个变量
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-settings-params/unset',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: '本接口仅接受同源 POST 请求。' });
        return;
      }
      const body = await readJsonBody(request);
      const key = typeof body?.key === 'string' ? body.key.trim() : '';
      if (!NAME_PATTERN.test(key)) {
        sendJson(response, 400, { ok: false, error: '变量名非法。' });
        return;
      }
      const doc = readDocument(filePath);
      const existed = doc.variables.delete(key);
      // 变量被删除时同步撤销其读取授权，否则会留下一个指向不存在变量的授权项。
      const nextExpose = doc.expose.filter((item) => item !== key);
      atomicWrite(filePath, serializeYamlDocument(doc.variables, doc.targets, nextExpose));
      // 先删除文件定义，再让 syncFromFile 通过账本清进程（含所有权判断）。
      const count = syncFromFile();
      sendJson(response, 200, {
        ok: true,
        key,
        removed: existed,
        count,
        message: existed
          ? '已从文件移除并清理当前进程变量；释放相关资源需热重载或重启。'
          : '文件中原无此变量，已清理当前进程中的同名变量。',
      });
    },
  }), 'dsh-settings-params: unset route');

  // POST /reload —— 外部手改文件后重新灌入，可选顺带重载白名单插件
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-settings-params/reload',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: '本接口仅接受同源 POST 请求。' });
        return;
      }
      const body = await readJsonBody(request);
      const count = syncFromFile();
      const doc = readDocument(filePath);
      // withReload=true 时按白名单重载；否则仅注入进程。
      const targets = body?.withReload === true ? doc.targets : [];
      const results = targets.length > 0 ? await reloadTargets(ctx, targets) : [];
      sendJson(response, 200, {
        ok: true,
        count,
        variables: collectManaged(doc),
        whitelist: doc.targets,
        reloaded: results,
        message: targets.length > 0
          ? '已按文件内容重新注入当前进程，并按白名单重载插件。'
          : '已按文件内容重新注入当前进程（未重载插件）。',
      });
    },
  }), 'dsh-settings-params: reload route');

  // POST /apply —— 保存白名单并立即按白名单热重载（页面主按钮）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-settings-params/apply',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: '本接口仅接受同源 POST 请求。' });
        return;
      }
      const body = await readJsonBody(request);
      const doc = readDocument(filePath);
      const requested = sanitizeTargets(body?.targets);
      // 先重载，**只把真正重载成功的条目写进白名单**。
      // 否则「不存在的条目」「未加载的条目」会被永久写进文件，每次重载都重试一遍。
      const results = requested.length > 0 ? await reloadTargets(ctx, requested) : [];
      const nextTargets = results.filter((r) => r.ok).map((r) => r.name);
      const skipped = results.filter((r) => !r.ok);
      // 白名单与变量存在同一个文件：卸载重装插件后配置依然在。
      // expose 原样传回：重载插件白名单与「允许模型读取」是两件独立的事。
      atomicWrite(filePath, serializeYamlDocument(doc.variables, nextTargets, doc.expose));
      const count = syncFromFile();
      sendJson(response, 200, {
        ok: true,
        count,
        whitelist: nextTargets,
        reloaded: results,
        skipped,
        message: requested.length === 0
          ? '白名单已清空，仅注入当前进程。'
          : skipped.length === 0
            ? '已注入当前进程并重载 ' + nextTargets.length + ' 个插件。'
            : '已重载 ' + nextTargets.length + ' 个插件，' + skipped.length + ' 个未能重载（已从白名单剔除）。',
      });
    },
  }), 'dsh-settings-params: apply route');

  // POST /expose —— 设置「允许模型读取」授权（新增/移除单个，或整表替换）
  //
  // 本路由只改 params.yml 的 expose 列表：**不写 process.env**，也不调用
  // syncFromFile —— 授权只影响工具读取，与现有的 env 注入轨道无关。
  // 返回值一律不含任何变量的值。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-settings-params/expose',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: '本接口仅接受同源 POST 请求。' });
        return;
      }
      const body = await readJsonBody(request);
      const doc = readDocument(filePath);

      // 两种入参形态：{ keys: string[] } 整表替换，或 { name, exposed } 单项切换。
      // 两者都经 sanitizeExpose 收敛（非法名一律丢弃 = 不授权）。
      let nextExpose;
      if (Array.isArray(body?.keys)) {
        nextExpose = sanitizeExpose(body.keys);
      } else {
        const key = typeof body?.name === 'string' ? body.name.trim() : '';
        if (key === '' || !NAME_PATTERN.test(key)) {
          sendJson(response, 400, { ok: false, error: '变量名非法：只允许字母、数字、下划线，且不能以数字开头。' });
          return;
        }
        if (body?.exposed === true) {
          nextExpose = sanitizeExpose([...doc.expose, key]);
        } else {
          nextExpose = doc.expose.filter((item) => item !== key);
        }
      }

      // 只改 expose；variables 与 reload.targets 原样传回，不越权改动。
      atomicWrite(filePath, serializeYamlDocument(doc.variables, doc.targets, nextExpose));
      sendJson(response, 200, {
        ok: true,
        expose: nextExpose,
        count: nextExpose.length,
        message: nextExpose.length === 0
          ? '已关闭全部「允许模型读取」授权，模型不再能读取任何变量的明文。'
          : '已更新授权：模型与子代理可通过 env_param_get 读取这 ' + nextExpose.length + ' 个变量的明文（明文会进入模型上下文与本次会话的对话记录）。',
      });
    },
  }), 'dsh-settings-params: expose route');

  // POST /restart —— 重启宿主（让所有插件重新加载，最后的兜底手段）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-settings-params/restart',
    handler: async (request, response) => {
      if (!isTrustedPost(request)) {
        sendJson(response, 403, { ok: false, error: '重启仅接受同源 POST 请求。' });
        return;
      }
      await readJsonBody(request);
      const host = request.headers.host ?? '';
      const portMatch = host.match(/:(\d+)$/);
      const port = portMatch ? Number(portMatch[1]) : FALLBACK_PORT;

      // detached + unref：宿主进程随即被 kill，重启子进程必须活下来继续执行。
      spawn(process.execPath, ['-e', HOST_RESTART_SCRIPT, String(port), filePath], {
        detached: true,
        stdio: 'ignore',
      }).unref();

      sendJson(response, 200, { ok: true, port });
    },
  }), 'dsh-settings-params: restart route');

  // ── 启动时应用白名单（此前缺失，导致重启后快照型插件读到空 env）─────────
  // 不改变任何手工路径：/set 与 /apply 仍然各自重载。这里补的是**启动路径**，
  // 使 `reload.targets` 在宿主重启后自动生效，无需用户去页面点一次「保存」。
  ctx.effect(() => scheduleBootReload(ctx, {
    onResult: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        // 如实记录，不静默吞掉：加载失败/超时都可能走到这里。
        console.warn('[dsh-settings-params] 启动时按白名单重载未全部成功：',
          failed.map((r) => r.name + ': ' + r.error).join('; '));
      }
    },
  }), 'dsh-settings-params: boot reload');
}
