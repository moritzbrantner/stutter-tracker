import { getDefaultConfig } from "expo/metro-config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);

config.watchFolders = [path.join(root, "packages")];
config.resolver.nodeModulesPaths = [
  path.join(__dirname, "node_modules"),
  path.join(root, "node_modules"),
];

export default config;
