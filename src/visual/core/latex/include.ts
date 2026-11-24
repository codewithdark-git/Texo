// Where \input{..}, \include{..} and \subfile{..} point. A pure function of the
// target and the current file, so the view can open the file it names. Paths
// are project-relative with "/" separators; anything that could reach outside
// the project (.., an absolute path, a drive letter, a URL) is refused.

/** The folder part of a project-relative path ("" for the root). */
function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/** Joins and normalises project-relative segments; null when it climbs above the root. */
function join(dir: string, rel: string): string | null {
  const out: string[] = [];
  for (const seg of (dir ? dir + "/" + rel : rel).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** True for targets that must never be followed: absolute, drive, UNC, home, URL, macro or escaping paths. */
function unsafe(target: string): boolean {
  if (target === "") return true;
  if (/^[/\\~]/.test(target)) return true;
  if (/^[A-Za-z]:/.test(target) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return true;
  if (/[\\\0-\x1f{}%"*?<>|]/.test(target)) return true;
  return target.split("/").includes("..");
}

/**
 * The project files an include target may mean, most likely first: relative
 * to the current file's folder, then to the project root, each with ".tex"
 * added the way TeX adds it. Null when the target is refused.
 *
 *   includeCandidates("sec_intro", "chapters/main.tex")
 *   -> ["chapters/sec_intro.tex", "chapters/sec_intro", "sec_intro.tex", "sec_intro"]
 */
export function includeCandidates(target: string, fromFile: string): string[] | null {
  const t = target.trim().replace(/^(\.\/)+/, "");
  if (unsafe(t)) return null;
  const last = t.slice(t.lastIndexOf("/") + 1);
  const names = /\.[A-Za-z0-9]+$/.test(last) ? [t, t + ".tex"] : [t + ".tex", t];
  const out: string[] = [];
  for (const dir of [dirOf(fromFile.replace(/\\/g, "/")), ""]) {
    for (const n of names) {
      const p = join(dir, n);
      if (p !== null && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

/**
 * The project file an include target names, or null when it is refused or
 * none of the candidates exists. `exists` answers for project-relative paths.
 */
export function resolveInclude(target: string, fromFile: string, exists: (path: string) => boolean): string | null {
  const c = includeCandidates(target, fromFile);
  if (!c) return null;
  return c.find((p) => exists(p)) ?? null;
}
