/**
 * 宿主端（Cordis）半个插件。
 *
 * FREEDOM DiViNG 只改浏览器里的显示，不需要任何宿主能力，所以这里是一个
 * 空实现 —— 但保留它，让这个包作为 profile bundle 也能被正常挂载。
 */

/** 插件名（Cordis 用）。 */
export const name = "dsh-client-freedom-diving"

/** 不注册任何宿主能力。 */
export function apply() {}
