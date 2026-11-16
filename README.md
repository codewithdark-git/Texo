# Texo

**Write LaTeX on your own machine.** Texo is a desktop LaTeX editor for Windows and Linux with a live PDF preview, clear compile errors, and jumps between your source and the PDF. It comes with its own LaTeX engine, so there's nothing else to install, and your projects stay plain folders on your disk.

![Texo: the LaTeX source on the left and the live PDF preview on the right](docs/screenshot.png)

**[Download Texo 1.0 →](https://github.com/codewithdark-git/Texo/releases/latest)** for Windows and Linux.

## Why Texo

- **Your files, your disk.** A project is an ordinary folder. Texo keeps its own data in a hidden `.texo/` subfolder and never rewrites your sources behind your back.
- **Code or Visual.** Edit the LaTeX source, or switch a file to Visual mode and write in a rendered view with headings, lists, maths and tables, while Texo keeps the source tidy.
- **Fast feedback.** Save, and the PDF updates beside the editor. Errors link straight to the line that caused them.
- **Nothing else to install.** A LaTeX engine ([Tectonic](https://tectonic-typesetting.github.io)) ships with the app. If you already use MiKTeX or TeX Live, Texo uses that instead.
- **Works offline.** After the first compile, which fetches the LaTeX packages a document needs, everything stays local. No account and no upload.
- **Safe with other people's projects.** Downloaded projects can't run their own build scripts until you trust them.

## Features

### Projects
- A dashboard of your projects as a list or a grid of first-page thumbnails, with search and sorting.
- **Ten templates** to start from, each a plain folder that compiles with every engine:
  - **Start:** Blank.
  - **Papers:** Paper, Two-column paper (conference style), Report, Thesis.
  - **Teaching:** Lecture notes (theorems, proofs, key-point boxes), Assignment (problems, parts and solutions).
  - **Slides:** Beamer slides.
  - **Personal:** Letter, CV.
- The New project gallery groups them by category and previews what each one gives you. With no projects yet, the dashboard shows them all.
- Open any existing LaTeX folder (Texo finds the main `.tex` file), or **import** a `.zip` or `.tar.gz` from another editor. **Export** a project as a `.zip`.
- Rename, duplicate, show in File Explorer, and move to the Recycle Bin, from the ⋯ button or a right-click. Short confirmations tell you what happened.
- Drop a project folder on the window to open it.
- Light and dark themes (or follow the system), and the window reopens where you left it.

### Visual mode
- Switch any `.tex` or `.md` file between **Code** and **Visual** with the toggle above the editor or Ctrl+Shift+E. Each file remembers its mode.
- Visual mode shows the document rendered: sections, lists, quotes, theorems, figures with their images, tables, rendered maths (click to edit), citations and references, and Beamer frames as slide cards.
- A toolbar and shortcuts for text style, headings, lists, links, maths, figures, tables and citations. Markdown-style typing works too: `# ` makes a heading, `- ` a list, `**bold**` bold.
- It edits the same source as Code mode, with one undo history. Anything it doesn't render stays as editable source, and nothing you didn't touch is rewritten.
- Markdown files open in Visual mode and LaTeX files in Code mode by default; change this in Settings.

### Editor
- The Monaco editor (the one inside VS Code) with LaTeX and BibTeX highlighting, folding, sticky section headers, and warnings for look-alike Unicode characters.
- **Completions** for:
  - LaTeX commands, and environments (`\begin{…}` inserts the matching `\end`).
  - `\ref` labels, and `\cite` keys from your `.bib` files (search by key, title or author).
  - Commands you define with `\newcommand`.
  - File paths for `\input`, `\include`, `\includegraphics` and `\bibliography`.
- Autosave, tabs, an outline of the current file, image previews, and a file tree. In the tree you can create, rename and move files, drop files in from File Explorer, and choose the main document.
- **Quick Open** (Ctrl+P) jumps to any file by typing part of its name.
- **Search in project** (Ctrl+Shift+F) across every file, with jumps to each match.
- Hover over maths in Code mode to see it rendered.
- Reopening a project brings back its open tabs, the active file, and where your cursor was.
- The status bar shows the word count of the open file and when the PDF was last compiled. Click the count for a detailed **word count** of the whole document, file by file: running text, headings, captions, figures, tables and citations.
- **Settings** (Ctrl+,): theme, font size, word wrap, the default mode for each file type, formula previews, the compiler and automatic compiling, and the projects folder.
- Edits made in other apps appear right away. If a file changes on disk while you have unsaved edits, Texo asks which version to keep.

### Compiling
- **Engines:** the built-in Tectonic engine (XeTeX-based), or your installed MiKTeX or TeX Live with pdfLaTeX, XeLaTeX or LuaLaTeX, run through latexmk or directly. BibTeX and Biber run automatically.
- **First launch:** Texo prepares the built-in engine in the background (a one-time download of about 90 MB of common LaTeX packages) and shows the progress in the sidebar.
- **When it runs:** automatically after each save, or with Compile / Ctrl+Enter. A running compile can be stopped.
- **Issues panel:** errors, warnings and layout problems, read from the TeX, BibTeX and Biber logs. Each shows TeX's context and links to its line, and they also appear as squiggles in the editor. Common problems come with plain-language hints.
- **Live log** while compiling, plus the full TeX log.

### PDF
- **Built-in viewer:** fit width or fit page, zoom (Ctrl+mouse wheel too), find (Ctrl+F), selectable text, clickable links, and a dark page mode. It keeps your place when the PDF updates.
- **SyncTeX:**
  - Double-click the PDF to jump to the source line.
  - Press Ctrl+Alt+J to highlight the cursor's spot in the PDF.
- **Save PDF as…** copies the compiled PDF anywhere.
- **Always a PDF in your project:** after each successful compile, Texo saves the PDF next to your main file (`main.tex` → `main.pdf`). It's one file, kept up to date, and a failed compile never replaces it. If you already have a file with that name, Texo leaves it alone.

### Shortcuts

| Keys | Action |
|---|---|
| Ctrl+P | Go to a file |
| Ctrl+Shift+F | Search in project |
| Ctrl+Shift+E | Switch between Code and Visual |
| Ctrl+, | Settings |
| Ctrl+S | Save (Texo also saves automatically) |
| Ctrl+Enter | Compile |
| Ctrl+W / Ctrl+Tab | Close tab / next tab |
| Ctrl+= / Ctrl+- / Ctrl+0 | Editor zoom in / out / reset |
| Ctrl+Alt+J | Show the cursor's position in the PDF |
| Double-click PDF | Jump to the source line |
| Ctrl+B / Ctrl+I | Bold / italic |
| Alt+Z | Toggle word wrap |
| F2 | Rename in the file tree |
| Ctrl+N / Ctrl+O | New project / open a folder (dashboard) |
| Ctrl+Shift+O | Import a .zip (dashboard) |
| Ctrl+Shift+/ | All shortcuts |

## Install

Download from the [releases page](https://github.com/codewithdark-git/Texo/releases). No separate LaTeX install is needed.

**Windows:** run `Texo_…_x64-setup.exe`. The installers aren't code-signed yet, so SmartScreen may warn you. Choose **More info → Run anyway**. Texo installs for the current user. It needs WebView2, which comes with Windows 11; the installer fetches it on older systems.

**Linux (x86-64):**
- **AppImage** (any distribution): make it executable, then run it.

  ```bash
  chmod +x Texo_*_amd64.AppImage
  ```

  ```bash
  ./Texo_*_amd64.AppImage
  ```

- **Debian / Ubuntu:** install the `.deb` package.

  ```bash
  sudo apt install ./Texo_*_amd64.deb
  ```

The Linux builds need WebKitGTK 4.1, which current GNOME and KDE desktops already have.

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
- **No shell escape:** shell escape is off for every project, and untrusted projects run the built-in engine in its untrusted mode.
- **Absolute tool paths:** tools run by absolute path, so a project can't substitute its own `pdflatex.exe`.
- **No writing through links:** Texo won't write through links planted in `.texo/`.

## Roadmap

- **Next:** an AI writing assistant, version history with restore.
- **Later:** Zotero, Beamer presentation mode, collaboration, Git sync, macOS.

## Development

Requirements: Node 24+, pnpm, and Rust (stable). On Windows, also Visual Studio Build Tools with the C++ workload. On Linux, the [Tauri system packages](https://v2.tauri.app/start/prerequisites/#linux) (WebKitGTK 4.1 and friends).

The dev and build commands download the bundled Tectonic engine into `src-tauri/binaries/` on first use. It's a pinned version, checked against a SHA-256 hash.

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

Build the installers (Windows: NSIS `.exe`, Linux: AppImage and `.deb`):

```bash
pnpm tauri build
```

```bash
pnpm tauri build --bundles appimage,deb
```

Pushing a `v*` tag builds both platforms in CI and attaches the installers to the GitHub release.

### Code layout

| Path | What |
|---|---|
| `src/components/` | Dashboard and shared UI |
| `src/workspace/` | Workspace: file tree, tabs, outline, autosave, compile panel, PDF viewer |
| `src/editor/` | Monaco setup, LaTeX/BibTeX grammars, themes, completions |
| `src/visual/core/` | Visual mode's lossless LaTeX and Markdown parsing and writing |
| `src/visual/view/` | Visual mode's editor view, toolbar, input rules and popovers |
| `src/lib/templates.tsx` | The template gallery's catalogue and thumbnails |
| `src/lib/api.ts` | Typed wrappers for the Rust commands |
| `src-tauri/src/project.rs` | Project folders: create, scan, rename, duplicate, saved PDF |
| `src-tauri/src/fsops.rs` | File reads and writes, confined to the project |
| `src-tauri/src/compile.rs` | Finds TeX tools and runs latexmk, the engine, or Tectonic |
| `src-tauri/src/texlog.rs` | Turns TeX/BibTeX/Biber logs into issues |
| `src-tauri/src/synctex.rs` | Reads SyncTeX data for jumps between source and PDF |
| `src-tauri/src/templates.rs`, `src-tauri/templates/` | Project templates |
| `src-tauri/src/archive.rs` | Zip and tar.gz import and export |
| `src-tauri/src/watcher.rs` | Notices file changes made outside Texo |
| `src-tauri/src/symbols.rs` | Finds labels, citations, and commands for completions |

## License

[MIT](LICENSE)
