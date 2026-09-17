import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// Lê o minAppVersion atual do manifest.json e usa ele no versions.json,
// para deixar registrado qual versão mínima do Obsidian essa versão do
// plugin exige. Isso é o que evita instalar uma versão nova do plugin
// num Obsidian velho demais para suportá-la.
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
