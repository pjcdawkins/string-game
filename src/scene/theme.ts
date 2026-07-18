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
  /** Opacity of the three idle (unselected) strings — the selected string
   * draws at full contrast over them. */
  idleStringOpacity: number;
  /** Colour an idle string shifts toward while it rings (sympathetic
   * resonance / ring-on): whiter than the idle gray on dark, but on the light
   * background whiter would *lose* contrast, so there it deepens instead —
   * the same reversal the glow treatment makes. */
  resonantString: number;
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
  idleStringOpacity: 0.3,
  resonantString: 0xffffff,
  glowLightness: 0.62,
  glowOpacity: 1,
  additiveGlow: true,
};

export const LIGHT: SceneTheme = {
  light: true,
  // strings are metal: a mid silver reads against the ebony board, the
  // maple body AND the light background (the old near-black string
  // disappeared against the fingerboard it actually lies over)
  string: 0xaab4c4,
  idleStringOpacity: 0.45,
  resonantString: 0x76839a,
  bg: 0xece8df,
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
