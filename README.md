# Texo

A desktop AI LaTeX editor for Windows. Projects are plain folders on your disk, compiling works offline, and the AI assistant uses your own provider key.

> Early development. The dashboard, editor, compiler, and PDF preview work; the AI assistant comes next. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## What works now

- A dashboard of your projects, in a list or a grid, with search and sorting by name, last edited, or created date.
- New blank or example project.
- Open any existing LaTeX folder. Texo finds the main `.tex` file.
- Rename, duplicate, show in File Explorer, and move to the Recycle Bin.
- Choose where new projects are saved (default: `Documents\Texo`).
- **Editor** (Monaco) with LaTeX and BibTeX highlighting, folding, sticky section headers, and warnings for look-alike Unicode characters.
- **Completions** for LaTeX commands, environments (`\begin{…}` inserts the matching `\end`), `\ref` labels, `\cite` keys from your `.bib` files (searchable by title and author), commands you define with `\newcommand`, and file paths for `\input`, `\include`, `\includegraphics`, and `\bibliography`.
- **Autosave** a moment after you stop typing, plus Ctrl+S. Files are written safely through a temporary file.
- **File tree**: new file or folder, rename or move, set the main document, show in File Explorer, move to the Recycle Bin. Drop files from File Explorer onto a folder to copy them in.
- **Tabs**, an **outline** of the open file, image previews, and a status bar.
- Edits made in other apps show up right away. If a file changes on disk while you have unsaved edits, Texo asks which version to keep.
- **Compiling** with the TeX already on your PC (MiKTeX or TeX Live): pdfLaTeX, XeLaTeX, or LuaLaTeX, run through latexmk, or directly when Perl isn't available. BibTeX and Biber run automatically, and a project's `.latexmkrc` is respected. Tectonic is used if it's installed. Build files go to `.texo/build/`.
- Compiles automatically after each save (can be turned off), or press Compile / Ctrl+Enter. A running compile can be stopped, and stops on its own after 4 minutes.
- **Issues panel**: errors, warnings, and layout warnings parsed from the TeX, BibTeX, and Biber logs, with filters, TeX's error context, plain-language hints for common problems, and click-to-jump to the line. Errors and warnings also show as squiggles in the editor.
- The console output streams live in the Log tab, and the full TeX log is one click away.
- **PDF preview** (pdf.js) next to the editor: fit width or page, zoom (also Ctrl+mouse wheel), page jump, find in PDF (Ctrl+F), a dark mode for the page, selectable text, clickable links, and "open in your PDF app". It keeps your zoom and scroll position when the PDF updates.
- **SyncTeX**: double-click anywhere in the PDF to jump to that source line, or press Ctrl+Alt+J (or the crosshair button) to highlight the cursor's position in the PDF.
- The dashboard grid shows each project's first page.
- **Project trust**: a `latexmkrc` file is Perl code, so it only runs for projects you create in Texo or choose to trust. Folders opened from disk compile with it skipped until you click "Trust this project". Shell escape is always off.
- Shortcuts: Ctrl+S save, Ctrl+Enter compile, Ctrl+Alt+J show in PDF, Ctrl+B bold, Ctrl+I italic, Alt+Z word wrap, F2 rename in the file tree.

## How a project is stored

```
My paper/
├── main.tex
├── references.bib
└── .texo/
    └── project.json   # id, name, main document, engine
```

Texo only writes inside `.texo/`. Your LaTeX files stay untouched, and the folder still works in any other editor.

## Development

Requirements: Node 24+, pnpm, Rust (stable, MSVC), and Visual Studio Build Tools with the C++ workload. WebView2 ships with Windows 11.

```bash
pnpm install
```

```bash
pnpm tauri dev
```

Tests:

```bash
pnpm typecheck && pnpm test
```

```bash
cd src-tauri && cargo test
```

With MiKTeX or TeX Live installed, this also compiles a real document through latexmk and the engine directly:

```bash
cd src-tauri && cargo test -- --ignored
```

Build an installer (unsigned) into `src-tauri/target/release/bundle/nsis/`:

```bash
pnpm tauri build
```

## Layout

| Path | What |
|---|---|
| `src/` | React UI (Vite, Tailwind, Zustand) |
| `src/lib/api.ts` | Typed wrappers for the Rust commands |
| `src-tauri/src/project.rs` | Project folder model: create, scan, rename, duplicate, delete |
| `src-tauri/src/fsops.rs` | File reads and writes, confined to the project folder |
| `src-tauri/src/watcher.rs` | Tells the UI when files change on disk |
| `src-tauri/src/symbols.rs` | Finds labels, citation keys, and custom commands for completions |
| `src-tauri/src/compile.rs` | Finds TeX tools and runs latexmk, the engine, or Tectonic |
| `src-tauri/src/texlog.rs` | Turns TeX/BibTeX/Biber logs into issues |
| `src-tauri/src/synctex.rs` | Reads `.synctex.gz` for jumps between source and PDF |
| `src-tauri/src/commands.rs` | Tauri commands the UI calls |
| `src/workspace/` | The editor workspace: file tree, tabs, outline, autosave |
| `src/editor/` | Monaco setup, LaTeX/BibTeX grammars, themes, completions |
| `src-tauri/templates/` | Starter projects |
