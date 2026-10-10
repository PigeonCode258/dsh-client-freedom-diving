/**
 * 把 src/client.js 包成 DSH 客户端模块加载器认识的格式，输出 lib/client.js。
 *
 * 不用 esbuild / 任何依赖：源码本身就是浏览器可直接跑的 CommonJS 风格代码，
 * 只差外面这层 `window.__ModuleLoader__.load({ id, factory })` 包装。
 * 因此安装方只需要拷贝 lib/client.js，不需要在他们的机器上装构建工具。
 *
 *   node scripts/build.mjs
 *
 * 同时导出 {@link bundleOf}，供 test/pure.test.mjs 校验仓库里的产物没有过期。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = new URL("../", import.meta.url)

/**
 * 生成客户端产物内容。
 *
 * @param packageName - 包名，写进 loader 的 id。
 * @param source - src/client.js 的内容。
 * @returns lib/client.js 应有的全文。
 */
export function bundleOf(packageName, source) {
	const banner = `window.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n`
	const footer = `\nreturn module.exports;}});\n`
	return banner + source + footer
}

/**
 * 读取包清单与源码，算出产物路径与内容（不写盘）。
 *
 * @returns `{ target, contents }`。
 */
export function buildClientBundle() {
	const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
	const source = readFileSync(new URL("src/client.js", root), "utf8")
	return {
		target: fileURLToPath(new URL("lib/client.js", root)),
		contents: bundleOf(pkg.name, source)
	}
}

/**
 * 写出 lib/client.js。
 *
 * @returns `{ target, contents }`。
 */
export function build() {
	const { target, contents } = buildClientBundle()
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, contents)
	return { target, contents }
}

// 只有被当成命令直接执行时才写盘；被 import 时保持纯函数。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { target, contents } = build()
	console.log(`built ${target} (${Buffer.byteLength(contents)} bytes)`)
}
