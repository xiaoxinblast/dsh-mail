import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const output = await build({ entryPoints: ["ui/plugin.jsx"], bundle: true, format: "cjs", platform: "browser", target: "chrome130", external: ["react", "react-dom", "react-dom/client"], write: false, minify: false, legalComments: "inline", loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
await writeFile("dist/client.js", `window.__ModuleLoader__.load({id:"dsh-mail",factory(require){\nconst module={exports:{}};const exports=module.exports;\n${output.outputFiles[0].text}\nreturn module.exports.default;\n}});\n`);
console.log("Built DSH native client");
