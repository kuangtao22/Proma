import { atom } from 'jotai'

/** 仍挂载的模态内容数量；退出动画期间继续计入，嵌套弹窗独立释放。 */
export const browserModalCountAtom = atom(0)

/** 原生网页只订阅是否需要避让，避免多个弹窗切换时重复发布布局。 */
export const browserModalActiveAtom = atom((get) => get(browserModalCountAtom) > 0)
