# @joshuarli/ui

Compact, editorial design system primitives for Solid.

## Installation

```sh
pnpm add @joshuarli/ui
```

`solid-js` and `@solidjs/web` (`>=2.0.0-rc.18`) are optional peers. Install them only
when you import the JS entry; a CSS-only consumer needs neither.

## Usage

```ts
import "@joshuarli/ui/styles.css";

import {
  Badge,
  Button,
  CollapsiblePanel,
  EmptyState,
  ErrorState,
  Icon,
  Meter,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Segmented,
  Shell,
  Skeleton
} from "@joshuarli/ui";
```

## CSS-only usage

`@joshuarli/ui/tokens.css` and `@joshuarli/ui/styles.css` need no JavaScript. `styles.css`
imports `tokens.css`. Server-rendered HTML can link the built files and emit the same `ui-*`
class names the components render.

```html
<link rel="stylesheet" href="/ui/styles.css">
```

## Tokens

All tokens are `--ui-*` custom properties on `:root`: color (`bg`, `surface`, `text`, `text-2`,
`muted`, `line`, `line-strong`, `hover`, `accent`, `good`/`ok`, `serious`/`warn`,
`critical`/`bad`, tinted backgrounds `accent-soft`, `ok-soft`, `warn-soft` and `bad-soft`,
`viz-*`, `s0` to `s7`), type (`font`, `mono`, `fs-*`), spacing (`space-*`),
sizes (`control*`, `row-height*`, `side-width`, `side-link-height`), radius, shadow and z-index.

`tokens.css` declares `color-scheme: light dark`. The light values are the defaults, and a
`@media (prefers-color-scheme: dark)` block overrides every color token and the shadows.
There is no manual theme switch, so no JavaScript is needed.

## App shell

A sidebar and a main panel. It works without JavaScript: above 720px the sidebar is sticky
and 236px wide (`--ui-side-width`). At 720px and below the sidebar stacks above the content
and its nav links wrap in a row, with no horizontal overflow at 390px.

The Solid `Shell` renders exactly this markup. Server-rendered pages must emit the same
structure:

```html
<div class="ui-shell">
  <aside class="ui-side">
    <div class="ui-side-top">
      <a class="ui-side-brand" href="/">[optional svg mark]niceforge</a>
    </div>
    <div class="ui-side-body">
      <nav class="ui-side-nav" aria-label="Main">
        <a href="/repositories" aria-current="page">Repositories</a>
        <a href="/settings">Settings</a>
      </nav>
      <nav class="ui-side-nav" aria-labelledby="ui-side-group-1">
        <span class="ui-side-group" id="ui-side-group-1">CI</span>
        <a href="/runs">Runs</a>
      </nav>
      <div class="ui-side-foot">
        <form method="post" action="/session/logout"><button type="submit">Sign out</button></form>
      </div>
    </div>
  </aside>
  <main class="ui-main" id="main" tabindex="-1">...</main>
</div>
```

- Mark the current page with `aria-current` (`page`) on its `<a>`; it is the only current styling.
- Each `ui-side-nav` is named either by `aria-label` or, when it shows a heading, by a
  `ui-side-group` span inside it referenced through `aria-labelledby` (unique id).
- `ui-side-foot` is optional. Direct `<a>` and `<button>` descendants (also inside a form) are
  styled as nav links.
- Icons inside nav links and the brand are `<svg>` elements sized to 16px.

```tsx
<Shell
  brand={{ href: "/runs", name: "niceforge", mark: <Icon name="activity" size={16} /> }}
  nav={[
    { label: "Main", items: [{ href: "/runs", label: "Runs", current: true }] },
    { label: "CI", heading: true, items: [{ href: "/runners", label: "Runners" }] }
  ]}
  foot={<button type="button">Sign out</button>}
>
  {page}
</Shell>
```

`heading: true` renders the visible group label; the group's id is `ui-side-group-<index>`
(`groupId(index)`). `SideNav` renders one nav group on its own.
