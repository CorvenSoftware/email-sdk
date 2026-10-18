export interface ReactEmailTheme {
  readonly background: string;
  readonly foreground: string;
  readonly surface: string;
  readonly surfaceForeground: string;
  readonly accent: string;
  readonly accentForeground: string;
  readonly mutedForeground: string;
  readonly border: string;
  readonly fontFamily: string;
  readonly radius: number;
}

export type ReactEmailThemePreset = "light" | "dark";

const reactEmailThemes = Object.freeze({
  dark: Object.freeze({
    accent: "#a7c7ff",
    accentForeground: "#102039",
    background: "#131a26",
    border: "#43526a",
    fontFamily: "Arial, Helvetica, sans-serif",
    foreground: "#f1f5f9",
    mutedForeground: "#c3cddd",
    radius: 12,
    surface: "#1e293b",
    surfaceForeground: "#f1f5f9",
  }),
  light: Object.freeze({
    accent: "#1746a2",
    accentForeground: "#ffffff",
    background: "#f4f5f7",
    border: "#d5dbe4",
    fontFamily: "Arial, Helvetica, sans-serif",
    foreground: "#1c2434",
    mutedForeground: "#526074",
    radius: 12,
    surface: "#ffffff",
    surfaceForeground: "#1c2434",
  }),
});

export const reactEmailTheme = (
  preset: ReactEmailThemePreset = "light",
  overrides: Partial<ReactEmailTheme> = {},
): ReactEmailTheme => {
  const base = reactEmailThemes[preset];

  return Object.freeze({
    accent: overrides.accent ?? base.accent,
    accentForeground: overrides.accentForeground ?? base.accentForeground,
    background: overrides.background ?? base.background,
    border: overrides.border ?? base.border,
    fontFamily: overrides.fontFamily ?? base.fontFamily,
    foreground: overrides.foreground ?? base.foreground,
    mutedForeground: overrides.mutedForeground ?? base.mutedForeground,
    radius: overrides.radius ?? base.radius,
    surface: overrides.surface ?? base.surface,
    surfaceForeground: overrides.surfaceForeground ?? base.surfaceForeground,
  });
};
