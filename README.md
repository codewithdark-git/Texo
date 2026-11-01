# Texo

A desktop AI LaTeX editor for Windows. Projects are plain folders on your disk, compiling works offline, and the AI assistant uses your own provider key.

> Early development. The dashboard and the editor work; compiling and the PDF preview come next. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

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
- Shortcuts: Ctrl+S save, Ctrl+B bold, Ctrl+I italic, Alt+Z word wrap, F2 rename in the file tree.

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
| `src-tauri/src/commands.rs` | Tauri commands the UI calls |
| `src/workspace/` | The editor workspace: file tree, tabs, outline, autosave |
| `src/editor/` | Monaco setup, LaTeX/BibTeX grammars, themes, completions |
| `src-tauri/templates/` | Starter projects |
