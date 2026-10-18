---
title: Theme email components
description: Choose light or dark defaults and override explicit color, typography and radius values.
---

`reactEmailTheme(preset?, overrides?)` returns a frozen `ReactEmailTheme`. Presets are `"light"` and `"dark"`; omitted values use the light preset. Pass the result to `themedReactEmailComponents`.

The [rendering example](/integrations/react) customizes the accent and font family. Overrides are partial: omitted fields retain the preset value.

| Fields                         | Use                                |
| ------------------------------ | ---------------------------------- |
| `background`, `foreground`     | Document background and foreground |
| `surface`, `surfaceForeground` | Card and content colors            |
| `accent`, `accentForeground`   | Solid action background and text   |
| `mutedForeground`, `border`    | Secondary text and separators      |
| `fontFamily`                   | Host-chosen CSS font stack         |
| `radius`                       | Numeric corner radius              |

## Choose values deliberately

The theme API is typed configuration, not a CSS sanitizer, contrast checker or email-client compatibility layer. Keep values host-owned, check contrast for the colors you choose and use available fallback fonts. Custom fonts are not automatically loaded or attached.

A dark preset is a fixed rendered choice; it does not establish that every recipient client will respect the same colors or dark-mode behavior. Inspect the HTML and text outputs in the clients you support.

For per-element adjustments, use the component's native `style` or document `bodyStyle` props. Keep layout and content decisions in application templates rather than modifying the shared SDK components.
