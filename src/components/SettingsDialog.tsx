// Settings (Ctrl+,): appearance, editor, compiling, files, projects, and
// About, as sections listed on the left. Every change applies at once.
import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { FolderCog, Hammer, Heart, Info, Library, Minus, Palette, Plus, RefreshCw, Type, Files } from "lucide-react";
import { api, errorText, type Compiler, type Toolchains } from "../lib/api";
import { getEditorPrefs, onEditorPrefs, setEditorPrefs, type EditorPrefs } from "../lib/editorPrefs";
import { getShowHidden, setShowHidden } from "../lib/hiddenFiles";
import { getThemePref, onThemeChange, setThemePref, type ThemePref } from "../lib/theme";
import { useApp } from "../store";
import { toast, useUi } from "../ui";
import { useCompile } from "../workspace/compileStore";
import { Button, Modal } from "./Dialog";
import { changeProjectsRoot, Logo } from "./Sidebar";

type Section = "appearance" | "editor" | "compile" | "files" | "projects" | "about";

const SECTIONS: [Section, string, typeof Palette][] = [
  ["appearance", "Appearance", Palette],
  ["editor", "Editor", Type],
  ["compile", "Compile", Hammer],
  ["files", "Files", Files],
  ["projects", "Projects", Library],
  ["about", "About", Info],
];

const FONT_MIN = 9;
const FONT_MAX = 32;

/** One labelled setting: the name and help on the left, the control on the right. */
function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {help && <div className="mt-0.5 text-xs text-muted">{help}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 rounded-full transition ${checked ? "bg-accent" : "bg-surface-2 ring-1 ring-border"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

/** A small segmented control. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-border bg-surface-2/50 p-0.5">
      {options.map(([v, name]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-xs ${value === v ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text"}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{children}</h3>;
}

function AppearanceSection() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => onThemeChange(() => setPref(getThemePref())), []);
  return (
    <>
      <Heading>Appearance</Heading>
      <Row label="Theme" help="Applies to the app, the editor and the window frame.">
        <Choice
          label="Theme"
          value={pref}
          options={[
            ["system", "Match system"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          onChange={(v) => {
            setThemePref(v);
            setPref(v);
          }}
        />
      </Row>
    </>
  );
}

function EditorSection() {
  const [prefs, setPrefs] = useState<EditorPrefs>(getEditorPrefs);
  useEffect(() => onEditorPrefs(setPrefs), []);
  const set = (patch: Partial<EditorPrefs>) => setPrefs(setEditorPrefs(patch));
  const font = (size: number) => set({ fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, size)) });
  const modes: ["code" | "visual", string][] = [
    ["code", "Code"],
    ["visual", "Visual"],
  ];

  return (
    <>
      <Heading>Editor</Heading>
      <Row label="Font size">
        <div className="flex items-center gap-1">
          <Button aria-label="Smaller" disabled={prefs.fontSize <= FONT_MIN} onClick={() => font(prefs.fontSize - 1)}>
            <Minus size={13} />
          </Button>
          <span className="w-10 text-center text-sm tabular-nums" aria-live="polite">
            {prefs.fontSize}px
          </span>
          <Button aria-label="Larger" disabled={prefs.fontSize >= FONT_MAX} onClick={() => font(prefs.fontSize + 1)}>
            <Plus size={13} />
          </Button>
        </div>
      </Row>
      <div
        className="mb-1 truncate rounded-lg border border-border bg-bg px-3 py-2 font-mono text-text/90"
        style={{ fontSize: prefs.fontSize }}
        aria-hidden="true"
      >
        {"\\section{Results} $E = mc^2$"}
      </div>
      <Row label="Word wrap" help="Wrap long lines instead of scrolling sideways (Alt+Z).">
        <Toggle label="Word wrap" checked={prefs.wordWrap} onChange={(wordWrap) => set({ wordWrap })} />
      </Row>
      <Row label="Open LaTeX files in">
        <Choice label="Open LaTeX files in" value={prefs.defaultTexMode} options={modes} onChange={(defaultTexMode) => set({ defaultTexMode })} />
      </Row>
      <Row label="Open Markdown files in">
        <Choice label="Open Markdown files in" value={prefs.defaultMdMode} options={modes} onChange={(defaultMdMode) => set({ defaultMdMode })} />
      </Row>
      <Row label="Formula preview on hover" help="Show the rendered formula when the pointer rests on maths.">
        <Toggle label="Formula preview on hover" checked={prefs.mathHover} onChange={(mathHover) => set({ mathHover })} />
      </Row>
      <Row label="Show LaTeX comments in Visual mode" help="Comments never appear in the PDF; Visual mode hides them unless this is on.">
        <Toggle
          label="Show LaTeX comments in Visual mode"
          checked={prefs.visualShowComments}
          onChange={(visualShowComments) => set({ visualShowComments })}
        />
      </Row>
      <Row label="New displayed formulas use">
        <Choice
          label="New displayed formulas use"
          value={prefs.displayMath}
          options={[
            ["brackets", "\\[ \\]"],
            ["equation", "equation*"],
          ]}
          onChange={(displayMath) => set({ displayMath })}
        />
      </Row>
    </>
  );
}

const COMPILERS: [Compiler, string][] = [
  ["auto", "Automatic"],
  ["latexmk", "latexmk"],
  ["direct", "Engine directly"],
  ["tectonic", "Tectonic"],
];

const TOOLS: [keyof Toolchains, string][] = [
  ["latexmk", "latexmk"],
  ["perl", "Perl"],
  ["pdflatex", "pdfLaTeX"],
  ["xelatex", "XeLaTeX"],
  ["lualatex", "LuaLaTeX"],
  ["bibtex", "BibTeX"],
  ["biber", "Biber"],
  ["makeindex", "MakeIndex"],
  ["tectonic", "Tectonic"],
];

function CompileSection() {
  const auto = useCompile((s) => s.auto);
  const setAuto = useCompile((s) => s.setAuto);
  const [compiler, setCompiler] = useState<Compiler | null>(useApp.getState().settings?.compiler ?? null);
  const [tools, setTools] = useState<Toolchains | null>(null);
  const [detecting, setDetecting] = useState(false);

  const detect = async () => {
    setDetecting(true);
    try {
      setTools(await api.detectToolchains());
    } catch (err) {
      toast(errorText(err), "error");
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    void api.getSettings().then((s) => setCompiler(s.compiler), () => {});
    void detect();
  }, []);

  const choose = async (value: Compiler) => {
    setCompiler(value);
    try {
      const settings = await api.setCompiler(value);
      useApp.setState({ settings });
      useCompile.setState({ compiler: settings.compiler });
      void useApp.getState().checkEngine();
    } catch (err) {
      toast(errorText(err), "error");
    }
  };

  return (
    <>
      <Heading>Compile</Heading>
      <Row label="Compile automatically after saving">
        <Toggle label="Compile automatically after saving" checked={auto} onChange={setAuto} />
      </Row>
      <Row label="Compiler" help="Which tool runs LaTeX. Automatic picks one for you.">
        {compiler ? <Choice label="Compiler" value={compiler} options={COMPILERS} onChange={(v) => void choose(v)} /> : <span className="text-xs text-muted">…</span>}
      </Row>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-sm">Detected tools</span>
        <Button variant="ghost" onClick={() => void detect()} disabled={detecting}>
          <RefreshCw size={13} className={detecting ? "animate-spin" : ""} /> Refresh
        </Button>
      </div>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-bg px-3 py-2 text-xs">
        {tools?.distribution && (
          <>
            <dt className="text-muted">Distribution</dt>
            <dd>{tools.distribution}</dd>
          </>
        )}
        {TOOLS.map(([key, name]) => {
          const value = tools?.[key];
          const path = typeof value === "string" ? value : null;
          return (
            <div key={key} className="contents">
              <dt className="text-muted">{name}</dt>
              <dd className="truncate font-mono" title={path ?? undefined}>
                {!tools ? "…" : path ? (key === "tectonic" && tools.tectonicBundled ? "Built in" : path) : <span className="text-muted">Not found</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}

function FilesSection() {
  const [show, setShow] = useState(getShowHidden);
  return (
    <>
      <Heading>Files</Heading>
      <Row
        label="Show hidden and build files"
        help="Dotfiles, .aux, .log, .synctex.gz and other files a compile leaves behind, in the file list, Quick Open and search."
      >
        <Toggle
          label="Show hidden and build files"
          checked={show}
          onChange={(on) => {
            setShow(on);
            setShowHidden(on);
          }}
        />
      </Row>
    </>
  );
}

function ProjectsSection() {
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    void api.getSettings().then((s) => useApp.setState({ settings: s }), () => {});
  }, []);
  const external = settings?.externalProjects ?? [];
  return (
    <>
      <Heading>Projects</Heading>
      <Row label="Projects folder" help="Where new projects are saved.">
        <Button onClick={() => void changeProjectsRoot()}>
          <FolderCog size={14} /> Change…
        </Button>
      </Row>
      <div className="truncate rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs" title={settings?.projectsRoot}>
        {settings?.projectsRoot ?? "…"}
      </div>
      <div className="mt-4 mb-1 text-sm">Projects opened from other folders</div>
      {external.length === 0 ? (
        <p className="text-xs text-muted">None yet. Folders you open from elsewhere are listed here.</p>
      ) : (
        <ul className="max-h-40 overflow-auto rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-xs">
          {external.map((path) => (
            <li key={path} className="truncate py-0.5" title={path}>
              {path}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AboutSection() {
  const [version, setVersion] = useState("");
  const openDialog = useUi((s) => s.openDialog);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  return (
    <>
      <Heading>About</Heading>
      <div className="mt-2 flex items-center gap-3">
        <Logo size={40} />
        <div>
          <div className="font-semibold">Texo</div>
          <div className="text-sm text-muted">Version {version || "…"}</div>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">License</dt>
        <dd>MIT</dd>
      </dl>
      {/* Every release keeps a visible way to support Texo (see support.test.ts). */}
      <div className="mt-4">
        <Button onClick={() => openDialog("support")}>
          <Heart size={14} className="fill-current text-accent" /> Support Texo
        </Button>
      </div>
    </>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<Section>("appearance");
  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="flex h-[min(60vh,480px)] gap-4">
        <nav aria-label="Settings sections" className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-border pr-3">
          {SECTIONS.map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-current={section === value ? "page" : undefined}
              onClick={() => setSection(value)}
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${
                section === value ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2/60 hover:text-text"
              }`}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-auto pr-1">
          {section === "appearance" && <AppearanceSection />}
          {section === "editor" && <EditorSection />}
          {section === "compile" && <CompileSection />}
          {section === "files" && <FilesSection />}
          {section === "projects" && <ProjectsSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
