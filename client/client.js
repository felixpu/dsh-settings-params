window.__ModuleLoader__.load({ id: "dsh-settings-params", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

	// 客户端 bundle 由宿主模块加载器装载：React 通过工厂注入的 require 取得，
	// 不能用 ESM import（加载器不转换，也没有打包器）。
	var react = require("react");

	/**
	 * 平台 UI 基础件：只取 Tooltip（与全站其它提示同一个气泡）。
	 *
	 * 可取范围由应用的种子表决定（应用包里的 `staticModules`），其中含
	 * `@deepseek-ai/dsh-client-ui-primitives`，它导出 Tooltip / Switch / Tag / Toast 等。
	 *
	 * 为什么备注气泡不再自绘：设置页的内容区在 `@deepseek-ai/dsh-client-ui-settings-general`
	 * 里是 `.VOzbGW_options{overflow-y:auto}`（外层 `.VOzbGW_panel` 还是 `overflow:hidden`），
	 * 所以 `position:absolute` 的自绘气泡在滚到列表上部、或备注长到多行时会越过容器边界被裁掉；
	 * 平台 Tooltip 用 `position:fixed` + 视口钳制来躲这个，且自带 hover/focus 双触发、
	 * 空间不足时自动上下翻转（自绘那套 `.sp-tip-below` 翻转类当初根本没被 JS 用上）。
	 *
	 * ⚠️ 该包是 dsh 自家包的**构建期**依赖，磁盘上没有这个目录 ⇒ 绝不能写进 package.json
	 * （会让 pnpm install 去 registry 拉一个不存在的包而失败），只能像这样运行时 require。
	 * try/catch 是防御：种子表若哪天变了，退化成「只剩原生 title」，而不是这一行白屏。
	 */
	var Tooltip = null;
	var IconRefresh = null;
	try {
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		if (typeof primitives.Tooltip === "function") Tooltip = primitives.Tooltip;
		// 平台自带的刷新图标（一处描边风格，颜色走 currentColor，自动跟随主题）。
		// 取不到时下方渲染会退化成文字按钮，不会白屏。
		if (typeof primitives.IconRefreshOutlineRegular === "function") {
			IconRefresh = primitives.IconRefreshOutlineRegular;
		}
	} catch {
		Tooltip = null;
		IconRefresh = null;
	}

	/**
	 * dsh-settings-params 浏览器半身 —— 「参数设置」页。
	 *
	 * 页面挂在**本插件自己的 bundle 详情页**（侧栏「插件」→ dsh-settings-params），
	 * 通过 `plugins.bundle.config` 槽位注册；不再占用设置面板的导航分页。
	 * 页面内集中管理注入宿主的环境变量：新增 / 修改 / 删除 / 重新加载 / 热重载 / 重启生效。
	 *
	 * 与宿主通信走同源 fetch，对应 lib/index.js 的 /dsh-settings-params/* 路由。
	 * 值永远由用户在本地输入，宿主只回掩码状态，**明文不落浏览器存储**。
	 *
	 * 「热重载白名单」是页面核心能力：勾选那些在加载时读一次 env 的插件（如 dsh-sql），
	 * 保存后宿主用 cordis 的 fiber.restart() 让它们重跑 apply() 读新值 —— 不必重启整个服务。
	 * 白名单与变量存在同一个 params.yml 里，卸载重装插件后依然保留。
	 *
	 * 样式逐条取自原生 Primitives 编译产物，颜色全部走 --dsw-* 变量，跟随主题亮暗。
	 */

	/** 插件名（cordis 条目名，同时是模块加载器 bundle id）。 */
	var name = "dsh-settings-params";

	/** 声明的注入：插槽注册。 */
	var inject = ["slots"];

	/**
	 * 「允许模型读取」的风险提示文案。
	 *
	 * 开启授权后，模型（含子代理）可通过 env_param_get 工具读到变量**明文**。
	 * 这里必须把三层代价**同等显著**地讲清楚，缺一不可：
	 *   ① 明文进入**模型上下文** —— 会被发送给上游模型服务，可能被其记录；
	 *   ② 明文留在**本次会话的对话记录与日志**中 —— 可被回看、导出、检索；
	 *   ③ 因此**高敏感密钥不建议开启**。
	 *
	 * 措辞红线：不得使用「安全读取」「加密」「仅本机可见」之类会让用户低估风险的
	 * 说法 —— 弱化告知等于让用户在不知情下暴露密钥。
	 */
	var EXPOSE_RISK_TIP = "开启后，模型与子代理均可通过 env_param_get 工具读取该变量的明文。"
		+ "请注意三点："
		+ "①明文会进入模型上下文，即会被发送给上游模型服务，可能被其记录；"
		+ "②明文会留在本次会话的对话记录与日志中，可被回看和导出；"
		+ "③因此高敏感密钥不建议开启。"
		+ "仅在确需让模型直接使用该值时再打开。";

	/**
	 * 行内极短风险标记：不 hover 也要能看出「这会外流」，不能把代价完全藏进气泡。
	 *
	 * 与 EXPOSE_RISK_TIP 的分工：这条只负责「让人意识到有代价」，详情（三点代价）
	 * 由 Tooltip 承载。之所以保留一个不依赖 hover 的可见标记，是因为「勾选即放行」
	 * 的动作风险高，若只有 hover 才告知，等于默认用户不会看 —— 那属于弱化告知。
	 * 长度刻意压到与「允许模型读取」同一量级，避免早期 190px 常驻长文挤爆行布局。
	 */
	var EXPOSE_RISK_SHORT = "会进入模型上下文与会话记录";

	/** 路由前缀，与宿主半身一致。 */
	var ROUTE_BASE = "/dsh-settings-params";

	/** fiber 状态 → 界面上给用户看的中文说明。 */
	var STATE_LABEL = {
		unloaded: "未加载",
		pending: "等待依赖",
		busy: "加载中",
		failed: "加载失败",
		disposed: "已卸载"
	};

	/** 前端轮询重启是否完成的探针地址与间隔。 */
	var HEALTH_URL = ROUTE_BASE + "/list";
	var POLL_INTERVAL_MS = 1000;
	var POLL_TIMEOUT_MS = 60000;

	/**
	 * 原生样式：取自 dsh-web-frontend 的 Primitives 编译产物。
	 * 全部使用 --dsw-* 主题 token，不硬编码颜色，故亮/暗自动跟随。
	 */
	var CSS = [
		".sp-root{display:flex;flex-direction:column;gap:20px;padding:0;min-width:0}",
		".sp-lead{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
		".sp-file{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);word-break:break-all}",
		".sp-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-layer-2)}",
		".sp-card-title{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}",
		// 行改成两段式：上段「名称 + 值 + 操作」横向排列，授权开关独占下段。
		// 背景：授权开关早期塞在上段行内，勾选框 + 「允许模型读取」+ 常驻风险文字
		// 三样一起挤占横向空间，把掩码与操作按钮顶出可视区（实测确认）。
		// 官方 settings-form/fields.module.css 的 .field 正是「标签一层、说明另一层」
		// 的纵向结构，这里照它的思路把开关下沉为独立一层，风险文字收进 Tooltip。
		".sp-row{display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l4)}",
		".sp-row:last-child{border-bottom:none}",
		".sp-row-main{display:flex;align-items:center;gap:8px;width:100%}",
		".sp-key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-all;flex:1;min-width:0}",
		".sp-mask{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex:none}",
		// 备注气泡改由平台 Tooltip 渲染（见文件头的 Tooltip 说明），这里只保留"可悬停"的视觉暗示：
		// 变量名加虚线下划线 + help 光标。键盘可达性由 .sp-key 的 tabIndex 提供
		// （React 的 onFocus 会冒泡，Tooltip 挂在 .sp-keywrap 上也能收到）。
		".sp-keywrap{display:inline-flex;align-items:center;flex:none;max-width:100%}",
		".sp-keywrap.sp-has-note .sp-key{border-bottom:1px dashed var(--dsw-alias-border-l3);cursor:help}",
		// 「允许模型读取」授权开关：独占行下方一层，因此不与掩码/按钮争抢宽度。
		// 勾选框改用原生控件的视觉语言，风险详情收进 Tooltip（hover/focus 均可触发）。
		".sp-expose{display:flex;align-items:center;gap:8px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);width:fit-content}",
		// Tooltip 的 children 必须是单个元素，故「勾选框 + 文字」包在这个 label 里，
		// 它承担可点击区域与指针样式（外层 .sp-expose 只负责横向排布）。
		".sp-expose-hit{display:inline-flex;align-items:center;gap:4px;cursor:pointer}",
		".sp-expose-box{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:none}",
		".sp-expose-box:disabled{cursor:not-allowed;opacity:.4}",
		".sp-expose.sp-disabled{cursor:not-allowed;opacity:.5}",
		".sp-expose.sp-disabled .sp-expose-hit{cursor:not-allowed}",
		// 风险短标记：只在勾选后出现，用 warn 色提醒「有代价」，不设 max-width
		// （它独占下层，不会挤压掩码与按钮；文字本身已压到最短）。
		".sp-expose-warn{font-size:10px;line-height:16px;color:var(--dsw-alias-state-warn-primary)}",
		".sp-actions{display:flex;align-items:center;gap:6px;flex:none}",
		".sp-input{flex:1;min-width:0;height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}",
		".sp-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
		".sp-input-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}",
		".sp-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
		".sp-form .sp-input{min-width:200px}",
		".sp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:18px;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;height:36px;font-family:inherit;white-space:nowrap}",
		".sp-btn:disabled{cursor:not-allowed;opacity:.4}",
		".sp-btn-sm{height:28px;font-size:12px;line-height:18px;padding:0 10px;border-radius:14px}",
		".sp-btn-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}",
		".sp-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
		".sp-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
		".sp-btn-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse,#fff)}",
		".sp-btn-primary:hover:not(:disabled){opacity:.9}",
		".sp-btn-danger{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}",
		".sp-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent)}",
		".sp-tag{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;flex:none}",
		".sp-tag-outline{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}",
		".sp-tag-info{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary)}",
		".sp-tag-warning{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}",
		".sp-tag-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}",
		// 插件详情页的「环境变量密钥」区块。外观自绘（槽位不提供区块外壳，
		// 页面也不会读 register 的 label），故这里自带边界、圆角与内边距。
		".sp-env-section{display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-layer-2)}",
		".sp-env-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
		// 卡片右上角的刷新图标按钮。用 margin-left:auto 把它推到标题行最右，
		// 因此不需要额外的 spacer 元素；色值走 --dsw-* 变量以跟随明暗主题。
		".sp-rel-refresh{display:inline-flex;align-items:center;justify-content:center;flex:none;margin-left:auto;width:24px;height:24px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .15s ease,color .15s ease}",
		".sp-rel-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
		".sp-rel-refresh:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
		".sp-rel-refresh:disabled{cursor:not-allowed;opacity:.4}",
		// 图标取不到时的文字回退（种子表缺件），保证按钮仍有意义。
		".sp-rel-refresh-text{font-size:12px;line-height:18px;padding:0 4px}",
		// 「已放行哪些参数」的清单。这里列的是**用户自己在参数设置里定义的**参数名
		// （本插件不推断、也不列任何它"猜"出来的名字），只展示名字/备注/是否已填值，
		// 值永不进浏览器。
		".sp-rel-list{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}",
		".sp-rel-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:.5px solid var(--dsw-alias-border-l4)}",
		".sp-rel-row:last-child{border-bottom:none}",
		".sp-rel-key{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-all}",
		".sp-rel-note{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
		".sp-note{margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
		".sp-err{margin:0 0 12px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary);white-space:pre-wrap;word-break:break-all}",
		".sp-ok{margin:0 0 12px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:18px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);white-space:pre-wrap;word-break:break-all}",
		".sp-empty{padding:24px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary)}",
		".sp-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
		".sp-spacer{flex:1}",
		// 全局操作区：刻意**不复用 .sp-card** —— 它不该看起来像"又一张设置卡片"，
		// 否则「重启服务」的归属感问题只是换了个卡片重演。这里用更弱的视觉
		// （虚线边框 + 无背景），表达"这是页面级操作，不是某项配置"。
		".sp-global{display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px dashed var(--dsw-alias-border-l3);border-radius:16px}",
		".sp-global-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}",
		".sp-global-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
		// 说明：原先这里有 .sp-target / -name / :last-of-type 三条规则，是白名单
		// 目标行的旧类名；该列表后来改用 .sp-opt 系列，这三条已无任何使用者
		// （`grep` 全文件只有定义处），故移除以免被误当成活样式。
		".sp-result{padding:7px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l4)}",
		".sp-result:last-child{border-bottom:none}",
		".sp-result-ok{color:var(--dsw-alias-state-success-primary)}",
		".sp-result-err{color:var(--dsw-alias-state-error-primary)}",
		// 可搜索下拉：输入框 + 绝对定位面板。168 条候选靠它才不会淹没页面。
		".sp-picker{position:relative;width:100%}",
		// 关闭按钮：浮在输入框右侧，展开时才出现。
		".sp-picker-x{position:absolute;right:8px;top:50%;transform:translateY(-50%);z-index:31;border:none;background:transparent;cursor:pointer;padding:2px 6px;font-size:16px;line-height:1;color:var(--dsw-alias-label-tertiary);font-family:inherit}",
		".sp-picker-x:hover{color:var(--dsw-alias-label-primary)}",
		".sp-panel{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:30;box-sizing:border-box;max-height:260px;overflow-y:auto;padding:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 24px rgba(0,0,0,.16)}",
		".sp-opt{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer}",
		".sp-opt:hover{background:var(--dsw-alias-interactive-bg-hover)}",
		".sp-opt.sp-off{cursor:not-allowed;opacity:.55}",
		".sp-opt.sp-off:hover{background:transparent}",
		".sp-opt-name{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);word-break:break-all}",
		".sp-opt-group{padding:8px 8px 4px;font-size:11px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
		// 已选芯片。
		".sp-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
		".sp-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 6px 3px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);max-width:100%}",
		".sp-chip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		".sp-chip-x{border:none;background:transparent;cursor:pointer;padding:0 2px;font-size:14px;line-height:1;color:var(--dsw-alias-label-tertiary);font-family:inherit}",
		".sp-chip-x:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}",
		".sp-chip-x:disabled{cursor:not-allowed;opacity:.4}",
		".sp-busy{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}",
		".sp-busy-card{padding:20px 28px;border-radius:16px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
	].join("\n");

	/** 注入一次本插件样式（按 tagId 去重，避免重复挂载时叠加）。 */
	function installStyles() {
		var tagId = "dsh-settings-params/panel.css";
		if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
		var tag = document.createElement("style");
		tag.dataset.plugin = "dsh-settings-params";
		tag.dataset.pluginCss = tagId;
		tag.textContent = CSS;
		document.head.appendChild(tag);
	}

	/**
	 * 同源 fetch 的 JSON 辅助：统一错误处理，网络异常也转成结构化结果。
	 * @param {string} path - 相对路由路径，如 "/list"。
	 * @param {object} [init] - fetch 配置。
	 * @returns {Promise<object>} 响应体；请求失败时返回 { ok: false, error }。
	 */
	function request(path, init) {
		return fetch(ROUTE_BASE + path, init).then(
			function (res) {
				return res.json().then(
					function (body) { return body; },
					function () { return { ok: false, error: "响应不是合法 JSON（HTTP " + res.status + "）。" }; }
				);
			},
			function (err) {
				return { ok: false, error: "请求失败：" + (err && err.message ? err.message : String(err)) };
			}
		);
	}

	/** 发送 JSON 的 POST。 */
	function post(path, payload) {
		return request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload || {})
		});
	}

	/** 原生风格按钮。 */
	function Btn(props) {
		return react.createElement("button", {
			type: "button",
			className: "sp-btn sp-btn-" + (props.size === "sm" ? "sm " : "") + (props.variant || "outline"),
			disabled: !!props.disabled,
			onClick: props.onClick,
			title: props.title
		}, props.children);
	}

	/** 胶囊标签。 */
	function Tag(props) {
		return react.createElement("span",
			{ className: "sp-tag sp-tag-" + (props.tone || "outline") }, props.children);
	}

	/**
	 * 「参数设置」页面主体。
	 *
	 * 三个分区：
	 *  1. 已配置变量 —— 列表 + 掩码 + 行内「修改 / 删除」；
	 *  2. 新增变量 —— 名称 + 值输入；
	 *  3. 生效控制 —— 重新加载 / 重启宿主，并说明二者语义差异。
	 * @param {object} props - 插件注入的 props（本页无需外部注入）。
	 * @returns {object} React 元素。
	 */
	function ParamsSection(props) {
		var state = react.useState({ loading: true, file: "", legacyFile: "", variables: [], targets: [], whitelist: [], expose: [], error: "", notice: "" });
		var snap = state[0];
		var setSnap = state[1];

		// 白名单勾选状态（本地未保存的编辑）。键为插件条目名。
		var pickState = react.useState({});
		var picked = pickState[0];
		var setPicked = pickState[1];

		// 搜索框内容、下拉是否展开、以及「系统插件」分组是否展开。
		var searchState = react.useState("");
		var query = searchState[0];
		var setQuery = searchState[1];
		var openState = react.useState(false);
		var open = openState[0];
		var setOpen = openState[1];
		var sysState = react.useState(false);
		var showSystem = sysState[0];
		var setShowSystem = sysState[1];

		// 下拉容器引用：用于判断点击是否落在下拉之外。
		var pickerRef = react.useRef(null);

		/**
		 * 点击组件外部时收起下拉。
		 *
		 * 只在 `open` 为真时挂监听，收起后立即解绑，避免常驻 document 监听。
		 * 用 `mousedown` 而非 `click`：避免与输入框自身的 `focus` 抢时序，
		 * 也让「按下即收起」比等到 click 更跟手。
		 */
		react.useEffect(function () {
			if (!open) return undefined;
			function onDocMouseDown(e) {
				var el = pickerRef.current;
				if (el && !el.contains(e.target)) setOpen(false);
			}
			document.addEventListener("mousedown", onDocMouseDown);
			return function () { document.removeEventListener("mousedown", onDocMouseDown); };
		}, [open]);

		// 最近一次热重载的逐项结果。
		var resultState = react.useState(null);
		var results = resultState[0];
		var setResults = resultState[1];

		// 新增表单
		var draftState = react.useState({ key: "", value: "", note: "" });
		var draft = draftState[0];
		var setDraft = draftState[1];

		// 行内编辑：正在修改哪个 key，及其新值与新备注
		var editState = react.useState({ key: "", value: "", note: "" });
		var edit = editState[0];
		var setEdit = editState[1];

		var busyState = react.useState(false);
		var busy = busyState[0];
		var setBusy = busyState[1];

		var restartState = react.useState("");
		var restartMsg = restartState[0];
		var setRestartMsg = restartState[1];

		/** 拉取变量列表、可重载目标与白名单。 */
		function load() {
			return request("/list").then(function (body) {
				if (body && body.ok) {
					var whitelist = Array.isArray(body.whitelist) ? body.whitelist : [];
					var nextPicked = {};
					// 以服务端白名单为准重建勾选状态：保存后与文件严格一致。
					whitelist.forEach(function (n) { nextPicked[n] = true; });
					setPicked(nextPicked);
					setSnap({
						loading: false,
						file: body.file || "",
						legacyFile: body.legacyFile || "",
						profileDir: body.profileDir || "",
						variables: Array.isArray(body.variables) ? body.variables : [],
						targets: Array.isArray(body.targets) ? body.targets : [],
						whitelist: whitelist,
						// 「允许模型读取」授权名单，同样以服务端为准。
						expose: Array.isArray(body.expose) ? body.expose : [],
						error: "",
						notice: body.migrated
							? "已把旧的 params.env 迁移为 params.yml，旧文件保留为 .bak 备份。"
							: ""
					});
				} else {
					setSnap(function (prev) {
						var next = Object.assign({}, prev);
						next.loading = false;
						next.error = (body && body.error) || "读取失败。";
						return next;
					});
				}
			});
		}

		react.useEffect(function () { load(); }, []);

		/** 统一的写操作包装：置忙 → 请求 → 提示 → 刷新列表。 */
		function act(promise, okMessage) {
			setBusy(true);
			setSnap(function (prev) { return Object.assign({}, prev, { error: "", notice: "" }); });
			return promise.then(function (body) {
				setBusy(false);
				if (body && body.ok) {
					setSnap(function (prev) { return Object.assign({}, prev, { notice: okMessage || (body.note || "已保存。") }); });
					return load();
				}
				setSnap(function (prev) {
					return Object.assign({}, prev, { error: (body && body.error) || "操作失败。" });
				});
			});
		}

		/** 提交新增变量。 */
		function submitNew() {
			if (draft.key.trim() === "") {
				setSnap(function (prev) { return Object.assign({}, prev, { error: "请填写变量名。", notice: "" }); });
				return;
			}
			return act(post("/set", { key: draft.key.trim(), value: draft.value, note: draft.note }), "已保存变量 " + draft.key.trim() + "。")
				.then(function () { setDraft({ key: "", value: "", note: "" }); });
		}

		/** 提交行内修改。 */
		function submitEdit() {
			var key = edit.key;
			return act(post("/set", { key: key, value: edit.value, note: edit.note }), "已更新变量 " + key + "。")
				.then(function () { setEdit({ key: "", value: "", note: "" }); });
		}

		/** 删除变量（带二次确认：删除会导致依赖它的插件失效）。 */
		function removeKey(key) {
			if (!window.confirm("确定删除环境变量 " + key + " 吗？\\n依赖它的插件在重启后将不再收到该变量。")) return;
			return act(post("/unset", { key: key }), "已删除变量 " + key + "。");
		}

		/**
		 * 切换某个变量是否「允许模型读取」（写入 params.yml 的 expose 列表）。
		 *
		 * 开启后模型与子代理可通过 env_param_get 工具读到该变量的**明文**。
		 * 授权在宿主侧是**每次工具调用重新读文件**判定的，因此关闭后立即失效，
		 * 不需要重启或重载任何插件。
		 */
		function toggleExpose(key, exposed) {
			return act(
				post("/expose", { name: key, exposed: exposed }),
				exposed
					? "已允许模型读取 " + key + " 的明文（会进入模型上下文与会话记录）。"
					: "已禁止模型读取 " + key + "，该授权立即失效。"
			);
		}

		/** 从文件重新载入（针对手工编辑文件的场景），不重载插件。 */
		function reload() {
			return act(post("/reload", { withReload: false }), "已按文件内容重新注入当前进程。");
		}

		/** 切换某个插件是否在白名单内。 */
		function toggleTarget(name) {
			setPicked(function (prev) {
				var next = Object.assign({}, prev);
				if (next[name]) delete next[name];
				else next[name] = true;
				return next;
			});
		}

		/** 当前勾选的插件名数组。 */
		function pickedNames() {
			return Object.keys(picked).filter(function (k) { return picked[k]; });
		}

		/**
		 * 按关键词过滤候选（大小写不敏感的子串匹配）。
		 *
		 * 匹配范围是**完整条目名**，因此输入 `cordis` 既能命中 `cordis:include`，
		 * 也能命中 `@deepseek-ai/dsh-tool-cordis` —— 包名长短不一时更好用。
		 * @returns 过滤后的目标数组。
		 */
		function matches(t) {
			var q = query.trim().toLowerCase();
			if (q === "") return true;
			return t.name.toLowerCase().indexOf(q) >= 0;
		}

		/** 用户自己装的插件（默认展开）。 */
		function userTargets() {
			return snap.targets.filter(function (t) { return t.origin !== "system"; });
		}

		/** 宿主内置插件（默认折叠，避免淹没界面）。 */
		function systemTargets() {
			return snap.targets.filter(function (t) { return t.origin === "system"; });
		}

		/**
		 * 渲染一行候选项。
		 * @param t - 目标描述。
		 */
		function optionRow(t) {
			var on = !!picked[t.name];
			var clickable = t.restartable && !busy;
			// 同名条目：loader 里可能存在多个同名 fiber。宿主已按「运行中优先」
			// 选中代表条目，这里如实标注，免得用户以为重载的是另一个实例。
			var dupTip = t.ambiguous
				? "；该名字在 loader 里有 " + (t.duplicateCount || 2) + " 个条目，实际重载运行中的那个"
				: "";
			return react.createElement("div", {
				className: "sp-opt" + (clickable ? "" : " sp-off"),
				key: t.name,
				title: (clickable ? "点击加入白名单" : (STATE_LABEL[t.state] || "不可重载")) + dupTip,
				onClick: clickable ? function () { toggleTarget(t.name); } : undefined
			},
				react.createElement("span", { className: "sp-opt-name" }, t.name),
				t.ambiguous
					? react.createElement(Tag, { tone: "warning" }, "同名 " + (t.duplicateCount || 2))
					: null,
				t.restartable
					? (on
						? react.createElement(Tag, { tone: "info" }, "已选")
						: react.createElement(Tag, { tone: "outline" }, "可重载"))
					: react.createElement(Tag, { tone: "outline" }, STATE_LABEL[t.state] || "不可重载")
			);
		}

		/**
		 * 渲染下拉内容：用户插件一组、宿主内置一组。
		 *
		 * 搜索时**忽略折叠状态**并跨两组展示，避免「明明存在却搜不到」；
		 * 无关键词时系统组默认折叠，让界面聚焦在用户真正装过的插件上。
		 * 上限 60 行，超出提示继续输入。
		 */
		function renderOptions() {
			var searching = query.trim() !== "";
			var userHits = userTargets().filter(matches);
			var sysHits = systemTargets().filter(matches);
			var nodes = [];
			var LIMIT = 60;

			if (userHits.length > 0) {
				nodes.push(react.createElement("div", { className: "sp-opt-group", key: "__ug" },
					"用户安装的插件（" + userHits.length + "）"));
				nodes = nodes.concat(userHits.slice(0, LIMIT).map(optionRow));
			}

			// 搜索时始终展示系统插件命中项；无关键词时按折叠状态决定。
			var showSys = searching || showSystem;
			if (sysHits.length > 0 && showSys) {
				nodes.push(react.createElement("div", { className: "sp-opt-group", key: "__sg" },
					"宿主内置（" + sysHits.length + "）"));
				nodes = nodes.concat(sysHits.slice(0, LIMIT).map(optionRow));
			} else if (sysHits.length > 0) {
				nodes.push(react.createElement("div", {
					className: "sp-opt", key: "__toggle",
					onClick: function () { setShowSystem(true); }
				}, react.createElement("span", { className: "sp-opt-name" },
					"▸ 显示 " + sysHits.length + " 个宿主内置插件")));
			}

			if (userHits.length === 0 && sysHits.length === 0) {
				nodes.push(react.createElement("div", { className: "sp-empty", key: "__none" },
					"没有匹配的插件。"));
			}
			if (nodes.length > LIMIT) {
				nodes.push(react.createElement("div", { className: "sp-opt-group", key: "__more" },
					"结果较多，请继续输入以缩小范围。"));
			}
			return nodes;
		}

		/**
		 * 保存白名单并按白名单热重载。
		 *
		 * 这是本页的主操作：让「在加载时读一次 env」的插件重跑 apply()，从而
		 * 拿到刚保存的新值，**无需重启整个服务、不中断其他会话**。
		 */
		function applyWhitelist() {
			var names = pickedNames();
			if (names.length > 0) {
				var ok = window.confirm("将热重载以下插件：\\n\\n  " + names.join("\\n  ") +
					"\\n\\n这些插件会被卸载并立即重新加载，其连接/状态会重建。继续吗？");
				if (!ok) return;
			}
			setBusy(true);
			setResults(null);
			setSnap(function (prev) { return Object.assign({}, prev, { error: "", notice: "" }); });
			return post("/apply", { targets: names }).then(function (body) {
				setBusy(false);
				if (body && body.ok) {
					setResults(Array.isArray(body.reloaded) ? body.reloaded : []);
					var skipped = Array.isArray(body.skipped) ? body.skipped : [];
					// 未能重载的条目已被宿主从白名单剔除，这里明确告诉用户原因，
					// 否则勾了却"没选上"会让人困惑。
					var notice = body.message || "已应用。";
					if (skipped.length > 0) {
						notice += "\n未通过：" + skipped.map(function (s) {
							return s.name + "（" + (s.error || "失败") + "）";
						}).join("；");
					}
					setSnap(function (prev) { return Object.assign({}, prev, { notice: notice }); });
					return load();
				}
				setSnap(function (prev) {
					return Object.assign({}, prev, { error: (body && body.error) || "操作失败。" });
				});
			});
		}

		/**
		 * 重启宿主并等待恢复，然后刷新页面。
		 *
		 * 重启是破坏性操作（会中断所有进行中的会话），因此必须由用户显式点击；
		 * 这里先确认，再发起重启，然后轮询探针直到服务回来。
		 */
		function restart() {
			if (!window.confirm("重启 DSH 服务？\\n\\n会中断当前所有进行中的会话，页面将自动重连。\\n这是兜底手段：若只需让 dsh-sql 等插件读到新值，请改用上方的「热重载白名单」，那不会中断会话。")) return;
			setRestartMsg("正在重启…");
			post("/restart", {}).then(function (body) {
				if (!body || !body.ok) {
					setRestartMsg("重启请求失败：" + ((body && body.error) || "未知错误"));
					return;
				}
				var startedAt = Date.now();
				var timer = setInterval(function () {
					if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
						clearInterval(timer);
						setRestartMsg("等待服务恢复超时，请手动刷新页面。");
						return;
					}
					fetch(HEALTH_URL, { cache: "no-store" }).then(
						function (res) {
							if (!res.ok) return;
							clearInterval(timer);
							setRestartMsg("服务已恢复，正在刷新…");
							window.location.reload();
						},
						function () { /* 宿主已下线，继续轮询 */ }
					);
				}, POLL_INTERVAL_MS);
			});
		}

		var rows = snap.variables.map(function (item) {
			var editing = edit.key === item.key;
			// 只有「文件中定义」的变量才显示授权开关：进程内注入的变量（source=host）
			// 不在本页管理范围内，没有可写入的位置，给开关会误导用户以为开了就能读。
			var exposed = snap.expose.indexOf(item.key) !== -1;
			var exposeBox = react.createElement("input", {
				type: "checkbox",
				className: "sp-expose-box",
				checked: exposed,
				disabled: busy,
				onChange: function (e) { toggleExpose(item.key, e.target.checked); }
			});
			// 授权开关：独占行下方一层（见 .sp-row 两段式说明）。
			// 风险详情一律走 Tooltip —— 开关旁不再常驻大段文字，避免挤压掩码与按钮。
			//
			// ⚠️ 平台 Tooltip 会克隆它的 children 并读 `children.props["aria-describedby"]`
			// （ui-primitives lib/index.js:4855），因此**只接受单个元素**；传数组会让
			// `.props` 为 undefined 而抛错，把整个设置页插槽打崩（历史上踩过）。
			// 故这里一定用一个 <label> 包住「勾选框 + 文字」，风险标记作为同级兄弟节点。
			var exposeToggle = react.createElement("label", { className: "sp-expose-hit" },
				exposeBox,
				react.createElement("span", null, "允许模型读取")
			);
			var exposeCell = item.source === "file"
				? react.createElement("span", {
					className: "sp-expose" + (busy ? " sp-disabled" : ""),
					title: Tooltip === null ? EXPOSE_RISK_TIP : undefined
				},
					Tooltip !== null
						? react.createElement(Tooltip, {
							label: EXPOSE_RISK_TIP,
							side: "bottom",
							delayMs: 300,
							maxWidth: 380
						}, exposeToggle)
						: exposeToggle,
					// 勾选后才显示风险短标记：未勾选时该行不多占任何宽度，
					// 勾选时立刻在视线内给出「有代价」的信号，详情仍在 Tooltip 里。
					exposed
						? react.createElement("span", { className: "sp-expose-warn" }, EXPOSE_RISK_SHORT)
						: null
				)
				: null;
			// 变量名 + 备注气泡：备注挂在变量名上，悬停或键盘聚焦时由平台 Tooltip 弹出。
			// title 只在 Tooltip 取不到时（种子表缺件）才挂，两者**绝不同时存在** ——
			// 并存会让悬停约 1s 后浏览器原生气泡与自绘/平台气泡同屏出现。
			var keyNode = react.createElement("span", {
				className: "sp-keywrap" + (item.note ? " sp-has-note" : ""),
				title: item.note && Tooltip === null ? item.note : undefined
			},
				react.createElement("span", { className: "sp-key", tabIndex: item.note ? 0 : undefined }, item.key)
			);
			// delayMs 取 300：比平台贴边控件（500）灵一点，又不至于鼠标扫过就闪。
			// side=bottom 交给 Tooltip 自己在贴底时翻到上方（原自绘版本号称会翻转，其实没有）。
			var keyCell = item.note && Tooltip !== null
				? react.createElement(Tooltip, {
					label: item.note,
					side: "bottom",
					delayMs: 300,
					maxWidth: 320
				}, keyNode)
				: keyNode;
			// 两段式行：上段横向排「名称/值/操作」，下段放授权开关（独占一层，不争宽度）。
			return react.createElement("div", { className: "sp-row", key: item.key },
				react.createElement("div", { className: "sp-row-main" },
				keyCell,
				item.source === "host"
					? react.createElement(Tag, { tone: "warning" }, "进程内")
					: null,
				editing
					? react.createElement(react.Fragment, null,
						react.createElement("input", {
							className: "sp-input sp-input-mono",
							type: "text",
							value: edit.value,
							autoFocus: true,
							placeholder: "新值",
							onChange: function (e) { setEdit({ key: item.key, value: e.target.value, note: edit.note }); },
							onKeyDown: function (e) {
								if (e.key === "Enter") submitEdit();
								if (e.key === "Escape") setEdit({ key: "", value: "", note: "" });
							}
						}),
						react.createElement("input", {
							className: "sp-input",
							type: "text",
							value: edit.note,
							placeholder: "备注",
							maxLength: 200,
							onChange: function (e) { setEdit({ key: item.key, value: edit.value, note: e.target.value }); },
							onKeyDown: function (e) {
								if (e.key === "Enter") submitEdit();
								if (e.key === "Escape") setEdit({ key: "", value: "", note: "" });
							}
						})
					)
					: react.createElement("span", { className: "sp-mask" },
						item.hasValue ? "••••••" + (item.length ? " (" + item.length + " 字符)" : "") : "（空值）"),
				react.createElement("span", { className: "sp-actions" },
					editing
						? react.createElement(react.Fragment, null,
							react.createElement(Btn, { size: "sm", variant: "primary", disabled: busy, onClick: submitEdit }, "保存"),
							react.createElement(Btn, { size: "sm", variant: "ghost", onClick: function () { setEdit({ key: "", value: "", note: "" }); } }, "取消")
						)
						: react.createElement(react.Fragment, null,
							react.createElement(Btn, {
								size: "sm", variant: "outline",
								onClick: function () { setEdit({ key: item.key, value: "", note: item.note || "" }); }
							}, item.note ? "修改" : "改值/备注"),
							react.createElement(Btn, {
								size: "sm", variant: "danger", disabled: busy,
								onClick: function () { removeKey(item.key); }
							}, "删除")
						)
				)
				),
				exposeCell
			);
		});

		return react.createElement("div", { className: "sp-root" },
			react.createElement("p", { className: "sp-lead" },
				"管理注入 DSH 宿主的环境变量，保存后写入当前进程并持久化。"),
			snap.file ? react.createElement("p", { className: "sp-file" }, snap.file) : null,
			snap.legacyFile
				? react.createElement("p", { className: "sp-file" }, "旧文件（已保留为 .bak）：" + snap.legacyFile)
				: null,

			snap.error ? react.createElement("p", { className: "sp-err" }, snap.error) : null,
			snap.notice ? react.createElement("p", { className: "sp-ok" }, snap.notice) : null,

			react.createElement("div", { className: "sp-card" },
				react.createElement("h3", { className: "sp-card-title" }, "已配置变量"),
				snap.loading
					? react.createElement("div", { className: "sp-empty" }, "加载中…")
					: (rows.length === 0
						? react.createElement("div", { className: "sp-empty" }, "还没有配置任何环境变量。")
						: rows),
				react.createElement("p", { className: "sp-note" },
					"值为掩码显示；「进程内」表示仅存在于当前进程，点「修改」可纳入文件。")
			),

			react.createElement("div", { className: "sp-card" },
				react.createElement("h3", { className: "sp-card-title" }, "新增 / 更新变量"),
				react.createElement("div", { className: "sp-form" },
					react.createElement("input", {
						className: "sp-input sp-input-mono",
						type: "text",
						placeholder: "变量名，如 DINGTALK_REGISTRATION_SOURCE",
						value: draft.key,
						onChange: function (e) { setDraft({ key: e.target.value, value: draft.value, note: draft.note }); }
					}),
					react.createElement("input", {
						className: "sp-input",
						type: "password",
						placeholder: "值（敏感内容不会回显）",
						value: draft.value,
						onChange: function (e) { setDraft({ key: draft.key, value: e.target.value, note: draft.note }); },
						onKeyDown: function (e) { if (e.key === "Enter") submitNew(); }
					}),
					react.createElement("input", {
						className: "sp-input",
						type: "text",
						placeholder: "备注（可选），如：生产库密码",
						maxLength: 200,
						value: draft.note,
						onChange: function (e) { setDraft({ key: draft.key, value: draft.value, note: e.target.value }); },
						onKeyDown: function (e) { if (e.key === "Enter") submitNew(); }
					}),
					react.createElement(Btn, { variant: "primary", disabled: busy, onClick: submitNew }, "保存")
				)
			),

			react.createElement("div", { className: "sp-card" },
				react.createElement("h3", { className: "sp-card-title" }, "热重载白名单"),
				react.createElement("p", { className: "sp-note" },
					"选中那些只在启动时读一次环境变量的插件（如 dsh-sql），" +
					"点下方按钮即可让其重读新值，无需重启服务。"),

				// 已选芯片：先看选了什么，再看怎么加。
				react.createElement("div", { className: "sp-chips" },
					pickedNames().length === 0
						? react.createElement("span", { className: "sp-empty", style: { padding: 0 } }, "未选择任何插件。")
						: pickedNames().map(function (n) {
							return react.createElement("span", { className: "sp-chip", key: n },
								react.createElement("span", { className: "sp-chip-text", title: n }, n),
								react.createElement("button", {
									type: "button", className: "sp-chip-x", disabled: busy,
									title: "移出白名单",
									onClick: function () { toggleTarget(n); }
								}, "×")
							);
						})
				),

				// 可搜索下拉：168 条候选不可能平铺，改为输入过滤 + 分组展示。
				snap.loading
					? react.createElement("div", { className: "sp-empty" }, "加载中…")
					: react.createElement("div", { className: "sp-picker", ref: pickerRef },
						react.createElement("input", {
							className: "sp-input sp-input-mono",
							type: "text",
							placeholder: "搜索插件名，如 dsh-sql",
							value: query,
							onFocus: function () { setOpen(true); },
							onChange: function (e) { setQuery(e.target.value); setOpen(true); },
							onKeyDown: function (e) { if (e.key === "Escape") { setOpen(false); } }
						}),
						// 展开时提供显式关闭按钮：即使点击检测失效，用户也总有退路。
						open
							? react.createElement("button", {
								type: "button", className: "sp-picker-x", title: "收起列表",
								onClick: function () { setOpen(false); }
							}, "×")
							: null,
						open ? react.createElement("div", { className: "sp-panel" },
							renderOptions()
						) : null
					),

				results && results.length > 0
					? react.createElement("div", null,
						react.createElement("p", { className: "sp-note" }, "上次热重载结果："),
						results.map(function (r) {
							return react.createElement("div", { className: "sp-result", key: r.name },
								react.createElement("span", { className: r.ok ? "sp-result-ok" : "sp-result-err" },
									(r.ok ? "✓ " : "✗ ") + r.name + (r.ok ? " 已重载" : "：" + (r.error || "失败"))));
						}))
					: null,
				// 卡片内**只放一个按钮**：保存并热重载。
				//
				// 为什么把其它按钮移出去：本卡片的标题是「热重载白名单」，而
				// 「重新加载文件」「重启服务」「刷新」的作用范围都**不止白名单**
				// （分别是重读整个文件并注入进程、重启整个宿主、重拉全部数据）。
				// 把它们摆在这里，位置本身就在暗示「这是保存白名单的一部分」——
				// 「重启服务」尤其危险：它会中断所有进行中的会话，却被放在一个
				// 看起来无害的白名单卡片里。故移到卡片之外的「全局操作」区
				// （见下方 sp-global 区块）。
				react.createElement("div", { className: "sp-footer" },
					react.createElement(Btn, { variant: "primary", disabled: busy, onClick: applyWhitelist },
						pickedNames().length > 0
							? "保存并热重载 " + pickedNames().length + " 个插件"
							: "保存白名单（不重载）")
				)
			),

			// ── 全局操作区 ──
			// 不属于任何卡片：这三个动的是**整份文件**或**整个宿主进程**，
			// 与上面各个卡片各自的设置无关。单独成区并明确标注范围，避免
			// 用户误以为它们只影响刚刚编辑的那一张卡片。
			react.createElement("div", { className: "sp-global" },
				react.createElement("div", { className: "sp-global-head" },
					react.createElement("h3", { className: "sp-card-title" }, "全局操作"),
					react.createElement("span", { className: "sp-global-hint" },
						"作用于整份参数文件与宿主进程，不只是上方某一项设置。")),
				react.createElement("div", { className: "sp-footer" },
					react.createElement(Btn, { variant: "outline", disabled: busy, onClick: reload }, "重新加载文件"),
					react.createElement(Btn, { variant: "ghost", disabled: busy, onClick: load }, "刷新"),
					react.createElement("span", { className: "sp-spacer" }),
					// 危险操作排在最右，与上面两个拉开距离，降低误点概率。
					react.createElement(Btn, { variant: "danger", disabled: busy, onClick: restart }, "重启服务")
				)
			),

			restartMsg ? react.createElement("div", { className: "sp-busy" },
				react.createElement("div", { className: "sp-busy-card" }, restartMsg)) : null
		);
	}


	// ───────────────────────── 插件详情页扩展（参数放行提示） ─────────────────────────
	//
	// 本插件只做一件与插件详情页有关的事：**如实告诉用户「这个插件已在参数放行
	// 名单里」**，以及当前一共有几个环境变量处于放行状态。
	//
	// ## 为什么这里不再列「这个插件需要哪些变量」
	//
	// 按用户的设计裁决：**用户照插件文档自己定义参数，本插件只按白名单放行。**
	// 因此「某个插件需要哪些变量」这个信息：
	//  - **用户本来就知道**（他就是照文档配的），不需要我们替他猜；
	//  - 我们**也猜不准**：插件源码里的变量名可能是运行时拼出来的，静态扫描原理上
	//    就扫不到；去读它的 cordis 配置则是另一种越界（读别人配置猜变量名）。
	//
	// 历史上有过两个「猜」的实现（扫描第三方插件源码、登记 dsh-sql 的连接密码），
	// 都已按设计裁决**删除**，详见宿主 `lib/index.js` 顶部的「设计边界」一节。
	// **不要在这里或宿主里重新引入任何猜测逻辑。**
	//
	// ## 展示的三态（只有「在不在名单」这一个判据）
	//
	//  - **不在白名单** → 整块与徽章都不显示（保持既有的白名单门槛，无关插件
	//    的详情页上不留任何痕迹）；
	//  - **在白名单** → 显示「该插件已在参数放行名单中」+ 已放行的变量总数；
	//  - 加载中 → 显示占位文案，避免标题行闪烁。
	//
	// ⚠️ **不得**再出现「未能读取 / 未能自动发现该插件的连接配置」这类措辞 ——
	// 本插件已不再试图去读任何插件，那种提示现在是无中生有的故障暗示。

	/**
	 * 从 subject 取出「贡献者关心的包名」。
	 *
	 * 三形态里只有 bundle / row 带包名，item 是一个不透明的官方插件 id（如
	 * `ui-settings-general`），与 npm 包名不同源，故一律不管。
	 * @param {object} subject - plugins.detail.* 传入的 subject。
	 * @returns {string|null} 包名；非目标 subject 返回 null。
	 */
	function detailPackageName(subject) {
		if (!subject || typeof subject !== "object") return null;
		if (subject.kind === "bundle" || subject.kind === "row") {
			var pkg = subject.pkg;
			return pkg && typeof pkg.name === "string" ? pkg.name : null;
		}
		return null;
	}

	/**
	 * 读取该插件是否在参数放行名单中，以及当前放行的变量总数。
	 *
	 * 数据全部来自宿主 `/list` 的 `whitelist`（用户声明的放行名单，即
	 * `params.yml` 的 `reload.targets`）与 `variables`（用户定义的参数，即
	 * `params.yml` 的 `variables` 映射）。**两者都是用户写下的事实**，不含任何
	 * 由本插件推断出来的内容 —— 这正是本次改造要守住的边界。
	 *
	 * 只数**用户在 `params.yml` 里定义的**参数条数（`source: "file"`），不发
	 * 变量名也不发值（`/list` 本来就只回掩码）。`/list` 的 `variables` 还会带上
	 * 宿主进程里已有的同类变量（`source: "host"`），那些不是用户为插件配的参数，
	 * 必须排除 —— 否则「已放行 N 个」会虚报。
	 * @param {object} subject - plugins.detail.* 传入的 subject。
	 * @param {number} tick - 自增可触发重新拉取（区块的「刷新状态」）。
	 * @returns {object} `{ loading, error, allowed, variableCount }`。
	 */
	function useReleaseState(subject, tick) {
		var pkgName = detailPackageName(subject);
		var state = react.useState({ loading: true, error: "", allowed: false, variableCount: 0, names: [] });
		var snap = state[0];
		var setSnap = state[1];

		react.useEffect(function () {
			if (pkgName === null) return undefined;
			var alive = true;
			setSnap(function (prev) { return Object.assign({}, prev, { loading: true, error: "" }); });
			// 复用宿主已有的 /list 路由：白名单与变量总数来自**同一次请求**，
			// 否则两者之间用户改了配置，会显示出「已在名单中」却配了 0 个变量的
			// 自相矛盾画面。
			request("/list").then(function (body) {
				if (!alive) return;
				if (!body || !body.ok) {
					setSnap({
						loading: false,
						error: (body && body.error) || "读取参数状态失败。",
						allowed: false,
						variableCount: 0,
						names: []
					});
					return;
				}
				var whitelist = Array.isArray(body.whitelist) ? body.whitelist : [];
				var variables = Array.isArray(body.variables) ? body.variables : [];
				// 只取 `source === "file"` 的那些，即**用户在 params.yml 里定义的**
				// 参数。`/list` 的 `variables` 还包含宿主进程里已存在的同类变量
				// （`source: "host"`，如 DSH_HOME/DSH_PROFILE），那不是用户为插件
				// 配的参数，计入会虚报「已放行 N 个」—— 而不虚报正是本次改造的
				// 出发点（宁可少说，不要说假话）。
				//
				// 顺带把名字与「是否已填值」带出来供卡片罗列。**只带名字与状态，
				// 不带值**：`/list` 本身就不回传明文，这里也不能破例。
				var configured = variables
					.filter(function (v) { return v && v.source === "file"; })
					.map(function (v) {
						return {
							key: typeof v.key === "string" ? v.key : "",
							note: typeof v.note === "string" ? v.note : "",
							hasValue: v.hasValue === true
						};
					})
					.filter(function (v) { return v.key !== ""; });
				setSnap({
					loading: false,
					error: "",
					allowed: whitelist.indexOf(pkgName) !== -1,
					variableCount: configured.length,
					names: configured
				});
			});
			return function () { alive = false; };
			// 包名变化才重取；subject 对象每次重渲染都是新引用，不能进依赖数组。
		}, [pkgName, tick]);

		if (pkgName === null) return null;
		return {
			loading: snap.loading,
			error: snap.error,
			allowed: snap.allowed,
			variableCount: snap.variableCount,
			names: snap.names,
			pkgName: pkgName
		};
	}

	/**
	 * 详情页标题旁的徽章：在放行名单里时显示「已放行 N 个环境变量」。
	 *
	 * 不在名单 → 返回 null（页面不留痕迹）。徽章只有一句话的篇幅，因此只放结论；
	 * 明细与「怎么改」交给下方区块。
	 * @param {object} props - `{ subject }`。
	 * @returns {object|null} React 元素或 null。
	 */
	function EnvKeyBadge(props) {
		var view = useReleaseState(props.subject, 0);
		if (view === null || !view.allowed) return null;
		if (view.loading) {
			return react.createElement("span", { className: "sp-tag sp-tag-outline" }, "参数放行");
		}
		return react.createElement("span", {
			className: "sp-tag " + (view.variableCount > 0 ? "sp-tag-ok" : "sp-tag-warning"),
			title: view.variableCount > 0
				? "本插件已在参数放行名单中，当前共放行 " + view.variableCount + " 个环境变量。"
				: "本插件已在参数放行名单中，但尚未配置任何环境变量（可在 dsh-settings-params 的插件页里添加）。"
		}, "已放行 " + view.variableCount + " 个环境变量");
	}

	/**
	 * 详情页底部的「参数放行」区块。
	 *
	 * 回答两个问题：这个插件归不归本页管（在不在放行名单）、当前放行了几个变量。
	 * 对不在名单里的插件返回 null。**不列任何变量名** —— 那是用户照插件文档自己
	 * 定义的，本插件不猜也不展示。
	 * @param {object} props - `{ subject }`。
	 * @returns {object|null} React 元素或 null。
	 */
	function EnvKeySection(props) {
		// 触发重新拉取（区块里的「刷新状态」按钮）。
		var tickState = react.useState(0);
		var tick = tickState[0];
		var setTick = tickState[1];
		var view = useReleaseState(props.subject, tick);

		if (view === null || !view.allowed) return null;

		var count = view.variableCount;
		// 刷新控件：**图标按钮**放在卡片右上角（用户要求，替代原先底部的文字按钮）。
		// 平台图标自带描边风格，颜色走 currentColor 因而跟随主题；hover 由样式给
		// 背景与前景变化，title 同时提供原生悬停提示（Tooltip 可用时优先用它，
		// 与页面其它提示保持同一套气泡）。
		var refreshIcon = IconRefresh !== null
			? react.createElement(IconRefresh, { size: 16 })
			: react.createElement("span", { className: "sp-rel-refresh-text" }, "刷新");
		var refreshBtn = react.createElement("button", {
			type: "button",
			className: "sp-rel-refresh",
			disabled: view.loading,
			"aria-label": "刷新状态",
			title: Tooltip === null ? "刷新状态" : undefined,
			onClick: function () { setTick(tick + 1); }
		}, refreshIcon);
		return react.createElement("section", { className: "sp-env-section" }, [
			// 标题只留「参数放行 + 已放行 N 个」。**不再重复**说明该插件在名单里、
			// 也不重复「去参数设置里配」—— 那些信息标题旁的徽章与设置页已经表达，
			// 这里再说一遍纯属噪音（用户明确要求删掉）。
			// 刷新图标靠 .sp-env-head 的 margin-left:auto 推到最右。
			react.createElement("div", { className: "sp-env-head", key: "head" }, [
				react.createElement("h3", { className: "sp-card-title", key: "t" }, "参数放行"),
				react.createElement("span", {
					className: "sp-tag " + (count > 0 ? "sp-tag-ok" : "sp-tag-warning"),
					key: "s"
				}, view.loading ? "读取中…" : "已放行 " + count + " 个"),
				Tooltip !== null
					? react.createElement(Tooltip, { label: "刷新状态", side: "bottom", delayMs: 300, key: "r" }, refreshBtn)
					: react.createElement(react.Fragment, { key: "r" }, refreshBtn)
			]),
			// 逐条列出**实际放行了哪些参数** —— 这是本卡片唯一不可替代的内容：
			// 用户要能在这里确认「我配的那几个确实放行了」。只显示名字与是否已填值，
			// **不回传任何值**（值永不进浏览器，这是本插件一贯的安全约定）。
			count > 0
				? react.createElement("ul", { className: "sp-rel-list", key: "list" },
					view.names.map(function (item) {
						return react.createElement("li", { className: "sp-rel-row", key: item.key }, [
							react.createElement("code", { className: "sp-rel-key", key: "k" }, item.key),
							item.note
								? react.createElement("span", { className: "sp-rel-note", key: "n" }, item.note)
								: null,
							react.createElement("span", {
								className: "sp-tag " + (item.hasValue ? "sp-tag-ok" : "sp-tag-warning"),
								key: "s"
							}, item.hasValue ? "已填值" : "未填值")
						]);
					})
				)
				: null,
			// 一句话说明来源即可（用户明确要求「一句话就行」，故删掉了原来那段
			// 「本插件不推断…唯一来源…」的长解释 —— 那段对使用者是噪音）。
			react.createElement("p", { className: "sp-lead", key: "desc" },
				"参数在 dsh-settings-params 的插件页里定义。")
			// 刷新已移到卡片右上角（图标按钮），故这里不再有底部按钮。
			// 也**不再渲染 view.error**：拉取失败时 allowed 必为 false，上面的
			// `!view.allowed` 守卫已经把整块返回 null，那个分支永远走不到 ——
			// 失败时卡片保持安静，重试入口就是右上角的刷新图标。
		]);
	}

	/**
	 * 客户端插件入口：注入样式并把「参数设置」页挂进设置导航，
	 * 同时向插件详情页贡献「参数放行」徽章与区块。
	 * @param {object} ctx - cordis 客户端上下文。
	 */
	function apply(ctx) {
		installStyles();

		// 参数设置页挂在**本插件自己的 bundle 详情页**上（用户要求，取代原先的
		// 设置导航分页）。
		//
		// 选这个槽位的理由：`plugins.bundle.config` 是「某个组合包自己的配置页」，
		// 而本插件本身就是一个组合包（package.json 声明了 dsh.bundle.patch，且在
		// profile 的 dsh.profile.bundles 里）。参数设置管的是**全局**的变量池，
		// 挂在「参数插件自己」的页面上，语义是自洽的。
		//
		// ⚠️ 该槽位的 `form` 是**可选**的（ownerProps 里写的是 `form?: …`），
		// 插件管理页渲染时也只传 `{ view: 'page' }` 而不传 form。因此这里可以
		// 继续用本插件自有的 /dsh-settings-params/* 路由读写 params.yml，不必改
		// 成 Host 的 settings 存储。官方 voice-input 就是这种用法（它用自己的
		// props.configure），是现成先例。
		//
		// key 必须等于**包名**：owner 按包名分派（renderSlot 的 entryKey = pkg.name）。
		ctx.slots.inject("plugins.bundle.config", function () {
			return ctx.slots.register({
				name: "plugins.bundle.config",
				key: name
			}, ParamsSection);
		});

		// 插件详情页的两个贡献。
		//
		// 必须走 slots.inject：plugins.detail.* 是插件管理页的**子槽位**，由它的 main
		// 条目声明，只在页面挂载期间存在；直接 register 未声明的槽位会抛错（见 SPEC
		// 第 4.1 节）。inject 会等到声明出现再注册，声明塌陷后自动重注册。
		//
		// id 用自有命名，避免与官方条目撞格；order 排在官方条目之后（默认 0），
		// 让「我们的提示」稳定落在页面自带内容的下方/后方。
		ctx.slots.inject("plugins.detail.badge", function () {
			return ctx.slots.register({
				name: "plugins.detail.badge",
				id: "dsh-settings-params-envkeys",
				order: 100
			}, EnvKeyBadge);
		});
		ctx.slots.inject("plugins.detail.section", function () {
			return ctx.slots.register({
				name: "plugins.detail.section",
				id: "dsh-settings-params-envkeys",
				order: 100
			}, EnvKeySection);
		});
	}

	exports.apply = apply;
	exports.inject = inject;
	exports.name = name;
	return module.exports;
}});
