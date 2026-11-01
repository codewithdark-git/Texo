# Texo

**Write LaTeX on your own machine.** Texo is a desktop LaTeX editor for Windows with a live PDF preview, clear compile errors, and jumps between your source and the PDF. Your projects stay plain folders on your disk, and they compile offline with the TeX you already have.

![Texo: the LaTeX source on the left and the live PDF preview on the right](docs/screenshot.png)

> **Pre-release.** Texo is in active development toward its first full release (`v0.1.0`). The alpha builds already let you write, compile and preview real papers. An AI writing assistant comes next. [Download the latest alpha →](https://github.com/codewithdark-git/Texo/releases)

## Why Texo

- **Your files, your disk.** A project is an ordinary folder. Texo keeps its own data in a hidden `.texo/` subfolder and never rewrites your sources behind your back.
- **Fast feedback.** Save, and the PDF updates beside the editor. Errors link straight to the line that caused them.
- **Works offline.** It compiles with MiKTeX or TeX Live on your PC. No account and no upload.
- **Safe with other people's projects.** Downloaded projects can't run their own build scripts until you trust them.

## Features

### Projects
- A dashboard of your projects as a list or a grid of first-page thumbnails, with search and sorting.
- Start from a blank or an example paper, or open any existing LaTeX folder. Texo finds the main `.tex` file.
- Rename, duplicate, show in File Explorer, and move to the Recycle Bin.

### Editor
- The Monaco editor (the one inside VS Code) with LaTeX and BibTeX highlighting, folding, sticky section headers, and warnings for look-alike Unicode characters.
- **Completions** for:
  - LaTeX commands, and environments (`\begin{…}` inserts the matching `\end`).
  - `\ref` labels, and `\cite` keys from your `.bib` files (search by key, title or author).
  - Commands you define with `\newcommand`.
  - File paths for `\input`, `\include`, `\includegraphics` and `\bibliography`.
- Autosave, tabs, an outline of the current file, image previews, and a file tree. In the tree you can create, rename and move files, drop files in from File Explorer, and choose the main document.
- Edits made in other apps appear right away. If a file changes on disk while you have unsaved edits, Texo asks which version to keep.

### Compiling
- **Toolchains:** pdfLaTeX, XeLaTeX or LuaLaTeX, run through latexmk or directly. BibTeX and Biber run automatically. Tectonic is supported if it's installed.
- **When it runs:** automatically after each save, or with Compile / Ctrl+Enter. A running compile can be stopped.
- **Issues panel:** errors, warnings and layout problems, read from the TeX, BibTeX and Biber logs. Each shows TeX's context and links to its line, and they also appear as squiggles in the editor. Common problems come with plain-language hints.
- **Live log** while compiling, plus the full TeX log.

### PDF
- **Built-in viewer:** fit width or fit page, zoom (Ctrl+mouse wheel too), find (Ctrl+F), selectable text, clickable links, and a dark page mode. It keeps your place when the PDF updates.
- **SyncTeX:**
  - Double-click the PDF to jump to the source line.
  - Press Ctrl+Alt+J to highlight the cursor's spot in the PDF.
- **Always a PDF in your project:** after each successful compile, Texo saves the PDF next to your main file (`main.tex` → `main.pdf`). It's one file, kept up to date, and a failed compile never replaces it. If you already have a file with that name, Texo leaves it alone.

### Shortcuts

| Keys | Action |
|---|---|
| Ctrl+S | Save |
| Ctrl+Enter | Compile |
| Ctrl+Alt+J | Show the cursor's position in the PDF |
| Double-click PDF | Jump to the source line |
| Ctrl+B / Ctrl+I | Bold / italic |
| Alt+Z | Toggle word wrap |
| F2 | Rename in the file tree |

## Install

1. Install [MiKTeX](https://miktex.org/download) or [TeX Live](https://tug.org/texlive/) if you don't have a TeX distribution yet.
2. Download `Texo_…_x64-setup.exe` from the [releases page](https://github.com/codewithdark-git/Texo/releases) and run it.

The alpha installers aren't code-signed yet, so Windows SmartScreen may warn you. Choose **More info → Run anyway**. Texo installs for the current user and needs WebView2, which comes with Windows 11; the installer fetches it on older systems.

## How a project is stored

```
My paper/
├── main.tex
├── main.pdf           # the latest compiled PDF, kept up to date by Texo
├── references.bib
└── .texo/
    ├── project.json   # name, main document, engine
    └── build/         # aux files, logs, SyncTeX data
```

The folder still works in any other LaTeX editor.

## Security

- **Project trust:** a project's `latexmkrc` is Perl code, so it only runs for projects you created in Texo or chose to trust.
- **No shell escape:** shell escape is off for every project.
- **Absolute tool paths:** tools run by absolute path, so a project can't substitute its own `pdflatex.exe`.
- **No writing through links:** Texo won't write through links planted in `.texo/`.

## Roadmap

- **Next alpha:** import and export of zip files, more templates, a word count panel, a settings screen.
- **Then:** an AI assistant with your own provider key (OpenAI, Anthropic or a local model), with proposed changes you keep or undo, and Fix / Edit / Proofread with AI.
- **v0.1.0:** version history with restore, and a real-paper compile test suite.
- **Later:** Zotero, Beamer presentation mode, collaboration, Git sync, macOS and Linux.

## Development

Requirements: Node 24+, pnpm, Rust (stable, MSVC), and Visual Studio Build Tools with the C++ workload.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

Run every check (typecheck, frontend tests, Rust tests), the same as CI:

```bash
pnpm check
```

With MiKTeX or TeX Live installed, also compile real documents. These tests cover latexmk and the direct engine, SyncTeX, and the security guards:

```bash
pnpm test:tex
```

Build the installer into `src-tauri/target/release/bundle/nsis/`:

```bash
pnpm tauri build
```

### Code layout

| Path | What |
|---|---|
| `src/components/` | Dashboard and shared UI |
| `src/workspace/` | Workspace: file tree, tabs, outline, autosave, compile panel, PDF viewer |
| `src/editor/` | Monaco setup, LaTeX/BibTeX grammars, themes, completions |
| `src/lib/api.ts` | Typed wrappers for the Rust commands |
| `src-tauri/src/project.rs` | Project folders: create, scan, rename, duplicate, saved PDF |
| `src-tauri/src/fsops.rs` | File reads and writes, confined to the project |
| `src-tauri/src/compile.rs` | Finds TeX tools and runs latexmk, the engine, or Tectonic |
| `src-tauri/src/texlog.rs` | Turns TeX/BibTeX/Biber logs into issues |
| `src-tauri/src/synctex.rs` | Reads SyncTeX data for jumps between source and PDF |
| `src-tauri/src/watcher.rs` | Notices file changes made outside Texo |
| `src-tauri/src/symbols.rs` | Finds labels, citations, and commands for completions |

## License

[MIT](LICENSE)
