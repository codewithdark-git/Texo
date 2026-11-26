// The "Install <package>" button on a compile hint that carries a
// `[fix:install-package:<name>]` marker (a missing .sty/.cls, or cm-super for
// microtype's font expansion). It asks first, streams the package manager's
// output while it runs, and compiles again when the install worked.
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, Download, Loader2, XCircle } from "lucide-react";
import { Button, ConfirmDialog } from "../components/Dialog";
import { installTexPackage, isValidPackageName, TEX_PACKAGE_OUTPUT_EVENT, type TexPackageOutput } from "../lib/texpkgApi";
import { toast } from "../ui";
import { useCompile } from "./compileStore";

type Phase = { kind: "idle" } | { kind: "confirm" } | { kind: "running" } | { kind: "done"; ok: boolean; message: string };

const MAX_LINES = 200;

function managerName(distribution: string | null | undefined): string {
  if (distribution === "MiKTeX") return "MiKTeX";
  if (distribution === "TeX Live") return "TeX Live";
  return "your TeX distribution";
}

export function InstallPackageFix({ pkg }: { pkg: string }) {
  const distribution = useCompile((s) => s.toolchains?.distribution);
  const compiling = useCompile((s) => s.compiling);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [lines, setLines] = useState<string[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!isValidPackageName(pkg)) return null;
  const manager = managerName(distribution);

  async function run() {
    setPhase({ kind: "running" });
    setLines([]);
    const unlisten = await listen<TexPackageOutput>(TEX_PACKAGE_OUTPUT_EVENT, (e) => {
      if (e.payload.package !== pkg || !mounted.current) return;
      setLines((prev) => [...prev, ...e.payload.lines].slice(-MAX_LINES));
    });
    try {
      const outcome = await installTexPackage(pkg);
      if (!mounted.current) return;
      setPhase({ kind: "done", ok: outcome.ok, message: outcome.message });
      if (outcome.output) setLines(outcome.output.split("\n").slice(-MAX_LINES));
      if (outcome.ok) {
        toast(`Installed ${pkg}. Compiling again…`, "success");
        void useCompile.getState().compile();
      } else {
        setShowOutput(true);
      }
    } catch (err) {
      if (mounted.current) setPhase({ kind: "done", ok: false, message: String(err) });
    } finally {
      unlisten();
    }
  }

  return (
    <div className="mt-2">
      {phase.kind === "idle" || phase.kind === "confirm" || (phase.kind === "done" && !phase.ok) ? (
        <Button disabled={compiling} onClick={() => setPhase({ kind: "confirm" })}>
          <Download size={14} /> {phase.kind === "done" ? `Try installing ${pkg} again` : `Install ${pkg}…`}
        </Button>
      ) : phase.kind === "running" ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <Loader2 size={13} className="animate-spin" /> Installing {pkg} with {manager}… this can take a few minutes.
        </span>
      ) : null}

      {phase.kind === "done" && (
        <p className={`mt-2 flex gap-1.5 text-xs ${phase.ok ? "text-text" : "text-danger"}`}>
          {phase.ok ? <CheckCircle2 size={14} className="mt-px shrink-0 text-accent" /> : <XCircle size={14} className="mt-px shrink-0" />}
          <span>{phase.message}</span>
        </p>
      )}

      {lines.length > 0 && (
        <div className="mt-1.5">
          {phase.kind !== "running" && (
            <button type="button" className="text-xs text-muted underline hover:text-text" onClick={() => setShowOutput((v) => !v)}>
              {showOutput ? "Hide details" : "Show details"}
            </button>
          )}
          {(phase.kind === "running" || showOutput) && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-muted select-text">
              {lines.join("\n")}
            </pre>
          )}
        </div>
      )}

      {phase.kind === "confirm" && (
        <ConfirmDialog
          title={`Install ${pkg}?`}
          message={
            <>
              Texo will ask {manager} to download and install the package <span className="font-mono">{pkg}</span>. This
              needs an internet connection and may take a few minutes. It changes your TeX installation, not your project.
              When it's done, Texo compiles again.
            </>
          }
          confirmLabel={`Install ${pkg}`}
          onConfirm={() => void run()}
          onClose={() => setPhase({ kind: "idle" })}
        />
      )}
    </div>
  );
}
