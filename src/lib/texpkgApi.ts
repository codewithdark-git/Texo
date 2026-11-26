// Bindings for installing a missing TeX package or font (src-tauri/src/texpkg.rs).
// The Issues panel offers this from a `[fix:install-package:<name>]` hint and
// asks the user to confirm before calling it.
import { invoke } from "@tauri-apps/api/core";

/** What `install_tex_package` returns. Failures to run the tool at all come back as a rejected promise with a plain message. */
export interface InstallOutcome {
  ok: boolean;
  /** What happened, in plain words (including "needs administrator rights"). */
  message: string;
  /** The end of the package manager's output. */
  output: string;
}

/** Payload of `tex-package-output` events: lines from the package manager as it runs. */
export interface TexPackageOutput {
  package: string;
  lines: string[];
}

export const TEX_PACKAGE_OUTPUT_EVENT = "tex-package-output";

/** Same rule as the backend: `^[A-Za-z0-9._-]+$`, not starting with `-` or `.`. */
export function isValidPackageName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** Installs one package with MiKTeX (`miktex packages install`) or TeX Live (`tlmgr install`). */
export const installTexPackage = (pkg: string) => invoke<InstallOutcome>("install_tex_package", { package: pkg });
