/**
 * Design-review helper: loads the built app in headless Chromium and captures
 * a screenshot per system colour scheme (the scene and HUD follow
 * prefers-color-scheme). Run with:
 *
 *   npm run build && node e2e/screenshot.mjs [outPrefix]
 *
 * Writes e2e/<outPrefix>-dark.png and e2e/<outPrefix>-light.png.
 */
import { chromium } from "playwright";
import { preview } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outPrefix = process.argv[2] ?? "shot";

const server = await preview({ root, preview: { port: 5199, strictPort: true } });
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});

for (const scheme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  await page.goto("http://localhost:5199/");
  await page.click("#closeHelp");
  await page.waitForFunction(() => window.__debug !== undefined);
  await page.waitForTimeout(400);
  // hover the bow over the string so the implement is visible
  const pt = await page.evaluate(() => window.__debug.view.stringToScreen(0.8, 0.3));
  await page.mouse.move(pt.clientX, pt.clientY);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(root, "e2e", `${outPrefix}-${scheme}.png`) });
  await page.close();
}

await browser.close();
await server.close();
process.exit(0);
