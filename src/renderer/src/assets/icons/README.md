# 图标资源

[English](./README.en.md) | 中文

界面里所有图标都以独立的 SVG 文件放在这里，React 里不再有内联的 `<path>`。`index.ts` 把每个文件读成字符串（Vite 的 `?raw`）注册成一张表，`../../components/Icons.tsx` 只负责尺寸与无障碍属性。

```
line/    16px 网格，单色描边，跟随主题色
solid/   24px 网格，描边更粗、细节更多的字形
brand/   全彩品牌块（PowerShell、CMD、Docker，以及 Ubuntu、Debian、Kali、Kylin、Alpine、Arch、Fedora、openSUSE、Rocky、Alma、CentOS 与通用 Tux），自带配色，不跟随主题
```

产品 logo 是位图，和品牌块放在一起：`assets/brand/logo.png`（由 `scripts/brand-assets.cjs` 从根目录 `logo.png` 派生）。

## 约定

- **线框图标一律画在 16×16 网格上**，`solid/` 例外（24×24，笔画 2）。四周留 1.5 单位左右的视觉安全区，避免不同图标大小忽大忽小。
- **品牌块守同一条安全区**：色块固定占 `0.5–15.5`，白色字形按墨迹包围盒等比缩放，`scale = 12 / max(墨迹宽, 墨迹高)` 并回到色块中心，所以四周至少留 1.5 单位——鲸鱼、龙、变色龙都不会顶到色块边缘。
- **颜色交给 `currentColor`**：文件根节点写 `stroke="currentColor"`、`fill="none"`，不要在文件里写死颜色，否则换主题时会失配。`brand/` 以外不允许出现十六进制色值。
- **文件自带呈现属性**：`viewBox`、`fill`、`stroke`、`stroke-width`、`stroke-linecap`、`stroke-linejoin` 都写在根节点上，组件原样读取——所以这些文件单独用浏览器打开就是最终效果，可以直接给设计师看。
- **文件顶部写一行 `<!-- 用途 -->` 注释**：说明这个图标表达什么，比描述路径更有价值。
- **文件名用 kebab-case**，和注册表里的键一致（`chevron-down.svg` → `IconChevronDown`）。

## 新增一个图标

1. 把 SVG 放到合适的目录，按上面的约定写好根节点属性和注释。
2. 在 `index.ts` 里加一行 `import`，并在 `iconSources` 中登记（键为文件名）。
3. 在 `../../components/Icons.tsx` 对应分组里导出：`export const IconFoo = icon('foo');`
4. `npm run typecheck` 会校验键名，写错会直接报类型错误。

## 为什么是 `?raw` 内联而不是 `<img>` / `<use>` / CSS mask

渲染进程在打包后由 `file://` 加载，外部 `<use href="...">` 会被拦下；`<img>` 和 CSS `mask` 又拿不到 `currentColor`，一套图标得为每套主题各出一份。`?raw` 让构建期就把标记打进 bundle：零请求、随主题变色、`fill-opacity` 这类细节也不丢，重复图标由 gzip 去重。
