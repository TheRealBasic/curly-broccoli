# UI Conventions and Chat Screen QA Checklist

This document captures the in-repo UI conventions used by `apps/web/src/styles.css` and how to apply a consistent QA pass to chat-related screens before merge.

## UI conventions

### Color tokens

Color tokens are defined in `:root` and should be used via semantic utility classes or existing components (instead of introducing ad-hoc colors).

| Token | Value | Primary use |
| --- | --- | --- |
| `--text-primary` | `#0f172a` | Default body/copy text |
| `--text-secondary` | `#334155` | Secondary labels, helper text |
| `--text-muted` | `#64748b` | Meta text, subtle states |
| `--text-inverse` | `#ffffff` | Text on dark/brand fills |
| `--text-danger` | `#b91c1c` | Error/destructive messaging |
| `--text-warning` | `#92400e` | Warning messaging |
| `--text-brand-strong` | `#1e3a8a` | Strong brand-emphasis copy |
| `--text-success-strong` | `#065f46` | Positive/connected status copy |

### Spacing scale

Spacing tokens use a 4px base scale and are the default rhythm units across layout, controls, and panels.

| Token | Value | Typical usage |
| --- | --- | --- |
| `--space-4` | `4px` | Dense gaps, small top/bottom text spacing |
| `--space-8` | `8px` | Control gaps, status chips/notices |
| `--space-12` | `12px` | Input padding, secondary panel spacing |
| `--space-16` | `16px` | Primary panel padding and section rhythm |
| `--space-24` | `24px` | Larger content grouping |
| `--space-32` | `32px` | Major separation |

Related layout tokens:

- `--panel-header-padding`: panel header inset
- `--panel-body-padding`: panel content inset
- `--control-gap`: horizontal control spacing
- `--section-rhythm`: default vertical rhythm between sections

### Typography scale

Typography is controlled by reusable `type-*` classes and root tracking/line-height tokens.

| Class | Size/weight intent | Typical usage |
| --- | --- | --- |
| `.type-page-title` | Largest heading (`clamp(1.8rem, 2.8vw, 2.25rem)`, 700) | App/page titles |
| `.type-section-header` | Section heading (`1.05rem`, 650) | Sidebar and panel section headers |
| `.type-panel-header` | Compact panel heading (`0.95rem`, 600) | Accordion/panel summaries |
| `.type-body` | Body copy (`0.92rem`, 400) | Standard descriptive text |
| `.type-meta` | Metadata (`0.78rem`, 500, wider tracking) | State labels, diagnostics |

### Component variants

#### Buttons

Base class: `.btn`

Variants:

- `.btn-primary`
- `.btn-secondary`
- `.btn-ghost`
- `.btn-danger`
- `.btn-success`
- `.btn-auto` (width behavior helper)

Sizing and state:

- default minimum height: `--control-height` (`36px`)
- disabled state via `.btn:disabled`

#### Inputs

Base class: `.input`

Variants:

- `.input-default` (standard control height)
- `.input-compact` (compact height, smaller type)
- `.input-invalid` (error border/background)
- `.control-full` (100% width utility)

#### Panel and priority variants

Panel shell and priority semantics:

- `.sidebar`, `.chat-panel` (base panel shells)
- `.rail-panel` (shared rail panel wrapper)
- `.always-visible` (blue left border)
- `.collapsible-panel` (teal left border)
- `.advanced-panel` (amber left border)

### Panel layout rules

#### Global chat page frame

- `.chat-layout` uses a fixed viewport-height shell (`min-height/max-height: 100vh`) with `overflow: hidden` to keep scrolling localized to inner panes.
- `.guild-shell` is a three-column rail layout on desktop:
  - left rail: `280px`
  - center rail: fluid (`minmax(0, 1fr)`)
  - right rail: `320px`

#### Responsive behavior

Viewport state in `App.tsx`:

- **Desktop**: `>= 1280px` (default `.guild-shell`)
- **Medium**: `960px–1279px` (`.guild-shell.is-medium`)
- **Mobile**: `< 960px` (`.guild-shell.is-mobile`)

Rules by viewport:

1. **Desktop**: all rails visible in-grid.
2. **Medium**:
   - right/context rails become fixed overlay drawers.
   - `.aux-rail-tabs` toggles which auxiliary drawer is open.
3. **Mobile**:
   - layout stacks into one column (`left -> center -> right -> context`).
   - composer becomes sticky near bottom for quick message entry.

## Chat Screen QA Checklist (for PRs)

Use this checklist when changing chat UI, starting with the main chat screen and then voice/co-watch subviews.

### Checklist template

- [ ] Alignment and spacing checks
- [ ] Responsive behavior validated at **3 widths** (`1440px`, `1100px`, `390px`)
- [ ] Consistent control sizing (button/input heights and row alignment)
- [ ] No overflow clipping (including drawers, sticky composer, media)
- [ ] Contrast and keyboard sanity checks (focusability, tab order, visible labels)

## Checklist application log

### 1) Main chat screen (primary rails + message/composer flow)

- [x] Alignment and spacing checks
  - Confirmed spacing uses the scale tokens and panel padding utilities.
  - Verified section rhythm between status/header, lists, chat box, and composer.
- [x] Responsive behavior at 3 widths
  - `1440px`: three-rail desktop layout.
  - `1100px`: medium drawer behavior with aux-rail tabs.
  - `390px`: stacked rails and sticky composer behavior.
- [x] Consistent control sizing
  - Core buttons/inputs inherit `--control-height` and shared `.btn`/`.input` base styles.
- [x] No overflow clipping
  - `chat-layout`, `chat-panel`, and `chat-box` confine scrolling to intended regions.
- [x] Contrast and keyboard sanity checks
  - Status/error text uses semantic color roles; interactive controls are native `button`, `input`, `select`, and `summary`.

### 2) Voice + co-watch subviews (right rail accordion sections)

- [x] Alignment and spacing checks
  - Voice/co-watch sections use shared rail/panel classes and the same section rhythm.
- [x] Responsive behavior at 3 widths
  - Desktop: right rail in-grid.
  - Medium: right rail opens as drawer via aux-rail tab selection.
  - Mobile: right rail is part of stacked flow.
- [x] Consistent control sizing
  - Voice actions and co-watch transport row use `.btn` and `.input` variants with common height tokens.
- [x] No overflow clipping
  - Media viewport and panel contents remain inside rail containers with explicit overflow controls.
- [x] Contrast and keyboard sanity checks
  - Accordion summaries are keyboard togglable (`<details>/<summary>`); controls remain native form elements.
