/**
 * Generates favicon assets from control-plane/ui/public/Hive.png and writes
 * them to public/. Run from control-plane/ui: node scripts/generate-favicon.cjs
 */
const path = require("path");
const fs = require("fs");

const {
  initFaviconIconSettings,
  generateFaviconFiles,
  generateFaviconHtml,
} = require("@realfavicongenerator/generate-favicon");
const {
  getNodeImageAdapter,
  loadAndConvertToSvg,
} = require("@realfavicongenerator/image-adapter-node");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MASTER_ICON_PATH = path.join(PUBLIC_DIR, "Hive.png");

async function main() {
  if (!fs.existsSync(MASTER_ICON_PATH)) {
    console.error("Master icon not found:", MASTER_ICON_PATH);
    process.exit(1);
  }

  const imageAdapter = await getNodeImageAdapter();
  const iconSvg = await loadAndConvertToSvg(MASTER_ICON_PATH);
  const masterIcon = { icon: iconSvg };

  const iconSettings = initFaviconIconSettings();
  iconSettings.desktop.regularIconTransformation.type = "none";
  iconSettings.desktop.darkIconType = "none";
  iconSettings.touch.transformation.type = "none";
  iconSettings.touch.appTitle = "Hive";
  iconSettings.webAppManifest.transformation.type = "none";
  iconSettings.webAppManifest.name = "Hive";
  iconSettings.webAppManifest.shortName = "Hive";
  iconSettings.webAppManifest.backgroundColor = "#18181b";
  iconSettings.webAppManifest.themeColor = "#18181b";

  const faviconSettings = {
    icon: iconSettings,
    path: "/",
  };

  const files = await generateFaviconFiles(masterIcon, faviconSettings, imageAdapter);

  for (const [name, content] of Object.entries(files)) {
    const outPath = path.join(PUBLIC_DIR, name);
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(outPath, content);
    } else {
      fs.writeFileSync(outPath, content, "utf8");
    }
    console.log("Wrote", name);
  }

  const { markups } = await generateFaviconHtml(faviconSettings);
  console.log("\nFavicon HTML (for reference):");
  markups.forEach((m) => console.log(m));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
