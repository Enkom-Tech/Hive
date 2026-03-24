/**
 * Exports doc/assets/avatars/*.svg to PNG (512x512). Run from control-plane: pnpm run doc:export-avatar-pngs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVATARS_DIR = path.join(__dirname, "..", "doc", "assets", "avatars");
const SIZE = 512;

const svgFiles = fs.readdirSync(AVATARS_DIR).filter((f) => f.endsWith(".svg"));
if (svgFiles.length === 0) {
  console.error("No SVG files in", AVATARS_DIR);
  process.exit(1);
}

for (const name of svgFiles) {
  const base = name.slice(0, -4);
  const svgPath = path.join(AVATARS_DIR, name);
  const pngPath = path.join(AVATARS_DIR, `${base}.png`);
  const svgBuffer = fs.readFileSync(svgPath);
  await sharp(svgBuffer)
    .resize(SIZE, SIZE)
    .png()
    .toFile(pngPath);
  console.log("Exported", pngPath);
}
