import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagePath = path.resolve(__dirname, "..", "package.json");
const pkg = createRequire(import.meta.url)(packagePath) as { version: string };

/** Application release version (from @hive/shared package.json). */
export const APP_VERSION = pkg.version;
