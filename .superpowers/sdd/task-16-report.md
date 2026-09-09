# Task 16: Select — Report

## What was implemented

Added the `Select` atom (Task 16 of the v2.1 P0 UI design-system plan), the 12th UI primitive in `renderer/src/components/ui/`.

- `renderer/src/components/ui/Select.tsx` — native `<select>` styled with `appearance-none` plus a self-drawn `ChevronDown` overlay (lucide-react). Optional `label` is associated via `<label htmlFor>` + `useId()` SSR-safe id pairing. Options flow through `{children}` for full composition flexibility.
- `renderer/src/components/ui/Select.test.tsx` — 2 unit tests: label association + `onChange` callback with value, and styling-token assertion (`bg-surface-2` + `appearance-none`).

## TDD Evidence

### RED

```
RUN v1.6.1 /workspace/renderer

 ❯ src/components/ui/Select.test.tsx  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/components/ui/Select.test.tsx
Error: Failed to resolve import "./Select" from "src/components/ui/Select.test.tsx". Does the file exist?

 Test Files  1 failed (1)
      Tests  no tests
```

Test file failed at transform time because `Select.tsx` did not yet exist (import resolution error, zero tests collected). Confirms the brief's expected FAIL.

### GREEN

```
RUN v1.6.1 /workspace/renderer

 ✓ src/components/ui/Select.test.tsx  (2 tests) 46ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

Both assertions pass after implementation: `onChange` is called once via `fireEvent.change` after label association; the bare-`aria-label` select carries `bg-surface-2` + `appearance-none` in its class string.

### Full renderer suite

```
 Test Files  88 passed (88)
      Tests  766 passed (766)
   Duration  19.61s
```

Zero regressions across all renderer tests. Up from 87 files / 764 tests (Checkbox baseline) to 88 files / 766 tests (+1 file +2 tests from Select).

### Typecheck

```
$ cd renderer && npx pnpm@9.0.0 exec tsc --noEmit
exit=0
```

Strict TypeScript check exits clean — `forwardRef<HTMLSelectElement, Props>` typing is sound, `useId` + `?? autoId` id pairing is well-formed, no `any` or `@ts-ignore`.

### LSP diagnostics

| File | Errors |
|---|---|
| `renderer/src/components/ui/Select.tsx` | 0 |
| `renderer/src/components/ui/Select.test.tsx` | 0 |

## Files changed

| Path | Change |
|---|---|
| `renderer/src/components/ui/Select.tsx` | created (+47 lines) |
| `renderer/src/components/ui/Select.test.tsx` | created (+29 lines) |

Commit: `5e89794 feat(renderer): Select 原子件——原生下拉美化 + 自绘箭头`

## Self-review

| Concern | Resolution |
|---|---|
| **ChevronDown `pointer-events-none` overlay** | Confirmed in line 21 of `Select.tsx`: `className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tertiary"`. The icon cannot intercept clicks meant for the underlying `<select>`, so users can still click the right edge to open the dropdown. |
| **`pr-8` clearance for the arrow** | Confirmed in line 16: `pl-3 pr-8` — 32px right padding reserves space for the 14px chevron at `right-2.5` (10px) plus a comfortable tap target margin. Text never collides with the icon. |
| **Label association** | `useId()` generates SSR-safe fallback; `id ?? autoId` consolidates explicit and generated ids; `<label htmlFor={inputId}>` (line 8) is the standard one-way association — clicking the label focuses/opens the select. `<select id={inputId}>` (line 14) wires the other end. |
| **`aria-label` path** | When `label` is omitted (test 2), `getByLabelText('模型')` works because `{...rest}` spreads `aria-label` onto the `<select>`. Testing-library's accessible-name derivation reads `aria-label` directly. |
| **Dark-mode native dropdown colors** | Handled by globals.css `color-scheme` declaration (per brief); not configured inside this component — separation of concerns preserved. |
| **Chinese comments** | File header line 1-2 carries `// 下拉选择原子件：原生 select 美化（appearance-none + 自绘 ChevronDown）。// 暗黑模式原生弹层颜色由 globals.css 的 color-scheme 声明接管。` per AGENTS.md language policy. |
| **`forwardRef` + `displayName`** | `forwardRef<HTMLSelectElement, Props>` exposes the DOM node to parent components (key for tooltip/focus management). `Select.displayName = 'Select'` (line 30) keeps React DevTools readable through the forwardRef boundary. |
| **`{...rest}` spread order** | `rest` is spread after `id` and `className` so consumer-supplied `id` / `className` wins on conflict (consistent with Checkbox / Input patterns). `useId` only fires when `id` is absent — explicit ids win. |
| **`type="text"` leakage** | `interface Props extends SelectHTMLAttributes<HTMLSelectElement>` — no `Omit<...>` needed because `type` doesn't exist on `<select>` (unlike Checkbox where `Omit<'type'>` was required). |
| **`className` forwarding** | `className` is destructured separately and merged via `cn()` into the inner `<select>` class string (line 16-20) — properly forwarded, unlike Checkbox where the brief had it destructured but dropped. Consumers can extend atom styles today. |

## Concerns

- The 2-test surface is intentionally tight per brief. Edge cases not covered:
  - `forwardRef` ref attachment (brief uses default React semantics; not test-asserted).
  - `disabled` styling pass-through (the `<select>` will receive it via `{...rest}` plus the test isn't gating it; minor — covered by Input's tests on similar `SelectHTMLAttributes` extensions in the wider suite).
  - `value` controlled-mode wiring — consumer concern, not implementation concern (no `defaultValue` / `value` guard needed at the atom layer; the underlying `<select>` handles it natively).

  These are out of scope for an atom primitive; the brief's two tests exactly mirror the contract surface (label + onChange + token classes).
- Native dropdown arrow overlay cannot be 100% pixel-aligned across browsers — `appearance-none` deliberately strips the OS arrow; we paint our own. In browsers where `<select>` is not fully styleable (Safari < 15.4), minor cosmetic drift is possible. Acceptable for desktop Electron (Chromium-based) target.
- `bg-surface-2` and `border-subtle` rely on Tailwind theme tokens being configured in `renderer/tailwind.config.*`. Validated by class assertions in test 2 (string contains works regardless of theme compile); a token-removal sweep later would surface as a visual-only change, not a test failure.

## Commit Hash

**`5e89794`** — `feat(renderer): Select 原子件——原生下拉美化 + 自绘箭头`

Full SHA: `5e89794` (short). Changes: `renderer/src/components/ui/Select.tsx` +47, `renderer/src/components/ui/Select.test.tsx` +29.
