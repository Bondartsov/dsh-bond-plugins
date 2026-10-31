/**
 * Prints the stylesheet this bundle injects, one rule per line, and checks that
 * the braces balance. Handy when reviewing a colour change.
 * Run: node test/dump-css.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDom, createMiniReact, loadClient } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dom = createDom();
const miniReact = createMiniReact();
const { module } = loadClient({ file: path.resolve(here, "..", "client.js"), dom, miniReact });
const css = module.__test.CSS;
const open = (css.match(/{/g) || []).length;
const close = (css.match(/}/g) || []).length;
console.log("braces " + open + "/" + close + " -> " + (open === close ? "balanced" : "UNBALANCED"));
console.log(css.replace(/}\s*/g, "}\n"));
