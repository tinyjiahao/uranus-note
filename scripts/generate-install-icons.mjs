import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";

// Render the existing brand vector, not a separately maintained illustration.
const svg = await readFile(new URL("../public/icon.svg", import.meta.url), "utf8");
const destination = new URL("../public/icons/", import.meta.url);
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  for (const [name, size, maskable] of [["icon-192", 192, false], ["icon-512", 512, false], ["maskable-512", 512, true], ["apple-touch-icon", 180, false]]) {
    const data = await page.evaluate(async ({ svg, size, maskable }) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${btoa(svg)}`;
      await image.decode();
      if (maskable) {
        ctx.fillStyle = "#f5c842"; ctx.fillRect(0, 0, size, size);
        // Keep the note/pencil artwork (including strokes) in the central
        // 80%-diameter safe circle; the yellow background may extend beyond it.
        ctx.drawImage(image, size * .11, size * .11, size * .78, size * .78);
      } else ctx.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { svg, size, maskable });
    await writeFile(new URL(`${name}.png`, destination), Buffer.from(data, "base64"));
  }
} finally { await browser.close(); }
