/**
 * FREEDOM DiViNG —— DSH 客户端插件（可读源码）
 *
 * 作用有三个，全部只在浏览器端生效：
 *   1. 把「正在思考」那一行的文案换成 `FREEDOM DiViNG，xmxs...`；
 *   2. 推理强度选到最高档（max）时，把那行文字染成帝王金；
 *   3. 其它强度、以及原有的从左到右高亮扫过特效（TextShimmer）保持原样。
 *
 * 实现方式刻意保持「不碰任何官方代码」：
 *   - 文案：结构定位 `[data-chat-running] > [data-shimmer]`，就地改文本节点，
 *     所以任何语言、任何版本的原始文案都能识别，且反复执行结果一致（幂等）。
 *   - 颜色：往 <head> 注入一条只在 `html[data-freedom-diving=max]` 下命中的规则，
 *     覆盖 `color` 与 `--dsw-alias-label-shimmer`（扫过的高亮色）。
 *   - 强度：借 composer 的 `conversation.input.right` 插槽拿 sessionId，
 *     订阅该会话的 ModelDirectory，把当前档位写进 `html[data-freedom-diving]`。
 *     这是官方模型选择器同一个数据源，因此滑块 / 菜单 / 命令面板改档位都会同步。
 *
 * 依赖的只有宿主提供的 `react`，以及官方服务 `slots`、`modelDirectories`。
 */

const React = require("react")

const PACKAGE_ID = "dsh-client-freedom-diving"

/** 文案前缀，注意用的是全角逗号，与用户要求一致。 */
const PREFIX = "FREEDOM DiViNG"
/** 帝王金：正文与扫过的高亮。 */
const GOLD = "#f2c14e"
const GOLD_SHIMMER = "#fff0b0"

/** 承载当前推理强度的标记属性；只有等于 `max` 时颜色规则才命中。 */
const EFFORT_ATTRIBUTE = "data-freedom-diving"
const EFFORT_MAX = "max"

const RUNNING_SELECTOR = "[data-chat-running]"
const SHIMMER_SELECTOR = "[data-shimmer]"
const SHIMMER_COPY_SELECTOR = "[data-shimmer-text]"

/**
 * 官方档位名兜底：目录还没加载完时，只有官方 `max` 这一档算最高。
 * 目录加载完成后一律以「档位列表最后一档」为准，改档位名字也不会失效。
 */
const FALLBACK_TOP_EFFORT = "max"

// ---------------------------------------------------------------- 文案换算

/**
 * 把官方渲染出来的耗时读成 `xm xs`。
 *
 * 输入永远是官方 `duration.compactSeconds` / `duration.compactMinutes`
 * 拼出来的本地化文本（中文 `1分23秒`、英文 `1m 23s`），这里只认数字加单位，
 * 因此不依赖语言，也不会误伤其它内容。
 *
 * @param label - 官方当前渲染的整行文字。
 * @returns 替换后的整行文字；没有数字就是尚未开始计时的那一档。
 */
function freedomLabel(label) {
	const minutes = /(\d+)\s*[分mM]/.exec(label)
	const seconds = /(\d+)\s*[秒sS]/.exec(label)
	if (minutes === null && seconds === null) return PREFIX
	const m = minutes === null ? 0 : Number(minutes[1])
	const s = seconds === null ? 0 : Number(seconds[1])
	return `${PREFIX}，${m}m${s}s...`
}

/**
 * 找到真实文案所在的文本节点。
 *
 * TextShimmer 的真实文案结构是
 * `[data-shimmer] > .content > .text > "文字"`，
 * 类名带 CSS Module 哈希，所以这里只沿「第一个子元素」一路下降，不猜类名，
 * 也不会被源码缩进/换行之类的空白文本节点带偏；装饰层是根节点的第二个
 * 子元素，不会被走到。
 *
 * @param root - `[data-shimmer]` 根节点。
 * @returns 承载文案的文本节点，或 null。
 */
function labelTextNode(root) {
	let element = root
	for (;;) {
		const next = element.firstElementChild
		if (next === null) break
		element = next
	}
	const node = element.firstChild
	return node !== null && node.nodeType === 3 ? node : null
}

/**
 * 改写一个运行指示行。
 *
 * TextShimmer 会把同一段文字渲染两份：真实内容是可选中、可朗读的文本节点，
 * 扫过的高亮层则用 `data-shimmer-text` 属性 + `content: attr(...)` 复制一份。
 * 两份都要改，否则金色高亮扫过时会露出旧文案。
 *
 * 文本节点用 `nodeValue` 原地修改（而不是重建节点），这样 React 每秒刷新
 * 计时器时仍然写的是同一个节点，不会因为节点被替换而卡住不走。
 *
 * @param shimmer - `[data-shimmer]` 根节点。
 * @returns 本次是否真的写入了内容。
 */
function applyLabel(shimmer) {
	const node = labelTextNode(shimmer)
	if (node === null) return false

	const next = freedomLabel(node.nodeValue)
	if (node.nodeValue === next && shimmer.getAttribute("data-freedom-diving-label") === next) return false

	if (node.nodeValue !== next) node.nodeValue = next
	for (const copy of shimmer.querySelectorAll(SHIMMER_COPY_SELECTOR)) {
		if (copy.getAttribute("data-shimmer-text") !== next) copy.setAttribute("data-shimmer-text", next)
	}
	// 记下最后一次写入值，避免自己触发的 mutation 再走一遍完整比对。
	shimmer.setAttribute("data-freedom-diving-label", next)
	return true
}

/**
 * 跟随 DOM 变化持续改写运行指示行。
 *
 * 会话流式输出期间 DOM 变动非常频繁，所以用一次 requestAnimationFrame 合并
 * 同一帧内的所有通知；每帧最多一次 `querySelectorAll`。
 *
 * @returns 解除监听的函数。
 */
function startLabelSync() {
	let scheduled = false
	const flush = () => {
		scheduled = false
		for (const running of document.querySelectorAll(RUNNING_SELECTOR)) {
			const shimmer = running.querySelector(SHIMMER_SELECTOR)
			if (shimmer !== null) applyLabel(shimmer)
		}
	}
	const schedule = () => {
		if (scheduled) return
		scheduled = true
		requestAnimationFrame(flush)
	}
	const observer = new MutationObserver(schedule)
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
		characterData: true,
		attributes: true,
		attributeFilter: ["data-shimmer-text"]
	})
	flush()
	return () => observer.disconnect()
}

// ---------------------------------------------------------------- 颜色规则

/**
 * 注入金色规则。
 *
 * 选择器是结构化的（不依赖 CSS Module 的哈希类名）：
 * 只有 `html` 上带着 `=max` 标记时，运行指示行的文字才变成帝王金。
 * `--dsw-alias-label-shimmer` 决定扫过那道高亮的颜色，覆盖后特效仍在，
 * 只是由浅蓝变成浅金。
 *
 * @returns 移除样式标签的函数。
 */
function installStyles() {
	const style = document.createElement("style")
	style.dataset.plugin = PACKAGE_ID
	style.textContent =
		`html[${EFFORT_ATTRIBUTE}=${EFFORT_MAX}] ${RUNNING_SELECTOR} ${SHIMMER_SELECTOR}` +
		`{color:${GOLD};--dsw-alias-label-shimmer:${GOLD_SHIMMER}}`
	document.head.append(style)
	return () => style.remove()
}

// ------------------------------------------------------------ 强度探针组件

/**
 * 判断当前选中的档位是不是最高档。
 *
 * @param snapshot - ModelDirectory 快照（`current` 为当前选择，`groups` 为目录）。
 * @returns 是否处于最高推理强度。
 */
function isTopEffort(snapshot) {
	const current = snapshot === null || snapshot === undefined ? null : snapshot.current
	if (current === null || current === undefined) return false

	const groups = snapshot.groups === undefined ? [] : snapshot.groups
	const group = groups.find((item) => item.id === current.provider)
	const model = group === undefined ? undefined : group.models.find((item) => item.id === current.model)
	const reasoning = model === undefined ? undefined : model.reasoning

	const selected = current.reasoningEffort ?? (reasoning === undefined ? undefined : reasoning.defaultEffort)
	if (selected === undefined || selected === null) return false

	const efforts = reasoning === undefined || reasoning.efforts === undefined ? [] : reasoning.efforts
	if (efforts.length > 1) return efforts[efforts.length - 1].id === selected
	return selected === FALLBACK_TOP_EFFORT
}

/**
 * 无渲染的探针：把「当前是否 max」写进根元素的属性。
 *
 * 挂在 composer 的插槽里只是为了拿到 sessionId —— 官方每个会话的模型目录
 * 都由 `modelDirectories.directoryFor(sessionId)` 提供，这里复用同一个数据源。
 *
 * `directory` 允许为 null（那台机器的模型选择器没提供该服务时）：此时只有
 * 颜色功能静默降级，文案替换不受影响。
 *
 * @param props.directory - 该会话的共享目录 store（subscribe/getSnapshot），或 null。
 * @param props.load - 触发目录加载，保证档位列表可用。
 * @returns 永远不渲染任何节点。
 */
function EffortProbe({ directory, load }) {
	const subscribe = React.useCallback(
		(listener) => (directory === null ? () => {} : directory.subscribe(listener)),
		[directory]
	)
	const snapshot = React.useSyncExternalStore(subscribe, () => (directory === null ? null : directory.getSnapshot()))

	React.useEffect(() => {
		load()
	}, [load])

	const atMax = isTopEffort(snapshot)
	React.useEffect(() => {
		document.documentElement.setAttribute(EFFORT_ATTRIBUTE, atMax ? EFFORT_MAX : "off")
	}, [atMax])

	React.useEffect(() => () => {
		document.documentElement.removeAttribute(EFFORT_ATTRIBUTE)
	}, [])

	return null
}

// ------------------------------------------------------------------ 插件体

/**
 * 客户端服务依赖。
 *
 * 只声明会直接调用的 `slots`；模型目录用 `ctx.get("modelDirectories")` 惰性获取，
 * 这样即使那台机器的 DSH 没有这个服务，文案替换也照样生效。
 */
const inject = ["slots"]

/**
 * 挂载样式、文案同步与强度探针。
 *
 * @param ctx - 客户端根上下文。
 */
function apply(ctx) {
	ctx.effect(() => installStyles(), "freedom-diving: gold label rule")
	ctx.effect(() => startLabelSync(), "freedom-diving: label sync")
	ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
		name: "conversation.input.right",
		id: PACKAGE_ID,
		order: 40,
		inject: (sessionId) => {
			const models = ctx.get("modelDirectories")
			if (models === undefined || models === null) return { directory: null, load: () => {} }
			const directory = models.directoryFor(sessionId)
			return {
				directory: directory.store,
				load: () => {
					try {
						directory.load().catch(() => {})
					} catch {
						// 目录不可用时保持原样，只有文案替换继续生效。
					}
				}
			}
		}
	}, EffortProbe))
}

/**
 * 导出。`__test` 只给 test/dom-test.html 用，DSH 只读 apply / inject。
 */
module.exports = {
	apply,
	inject,
	__test: { freedomLabel, applyLabel, startLabelSync, installStyles, isTopEffort, EFFORT_ATTRIBUTE, EFFORT_MAX }
}
