---
name: ax-admin-dashboard-ui
description: Use when creating, editing, or reviewing any admin dashboard UI component. Covers the complete design system — colors, typography, components, layout, animations, and patterns.
---

# AX Admin Dashboard — Design System & Style Guide

## When to Use This Skill

Invoke this skill BEFORE:
- Adding or editing any dashboard page, component, or view
- Creating new UI elements (cards, buttons, badges, tables, forms)
- Modifying layout, colors, spacing, or typography in the dashboard
- Reviewing dashboard PRs for visual consistency

## Key Files

| File | Purpose |
|------|---------|
| `ui/admin/src/index.css` | All CSS custom properties, component classes, animations |
| `ui/admin/src/main.tsx` | App entry point, router, layout shell |
| `ui/admin/src/components/` | Reusable React components |
| `ui/admin/src/pages/` | Page-level components (Overview, Agents, Security, Logs, Settings) |
| `dashboard/` | Legacy location — admin dashboard source is now at `ui/admin/` |

## Reference Screenshot

See `reference.png` for the canonical visual reference.

---

## Design Principles

1. **Dark-only theme** — No light mode. `<html class="dark">` is hardcoded.
2. **Glassmorphism** — Cards use `backdrop-filter: blur(8px)` with transparent borders.
3. **Status-driven color** — Amber = primary, Emerald = success, Rose = error, Sky = info, Violet = tertiary.
4. **Subtle noise texture** — SVG fractal noise overlay at 1.5% opacity on main content area.
5. **Micro-interactions** — Pulse for live indicators, fade-in-up for page entry, smooth hover transitions.
6. **High contrast text** — Off-white `#fafaf9` on near-black `#09090b`.
7. **Minimal borders** — Use `rgba(255,255,255,0.06)` at varying opacities, never solid white/gray lines.

---

## Color Palette

### Backgrounds
```
Page background:     #09090b   (var(--background))
Card background:     #111113   (var(--card))
Secondary/hover:     #1c1c1f   (var(--secondary))
```

### Text
```
Primary text:        #fafaf9   (var(--foreground))
Muted text:          #71717a   (var(--muted-foreground))
```

### Semantic Accent Colors
```
Amber (primary):     #f59e0b   (var(--color-amber))     — buttons, active nav, accents
Emerald (success):   #34d399   (var(--color-emerald))    — status badges, running state
Rose (error):        #fb7185   (var(--color-rose))       — error badges, blocked state
Sky (info):          #38bdf8   (var(--color-sky))        — info badges, idle state
Violet (tertiary):   #a78bfa   (var(--color-violet))     — additional accents
Destructive:         #ef4444   (var(--destructive))      — kill/delete buttons
```

### Borders
```
Subtle:    rgba(255, 255, 255, 0.06)   (var(--border))
Input:     rgba(255, 255, 255, 0.08)   (var(--input))
Focus:     rgba(255, 255, 255, 0.12)   (var(--ring))
```

Use Tailwind opacity suffixes: `border-border/30`, `border-border/50`, `border-border/80`.

---

## Typography

### Fonts
```
Sans:  "Outfit", system-ui, sans-serif       (var(--font-sans))
Mono:  "IBM Plex Mono", ui-monospace         (var(--font-mono))
```

Font feature settings: `'cv02', 'cv03', 'cv04', 'cv11'` (Outfit stylistic alternates).

### Size Scale (pixel values used via Tailwind)
```
text-[10px]   — Tiny labels, IDs, uppercase tracking-wide headers
text-[11px]   — Small details, profile badges
text-[12px]   — Body text, descriptions, status labels
text-[13px]   — Standard body, labels, button text, nav items
text-[14px]   — Card headers, section titles
text-[15px]   — Logo/branding
text-2xl      — Page headers (h2)
text-[28px]   — Large stat numbers
```

### Weight
```
300 (light)     — Rarely used
400 (regular)   — Body text
500 (medium)    — Labels, buttons, badges, nav items
600 (semibold)  — Page headers, stat numbers, card titles
700 (bold)      — Rarely used
```

### Tracking
```
tracking-tight    (-0.025em)   — Headers, stat numbers
tracking-wide     (0.025em)    — Secondary labels
tracking-widest   (0.1em)      — Table headers, tiny uppercase labels
```

---

## Component Patterns

### Cards
```
Base:     bg-card/80 border border-border/40 rounded-xl backdrop-blur-sm shadow-sm
Hover:    hover:border-border/60
Header:   px-6 py-4 border-b border-border/30
Body:     px-6 py-4
```

Use the `.card`, `.card-header`, `.card-body` CSS classes defined in `index.css`. Cards transition `border-color` over `200ms`.

### Buttons

**Primary** (`.btn-primary`):
```
bg-amber text-primary-foreground px-4 py-2 rounded-lg text-[13px] font-medium
hover: lighter amber (90% mix with white)
disabled: opacity-50 cursor-not-allowed
```

**Secondary** (`.btn-secondary`):
```
bg-card text-muted-foreground border border-border/50 px-4 py-2 rounded-lg text-[13px] font-medium
hover: bg-accent border-border text-foreground
```

**Danger** (`.btn-danger`):
```
bg-destructive text-white px-4 py-2 rounded-lg text-[13px] font-medium
hover: lighter red (85% mix with white)
```

All buttons use `inline-flex items-center justify-center gap-2` and transition `150ms`.

### Status Badges

Pattern: `bg-[color]/5 text-[color] border border-[color]/20 rounded-full px-2 py-0.5 text-[10px] font-medium`

| Badge | BG | Text | Border |
|-------|----|------|--------|
| `.badge-green` | emerald/5 | #34d399 | emerald/20 |
| `.badge-red` | rose/5 | #fb7185 | rose/20 |
| `.badge-yellow` | amber/5 | #f59e0b | amber/20 |
| `.badge-blue` | sky/5 | #38bdf8 | sky/20 |
| `.badge-zinc` | muted/8 | #71717a | border/50 |

### Status Dots (inline indicators)
```
Running:   w-1.5 h-1.5 rounded-full bg-emerald animate-pulse-live
Idle:      w-1.5 h-1.5 rounded-full bg-sky
Stopped:   w-1.5 h-1.5 rounded-full bg-muted-foreground/50
Error:     w-1.5 h-1.5 rounded-full bg-rose
```

### Form Inputs

**Text input** (`.input`):
```
bg-input border border-border/50 rounded-lg px-3 py-2 text-[13px] text-foreground
placeholder: text-muted-foreground
focus: border-amber/50 ring ring-amber/10
disabled: opacity-50 cursor-not-allowed
```

**Select** (`.select`): Same as input, with `appearance-none` and SVG chevron at right.

### Tables
```
Header:    text-[10px] uppercase tracking-wide font-medium px-6 py-3 border-b border-border/50
Row:       text-[13px] px-6 py-3 divide-y divide-border/30
Row hover: hover:bg-foreground/[0.02]
Active:    bg-foreground/[0.04]
```

### Skeleton Loader (`.skeleton`)
```
Shimmer gradient from secondary through secondary/foreground mix
1.5s ease-in-out infinite animation
rounded-lg
```

---

## Layout

### Sidebar
```
Width:     w-[220px] fixed
Height:    h-screen
BG:        bg-sidebar (#09090b)
Border:    border-r border-border/50
Nav items: text-[13px] font-medium px-3 py-2 rounded-lg
Active:    text-amber bg-amber/5
Inactive:  text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]
Dividers:  h-px bg-border/30
```

### Main Content
```
Container: flex-1 overflow-auto
Wrapper:   mx-auto max-w-[1400px] px-8 py-6
Texture:   .noise-bg class on main content area
```

### Page Header
```
h2:   text-2xl font-semibold tracking-tight text-foreground
Desc: mt-1 text-[13px] text-muted-foreground
Class: animate-fade-in-up
Actions flush right via flex justify-between
```

### Grid System
```
Mobile:    grid-cols-1
Small:     sm:grid-cols-2 or sm:grid-cols-3
Large:     lg:grid-cols-3 or lg:grid-cols-4
Gap:       gap-4 (1rem)
```

---

## Animations

### Entry Animation
```css
.animate-fade-in-up {
  animation: fade-in-up 0.5s ease-out both;
}
/* translateY(8px) → translateY(0), opacity 0 → 1 */
```
Use `style="animation-delay: 50ms"` for staggered children (increment by 50ms).

### Live Pulse
```css
.animate-pulse-live {
  animation: pulse-live 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
/* opacity: 1 → 0.4 → 1 */
```

### Glow Effects
```
.glow-amber     box-shadow: 0 0 20px rgba(245, 158, 11, 0.08)
.glow-emerald   box-shadow: 0 0 20px rgba(52, 211, 153, 0.08)
.glow-rose      box-shadow: 0 0 20px rgba(251, 113, 133, 0.08)
```

### Transitions
```
Default:   transition-all duration-200
Colors:    transition-colors duration-150
Fast:      duration-150
```

---

## Icons

Uses **Lucide React** (`lucide-react` package). Standard usage:

```tsx
import { Shield, Activity, Users } from 'lucide-react';

<Shield size={14} strokeWidth={1.8} className="text-amber" />
```

### Size Convention
```
12px — Inline with small text, badge icons
14px — Standard inline, nav icons, card header icons
16px — Section headers, status icons
20px — Stat card icons, page-level icons
32px — Hero/empty state icons
```

### Stroke Width
```
1.8 — Default for most icons
2.0 — Emphasis / larger icons
```

---

## Scrollbar Styling

Custom thin scrollbars (already in `index.css`):
```
Width: 6px
Track: transparent
Thumb: rgba(255, 255, 255, 0.08), hover rgba(255, 255, 255, 0.15)
Border-radius: 3px
```

---

## Checklist for New Components

When adding a new UI element to the dashboard:

- [ ] Use existing CSS custom properties — never hardcode colors
- [ ] Use existing component classes (`.card`, `.btn-primary`, `.badge-green`, `.input`, `.skeleton`) before writing new CSS
- [ ] Match font sizes to the scale: `text-[10px]` through `text-[28px]`
- [ ] Use `font-medium` (500) for labels/buttons, `font-semibold` (600) for headers
- [ ] Use semantic accent colors: amber=primary, emerald=success, rose=error, sky=info
- [ ] Apply `animate-fade-in-up` to new page sections with staggered delays
- [ ] Use Lucide React icons at `size={14}` with `strokeWidth={1.8}` by default
- [ ] Borders should use `border-border/30` (subtle) or `border-border/50` (normal)
- [ ] Cards must use `backdrop-blur-sm` and transparent backgrounds (`bg-card/80`)
- [ ] Use `color-mix(in srgb, color %, transparent)` for opacity blending — not hex alpha
- [ ] Test at mobile, sm, and lg breakpoints
- [ ] Place component in `ui/admin/src/components/` or `ui/admin/src/pages/`
- [ ] Run `npm run build` and verify the current admin dashboard build output path

## Common Mistakes to Avoid

- **Don't use solid borders** — always use opacity variants (`border-border/50`, not `border-white`)
- **Don't use `bg-gray-*` Tailwind defaults** — use `var(--secondary)`, `var(--card)`, `var(--muted)`
- **Don't hardcode colors** — use CSS custom properties or Tailwind theme classes
- **Don't use `font-bold`** — the heaviest weight in regular use is `font-semibold` (600)
- **Don't skip the noise texture** — main content areas need the `.noise-bg` class
- **Don't use light mode colors** — this is a dark-only theme
- **Don't add new fonts** — stick to Outfit (sans) and IBM Plex Mono (mono)
- **Don't use opacity utilities for backgrounds** — use `color-mix` for consistent blending
