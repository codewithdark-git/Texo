#!/usr/bin/env node
// Downloads the Tectonic TeX engine that Texo bundles, verifies it against a
// pinned SHA-256, and places it where Tauri expects a sidecar binary:
//   src-tauri/binaries/tectonic-<target-triple>[.exe]
//
// Runs before `tauri dev` and `tauri build`; it does nothing when the right
// version is already in place.
//
//   node scripts/fetch-tectonic.mjs [target-triple]

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.17.0";
const BASE = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}`;

/** Release archives per Texo target, with the SHA-256 of each archive. */
const ARCHIVES = {
  "x86_64-pc-windows-msvc": {
    file: `tectonic-${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f",
    binary: "tectonic.exe",
  },
  // The musl build is statically linked, so it runs on any Linux distribution.
  "x86_64-unknown-linux-gnu": {
    file: `tectonic-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7",
    binary: "tectonic",
  },
};

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return out.match(/^host: (.+)$/m)[1].trim();
}

const triple = process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const spec = ARCHIVES[triple];
if (!spec) {
  console.error(`fetch-tectonic: no bundled Tectonic for ${triple}. Supported: ${Object.keys(ARCHIVES).join(", ")}`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries");
const ext = triple.includes("windows") ? ".exe" : "";
const target = join(outDir, `tectonic-${triple}${ext}`);
const stamp = `${target}.version`;

if (existsSync(target) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) {
  process.exit(0);
}

console.log(`fetch-tectonic: downloading Tectonic ${VERSION} for ${triple}…`);
const res = await fetch(`${BASE}/${spec.file}`);
if (!res.ok) {
  console.error(`fetch-tectonic: download failed (${res.status} ${res.statusText})`);
  process.exit(1);
}
const data = Buffer.from(await res.arrayBuffer());
const digest = createHash("sha256").update(data).digest("hex");
if (digest !== spec.sha256) {
  console.error(`fetch-tectonic: checksum mismatch for ${spec.file}\n  expected ${spec.sha256}\n  got      ${digest}`);
  process.exit(1);
}

// Extract in a fresh temporary folder. `tar` reads both .zip (Windows 10+
// ships bsdtar) and .tar.gz.
const work = mkdtempSync(join(tmpdir(), "texo-tectonic-"));
try {
  const archive = join(work, spec.file);
  writeFileSync(archive, data);
  // On Windows use the system's bsdtar: a GNU tar from Git or MSYS on PATH
  // would read "C:" in the path as a remote host name.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", work], { stdio: "inherit" });
  mkdirSync(outDir, { recursive: true });
  // Copy, not rename: the temp folder may be on another drive.
  copyFileSync(join(work, spec.binary), target);
  if (!ext) chmodSync(target, 0o755);
  writeFileSync(stamp, `${VERSION}\n`);
  console.log(`fetch-tectonic: ready at ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
