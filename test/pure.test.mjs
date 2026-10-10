/**
 * 纯逻辑单测（不需要浏览器、不需要任何依赖）。
 *
 * 在 node:vm 里加载 lib/client.js —— 只跑模块顶层，因此不碰 DOM；
 * 然后直接测两个纯函数：文案换算与「是否最高档」判定。
 * 另外校验仓库里的 lib/client.js 没有落后于 src/client.js。
 *
 *   npm test
 *
 * 涉及 DOM / React / 颜色级联的断言在 test/dom-test.html 里，用浏览器打开跑。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { bundleOf } from '../scripts/build.mjs'

const root = new URL('../', import.meta.url)

/**
 * 在隔离上下文里加载客户端产物。
 *
 * @returns 插件导出对象（apply / inject / __test）。
 */
function loadPlugin() {
	let plugin
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(definition) {
					plugin = definition.factory(() => ({}))
				}
			}
		}
	}
	runInContext(readFileSync(new URL('lib/client.js', root), 'utf8'), createContext(sandbox))
	return plugin
}

const plugin = loadPlugin()
const { freedomLabel, isTopEffort, EFFORT_ATTRIBUTE, EFFORT_MAX } = plugin.__test

/** 造一个 ModelDirectory 快照。 */
function snapshot(efforts, selected, defaultEffort = 'high') {
	return {
		current: { provider: 'p', model: 'm', reasoningEffort: selected },
		groups: [{ id: 'p', models: [{ id: 'm', reasoning: { efforts, defaultEffort } }] }]
	}
}

const FOUR = [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }]

test('文案：中文分秒换算为 xmxs', () => {
	assert.equal(freedomLabel('深度求索中，用时 1分23秒 ···'), 'FREEDOM DiViNG，1m23s...')
	assert.equal(freedomLabel('深度求索中，用时 24分4秒 ···'), 'FREEDOM DiViNG，24m4s...')
})

test('文案：不足一分钟补成 0m', () => {
	assert.equal(freedomLabel('深度求索中，用时 23秒 ···'), 'FREEDOM DiViNG，0m23s...')
})

test('文案：英文界面同样是 xmxs', () => {
	assert.equal(freedomLabel('Deep diving for 1m 23s ···'), 'FREEDOM DiViNG，1m23s...')
})

test('文案：尚未开始计时时没有数字', () => {
	assert.equal(freedomLabel('深度求索中'), 'FREEDOM DiViNG')
	assert.equal(freedomLabel('Deep diving'), 'FREEDOM DiViNG')
})

test('文案：幂等（重复处理不会叠加前缀）', () => {
	assert.equal(freedomLabel('FREEDOM DiViNG，1m23s...'), 'FREEDOM DiViNG，1m23s...')
	assert.equal(freedomLabel('FREEDOM DiViNG'), 'FREEDOM DiViNG')
})

test('档位：四档模型只有最后一档算 max', () => {
	assert.equal(isTopEffort(snapshot(FOUR, 'max')), true)
	assert.equal(isTopEffort(snapshot(FOUR, 'high')), false)
	assert.equal(isTopEffort(snapshot(FOUR, 'low')), false)
	assert.equal(isTopEffort(snapshot(FOUR, 'off')), false)
})

test('档位：未显式选择时按目录给的默认档', () => {
	assert.equal(isTopEffort(snapshot(FOUR, undefined, 'high')), false)
	assert.equal(isTopEffort(snapshot(FOUR, undefined, 'max')), true)
})

test('档位：档位名字不叫 max 也能认出最高档', () => {
	const named = [{ id: 'fast' }, { id: 'deep' }, { id: 'deepest' }]
	assert.equal(isTopEffort(snapshot(named, 'deepest')), true)
	assert.equal(isTopEffort(snapshot(named, 'deep')), false)
})

test('档位：目录尚未加载时按官方档位名兜底', () => {
	assert.equal(isTopEffort({ current: { provider: 'p', model: 'm', reasoningEffort: 'max' }, groups: [] }), true)
	assert.equal(isTopEffort({ current: { provider: 'p', model: 'm', reasoningEffort: 'high' }, groups: [] }), false)
})

test('档位：无推理能力或空快照都不上色', () => {
	assert.equal(isTopEffort({ current: { provider: 'p', model: 'm' }, groups: [{ id: 'p', models: [{ id: 'm' }] }] }), false)
	assert.equal(isTopEffort({ current: null, groups: [] }), false)
	assert.equal(isTopEffort(null), false)
	assert.equal(isTopEffort(undefined), false)
})

test('标记属性名与取值稳定（CSS 依赖它们）', () => {
	assert.equal(EFFORT_ATTRIBUTE, 'data-freedom-diving')
	assert.equal(EFFORT_MAX, 'max')
})

test('导出面：apply / inject', () => {
	assert.equal(typeof plugin.apply, 'function')
	// vm 上下文里的数组与宿主的不是同一个 realm，比较内容而不是原型。
	assert.deepEqual(Array.from(plugin.inject), ['slots'])
})

test('仓库里的 lib/client.js 与 src/client.js 同步', () => {
	const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
	const source = readFileSync(new URL('src/client.js', root), 'utf8')
	const built = readFileSync(new URL('lib/client.js', root), 'utf8')
	assert.equal(built, bundleOf(pkg.name, source), 'lib/client.js 过期了：请运行 npm run build 并提交产物')
})

test('产物被包在 DSH 客户端加载器约定里', () => {
	const built = readFileSync(new URL('lib/client.js', root), 'utf8')
	assert.ok(built.startsWith('window.__ModuleLoader__.load({id:"dsh-client-freedom-diving",factory:(require)=>{'))
	assert.ok(built.trimEnd().endsWith('return module.exports;}});'))
})
