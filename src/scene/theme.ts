/**
 * Light/dark scene palettes following the system colour scheme
 * (`prefers-color-scheme`). The instrument's wood tones are shared between
 * themes — they read well on both backgrounds — so a theme only carries the
 * background, the string colour and the glow treatment. The glow is additive
 * in the dark theme (a halo of light) but additive blending is invisible on
 * a light background, so the light theme switches to normal blending with a
 * deeper colour.
 *
 * The CSS side of the same switch lives in `src/style.css` (`--bg` must match
 * `bg` here so the HUD and the WebGL clear colour agree).
 */

export interface SceneTheme {
  light: boolean;
  bg: number;
  string: number;
  /** HSL lightness of the vibration glow (hue is set live by the string). */
  glowLightness: number;
  /** Scale on the glow opacity envelope. */
  glowOpacity: number;
  additiveGlow: boolean;
}

export const DARK: SceneTheme = {
  light: false,
  bg: 0x0b0e14,
  string: 0xdde3ee,
  glowLightness: 0.62,
  glowOpacity: 1,
  additiveGlow: true,
};

export const LIGHT: SceneTheme = {
  light: true,
  bg: 0xece8df,
  string: 0x2b303b,
  glowLightness: 0.5,
  glowOpacity: 0.85,
  additiveGlow: false,
};

const query = window.matchMedia?.("(prefers-color-scheme: light)");

export function currentTheme(): SceneTheme {
  return query?.matches ? LIGHT : DARK;
}

export function onThemeChange(cb: (t: SceneTheme) => void): void {
  query?.addEventListener("change", () => cb(currentTheme()));
}
