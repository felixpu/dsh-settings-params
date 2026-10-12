# dsh-settings-params

在 DSH（DeepSeek Harness）网页版侧栏「**插件**」→ 本插件的详情页里，集中管理注入宿主的环境变量。

替代「改 shell 配置 → 重启 DSH」的循环：在这里编辑、保存即生效。

## 功能

- **集中管理**：所有变量在一个 YAML 文件里；每个变量记两项 —— 值 / 备注（变量名即键）
- **保存即写入** `process.env`，并持久化到磁盘
- **热重载**：勾选白名单插件后，让 dsh-sql 等启动时只读一次环境变量的插件免重启读取新值
- **敏感值不出宿主**：默认任何变量都不可被模型读取，需显式授权

## 安装

```sh
dsh plugin --profile web add github:felixpu/dsh-settings-params
```

安装后重启宿主进程。

## 使用

侧栏「插件」→ 点开本插件（dsh-settings-params）→ 页面上即是「参数设置」。

### 给模型读取某变量的权限

默认**所有变量都不可读**。授权由参数文件顶层的 `expose` 列表决定，需在界面上显式勾选。

授权后模型可通过工具读取：

| 工具 | 用途 |
|---|---|
| `env_param_list` | 列出已授权变量（只返回名字、备注、掩码，**不含明文**） |
| `env_param_get` | 读取某个已授权变量的**明文** |

> 读取明文会进入模型上下文与本次会话记录，**高敏感密钥不建议授权**。

### 热重载

某些插件（如 dsh-sql）在启动时一次性快照环境变量，之后改 `process.env` 不会生效。勾选该插件到白名单后，保存参数会触发它重新加载，无需重启宿主。

## 数据文件

默认路径：`~/.dsh/.dsh-settings-params/params.yml`

**在插件包目录之外** —— 因此卸载、重装、升级本插件都不会丢失配置（变量与白名单同在这个文件里）。

> 旧版本曾用 `~/.dsh/params.yml` 与 `~/.dsh/dsh-settings-params/params.yml`；
> 插件启动时会通过迁移逻辑自动搬到新位置，用户无需手工搬动。

文件格式（YAML）：

```yaml
expose: []          # 允许模型读取的变量名（默认空 = 都不可读）
params:
  - name: DSH_SQL_PASSWORD_OPENCROWD
    value: "******"
    note: 生产库只读账号
  - name: DEEPSEEK_API_KEY
    value: "sk-..."
    note: ""
```

## 宿主路由

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/dsh-settings-params/list` | 列出变量 |
| `POST` | `/dsh-settings-params/set` | 写入 / 更新变量 |
| `POST` | `/dsh-settings-params/unset` | 删除变量 |
| `POST` | `/dsh-settings-params/reload` | 触发白名单插件热重载 |
| `POST` | `/dsh-settings-params/apply` | 应用变量到 `process.env` |
| `POST` | `/dsh-settings-params/expose` | 修改可读授权 |
| `POST` | `/dsh-settings-params/restart` | 重启宿主进程 |

## 展示元数据（locale）

`locale/en.json` 与 `locale/zh.json` 提供**插件展示元数据**（`meta.title` / `meta.description`），
Plugin Manager 与设置页**无需激活插件**即可读取，用于显示本地化的插件名与说明。
这与运行时 UI 文案（客户端 `ctx.locale.register`）是两套东西。

```json
{ "meta": { "title": "…", "description": "…" } }
```

⚠️ 两个容易漏的点（漏任一个都会**静默失效**，不报错）：

1. **必须在 `package.json` 的 `exports` 里导出 `./locale/*.json`** —— 宿主经 Node 模块解析器
   读取该资源，未导出的子路径会得到 `ERR_PACKAGE_PATH_NOT_EXPORTED`，被当作「没有 locale」跳过。
2. **`files` 需包含 `locale`** —— 否则 `pnpm pack` / `npm publish` 的产物里不会带上它。

`icon.svg` 走顶层 `icon` 字段（相对路径），**不需要** `exports`。

## 设计说明

本包**不 import 任何 `@deepseek-ai/*` 包**。作为树外插件包，插件目录下没有 `node_modules`，`import '@deepseek-ai/dsh-tools'` 会抛 `ERR_MODULE_NOT_FOUND`，宿主侧表现为 `failed to import`、插件装载不上。

因此工具定义是**手写对象**（零 dsh 依赖），形状与官方 `defineTool` 编译结果等价。

客户端 bundle 仅 `require` 平台种子表内的模块。

## 相关插件

- **`dsh-env-inspector-plus`** —— 只读体检环境变量分组与键名指纹（不含值），与本包互补：想知道「有哪些变量」用它，想「改 / 看某个值」用本包

## 许可证

MIT © felixpu

## 仓库

<https://github.com/felixpu/dsh-settings-params>
