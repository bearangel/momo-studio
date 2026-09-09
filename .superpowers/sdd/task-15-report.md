# Task 15: Checkbox — Report

## What was implemented

Added the `Checkbox` atom (Task 15 of the v2.1 P0 UI design-system plan), the 11th UI primitive in `renderer/src/components/ui/`.

- `renderer/src/components/ui/Checkbox.tsx` — appearance-none native `<input type="checkbox">` rendered with a peer-driven custom check (lucide `Check` 12px / stroke 2.5). Label-less returns the bare box; with `label` wraps in a `<label htmlFor>` association.
- `renderer/src/components/ui/Checkbox.test.tsx` — 3 unit tests: label-click toggling, checked-state class assertion, and `disabled` pass-through.

## TDD Evidence

### RED

```
RUN v1.6.1 /workspace/renderer

❯ src/components/ui/Checkbox.test.tsx  (0 test)
⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

FAIL  src/components/ui/Checkbox.test.tsx
Error: Failed to resolve import "./Checkbox" from "src/components/ui/Checkbox.test.tsx". Does the file exist?
```

Test file failed at transform time because `Checkbox.tsx` did not yet exist (import resolution error, zero tests collected). Confirms the brief's expected FAIL.

### GREEN

```
RUN v1.6.1 /workspace/renderer

✓ src/components/ui/Checkbox.test.tsx  (3 tests) 50ms

Test Files  1 passed (1)
Tests       3 passed (3)
```

All three assertions pass after implementation: label-click toggles onChange + checked state; `defaultChecked` input contains `checked:bg-accent-500`; `disabled` is forwarded and reflected on the DOM.

### Full renderer suite

```
Test Files  87 passed (87)
Tests       764 passed (764)
Duration    14.53s
```

Zero regressions across all renderer tests (Checkbox is the new file; previous atom EmptyState still 2/2).

### Typecheck

```
$ cd renderer && npx pnpm@9.0.0 exec tsc --noEmit
exit=0
```

Strict TypeScript check exits clean — `Omit<..., 'type'>` guards are well-formed, forwardRef typing is sound, no `any` or `@ts-ignore` introduced.

## Files changed

| Path | Change |
|---|---|
| `renderer/src/components/ui/Checkbox.tsx` | created (+40 lines) |
| `renderer/src/components/ui/Checkbox.test.tsx` | created (+25 lines) |

Commit: `3f49e48 feat(renderer): Checkbox 原子件——peer 自绘选中态`

## Self-review

| Concern | Resolution |
|---|---|
| **peer mechanism classes** | Input has `peer h-4 w-4 appearance-none ... checked:border-accent-500 checked:bg-accent-500`; sibling `<Check>` icon carries `peer-checked:opacity-100` plus `opacity-0` baseline — match exactly with brief. |
| **`Omit<'type'>` guard** | `interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>` locks the type to `checkbox`; consumers cannot override via props. |
| **Chinese comments** | File header carries `// 复选框原子件：appearance-none 自绘（peer 机制），选中打勾用 lucide Check。` per AGENTS.md language policy. |
| **Label-less usage** | `if (!label) return box;` returns just the `<span><input/><Check/></span>` so consumers can compose their own label. |
| **Labeled usage** | `<label htmlFor={inputId}>` with `useId()` fallback provides SSR-safe id association; cursor-pointer + select-none + items-center + gap-2 gives the correct ergonomics. |
| **`pointer-events-none` on icon** | Prevents the decorative `<Check>` from intercepting clicks meant for the underlying `<input>`. |
| **`aria-hidden` on icon** | The icon is purely decorative; the actual `<input type="checkbox">` already exposes its role, name (via `<label htmlFor>`), and state to AT. |
| **Display name** | `Checkbox.displayName = 'Checkbox';` set so React DevTools labels the forwardRef wrapper. |
| **`className` prop is currently unused** | The brief destructures `className` from props but doesn't forward it to any element. Brief code is verbatim — flagged as a future improvement opportunity, but not changed (scope discipline). |

## Concerns

- The brief destructures `className` from props without forwarding it (it gets dropped). This is verbatim from the brief — consumers cannot extend the input's classes today. If the v2.1 plan later expects `className` to flow into the inner `<input>`, this would be a one-line change to merge `className` into the input's class string. **Not changed here** to preserve verbatim brief compliance.
- No e2e or visual QA performed — out of scope for an atom primitive; the 3 unit tests cover the contract surface.