# Texo

A desktop AI LaTeX editor for Windows. Projects are plain folders on your disk, compiling works offline, and the AI assistant uses your own provider key.

> Early development. This build has the project dashboard only. The editor, compiler, and PDF preview come next. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.

## What works now

- A dashboard of your projects, in a list or a grid, with search and sorting by name, last edited, or created date.
- New blank or example project.
- Open any existing LaTeX folder. Texo finds the main `.tex` file.
- Rename, duplicate, show in File Explorer, and move to the Recycle Bin.
- Choose where new projects are saved (default: `Documents\Texo`).

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
| `src-tauri/src/commands.rs` | Tauri commands the UI calls |
| `src-tauri/templates/` | Starter projects |
