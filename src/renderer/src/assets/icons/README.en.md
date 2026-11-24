# Icon assets

English | [中文](./README.md)

Every icon in the UI lives here as its own SVG file — there is no inline `<path>` left in React. `index.ts` reads each file as a string (Vite's `?raw`) and registers it in one table; `../../components/Icons.tsx` only adds sizing and the accessibility attributes.

```
line/    16px grid, single-stroke, monochrome, follows the theme colour
solid/   24px grid, heavier stroke, the more detailed glyphs
brand/   full-colour brand tiles (PowerShell, CMD, Docker, plus Ubuntu, Debian, Kali, Kylin, Alpine, Arch, Fedora, openSUSE, Rocky, Alma, CentOS and the generic Tux) with their own palette
```

The product logo is a bitmap and sits with the brand tiles: `assets/brand/logo.png`, derived from the repo-root `logo.png` by `scripts/brand-assets.cjs`.

## Rules

- **Line icons are drawn on a 16×16 grid**; `solid/` is the exception (24×24, stroke 2). Keep roughly 1.5 units of optical padding so icons do not read at different weights.
- **Brand tiles keep the same safe area**: the tile is fixed at `0.5–15.5`, and the white glyph is scaled by its ink box — `scale = 12 / max(ink width, ink height)` — then recentred, which leaves at least 1.5 units on every side. That is why the whale, the dragon and the chameleon never touch the tile edge.
- **Colour comes from `currentColor`**: the root element sets `stroke="currentColor"` and `fill="none"`. Never hardcode a colour in these files, or the icon breaks on the next theme. Hex values are allowed only in `brand/`.
- **The file owns its presentation**: `viewBox`, `fill`, `stroke`, `stroke-width`, `stroke-linecap` and `stroke-linejoin` all sit on the root element and the component reads them verbatim — so opening a file in a browser shows exactly what ships, which makes these files reviewable on their own.
- **Start each file with a one-line `<!-- purpose -->` comment**: what the icon means is more useful than what its path does.
- **File names are kebab-case** and match the registry key (`chevron-down.svg` → `IconChevronDown`).

## Adding an icon

1. Drop the SVG into the right folder, with the root attributes and the comment above.
2. Add one `import` to `index.ts` and one entry to `iconSources` (keyed by file name).
3. Export it from the matching group in `../../components/Icons.tsx`: `export const IconFoo = icon('foo');`
4. `npm run typecheck` validates the key — a typo is a type error.

## Why `?raw` inlining instead of `<img>` / `<use>` / CSS mask

The packaged renderer loads from `file://`, where an external `<use href="...">` is blocked; `<img>` and CSS `mask` cannot pick up `currentColor`, so a single set would need one copy per theme. `?raw` bakes the markup into the bundle at build time: no requests, colours follow the theme, details like `fill-opacity` survive, and repeated markup is deduplicated by gzip.
