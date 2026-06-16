// One-shot sweep: remap legacy slate/blue/brand hexes to Instrument values
// (docs/design/reimagine/DESIGN-SYSTEM.md). Case-insensitive on hex digits.
// Usage: node tools/instrument-hex-sweep.mjs [--dry]
import { readFileSync, writeFileSync } from "node:fs";

const MAP = {
  // dark surfaces (blue-black → warm graphite)
  "0e1116": "0d0f0c", "07080c": "080907", "0a0c12": "0a0c09", "0c1118": "0a0c09",
  "080a0f": "0a0c09", "151a22": "121511", "19202a": "171a15", "171a24": "141712",
  "1c2430": "181b16", "151d2a": "171a15", "1b2534": "1d211b", "0d1624": "141712",
  "101820": "141712", "11141c": "111410", "102018": "15201a", "112118": "122419",
  "10231d": "122419", "0f2d25": "0f2a1d", "1c1f2a": "20241d", "151923": "1a1d17",
  "293140": "2e332a", "2a3f35": "2e3a31",
  // slate text → warm text
  "0f172a": "171a14", "17211b": "171a14", "273340": "171a14", "1f2f3f": "22261d",
  "1e2933": "1e2218", "344251": "3a3f33", "394856": "3a3f33", "334155": "3a3f33",
  "475569": "555b4c", "4b5967": "555b4c", "4d5a68": "555b4c", "596675": "555b4c",
  "54606f": "5d644f", "65756d": "5d644f", "7f8ea3": "8b9280", "7a8794": "8b9280",
  "94a3b8": "8b9280", "8b97a8": "8b9280", "7d8a9c": "79816d", "a2adbd": "aab0a0",
  "94a0b2": "8a9180", "cbd5e1": "c8ccbc",
  // slate light surfaces → warm paper
  "f8fafc": "f4f6f0", "f7f9fb": "f6f7f3", "f1f5f9": "eef0e8", "eef2f7": "eaece2",
  "e8eef5": "e7eadf", "e2e8f0": "e0e3d8", "fbfcfd": "fdfdfb", "dce3ea": "e0e3d8",
  "c3d0dc": "c8ccbc", "e5e7eb": "e7eadf", "ecfdf5": "e6f7ec", "b9c5d0": "c8ccbc",
  // legacy brand greens → signal
  "1fb877": "2be082", "27e896": "54f0a0", "0a4d33": "0e5a36", "08734b": "0e6b43",
  "23d289": "54f0a0", "04130d": "06140c", "15803d": "16915c", "4ade80": "2be082",
  // legacy accents
  "5d89dd": "3b82e0", "7da1e8": "4da3ff", "b7791f": "9c6f10", "e0b07a": "f0b43e",
  "dc5b55": "d9544a", "f87171": "f25555", "dc2626": "d23b3b", "ef4444": "e04848",
};

const RGBA_MAP = [
  [/rgba\(\s*31,\s*184,\s*119/gi, "rgba(43, 224, 130"],
  [/rgba\(\s*39,\s*232,\s*150/gi, "rgba(84, 240, 160"],
  [/rgba\(\s*10,\s*77,\s*51/gi, "rgba(14, 90, 54"],
  [/rgba\(\s*8,\s*115,\s*75/gi, "rgba(14, 107, 67"],
  [/rgba\(\s*14,\s*17,\s*22/gi, "rgba(13, 15, 12"],
  [/rgba\(\s*15,\s*23,\s*42/gi, "rgba(23, 26, 20"],
  [/rgba\(\s*248,\s*250,\s*252/gi, "rgba(231, 234, 223"],
  [/rgba\(\s*226,\s*232,\s*240/gi, "rgba(224, 227, 216"],
];

const dry = process.argv.includes("--dry");
const files = process.argv.filter((a) => a.endsWith(".css"));
let totalHits = 0;
for (const file of files) {
  let css = readFileSync(file, "utf8");
  let hits = 0;
  for (const [from, to] of Object.entries(MAP)) {
    const re = new RegExp(`#${from}\\b`, "gi");
    css = css.replace(re, (m) => {
      hits += 1;
      return `#${to}`;
    });
  }
  for (const [re, to] of RGBA_MAP) {
    css = css.replace(re, () => {
      hits += 1;
      return to;
    });
  }
  if (hits && !dry) writeFileSync(file, css);
  if (hits) console.log(`${file}: ${hits}`);
  totalHits += hits;
}
console.log(`total: ${totalHits}`);
