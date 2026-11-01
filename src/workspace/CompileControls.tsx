import { Check, ChevronDown, Loader2, Play, Square } from "lucide-react";
import type { Compiler, Engine } from "../lib/api";
import { Menu, type MenuItem } from "../components/Menu";
import { useCompile } from "./compileStore";
import { useWorkspace } from "./store";

export const ENGINE_NAMES: Record<Engine, string> = {
  pdflatex: "pdfLaTeX",
  xelatex: "XeLaTeX",
  lualatex: "LuaLaTeX",
};

const COMPILER_NAMES: Record<Compiler, string> = {
  auto: "Automatic",
  latexmk: "latexmk",
  direct: "Engine directly",
  tectonic: "Tectonic",
};

/** The Compile button, its stop state, and the engine/compiler menu. */
export function CompileControls() {
  const c = useCompile();
  const engine = useWorkspace((s) => s.project?.engine ?? "pdflatex");
  const errors = c.result?.issues.filter((i) => i.severity === "error").length ?? 0;
  const tc = c.toolchains;

  const available: Record<Compiler, boolean> = {
    auto: true,
    latexmk: !!tc?.latexmk,
    direct: !!(tc?.pdflatex || tc?.xelatex || tc?.lualatex),
    tectonic: !!tc?.tectonic,
  };
  const engineAvailable: Record<Engine, boolean> = {
    pdflatex: !!tc?.pdflatex,
    xelatex: !!tc?.xelatex,
    lualatex: !!tc?.lualatex,
  };
  const tick = (on: boolean) => (on ? <Check size={15} /> : <span className="inline-block w-[15px]" />);

  const items: (MenuItem | "divider")[] = [
    ...(Object.keys(ENGINE_NAMES) as Engine[]).map((e) => ({
      label: ENGINE_NAMES[e],
      hint: engineAvailable[e] || c.compiler === "tectonic" ? undefined : "not installed",
      icon: tick(engine === e),
      onSelect: () => void c.setEngine(e),
    })),
    "divider",
    ...(Object.keys(COMPILER_NAMES) as Compiler[]).map((k) => ({
      label: COMPILER_NAMES[k],
      hint: available[k] ? undefined : "not installed",
      icon: tick(c.compiler === k),
      onSelect: () => void c.setCompiler(k),
    })),
    "divider",
    {
      label: "Compile automatically",
      hint: "after each save",
      icon: tick(c.auto),
      onSelect: () => c.setAuto(!c.auto),
    },
  ];

  return (
    <div className="flex items-center">
      {c.compiling ? (
        <button
          type="button"
          onClick={() => void c.abort()}
          title="Stop compiling"
          className="inline-flex h-8 items-center gap-2 rounded-l-lg border border-border bg-surface-2 px-3 text-sm hover:brightness-110"
        >
          <Loader2 size={15} className="animate-spin" />
          Compiling
          <Square size={11} className="fill-current text-muted" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void c.compile()}
          title="Compile (Ctrl+Enter)"
          className="relative inline-flex h-8 items-center gap-2 rounded-l-lg bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent-strong"
        >
          <Play size={14} className="fill-current" />
          Compile
          {errors > 0 && (
            <span className="ml-0.5 rounded-full bg-danger px-1.5 text-[11px] leading-4 text-white" title={`${errors} errors`}>
              {errors}
            </span>
          )}
        </button>
      )}
      <Menu
        trigger={({ toggle }) => (
          <button
            type="button"
            aria-label="Compile settings"
            title={`${ENGINE_NAMES[engine]} · ${COMPILER_NAMES[c.compiler]}`}
            onClick={toggle}
            className={`inline-flex h-8 items-center rounded-r-lg border-l px-1.5 ${
              c.compiling
                ? "border border-l-0 border-border bg-surface-2 text-muted"
                : "border-accent-ink/20 bg-accent text-accent-ink hover:bg-accent-strong"
            }`}
          >
            <ChevronDown size={15} />
          </button>
        )}
        items={items}
      />
    </div>
  );
}
