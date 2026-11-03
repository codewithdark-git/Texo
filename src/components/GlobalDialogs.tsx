import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { useApp } from "../store";
import { useUi } from "../ui";
import { Button, Modal } from "./Dialog";
import { Logo } from "./Sidebar";

const REPO = "https://github.com/codewithdark-git/Texo";

const SHORTCUTS: [string, [string, string][]][] = [
  [
    "Project",
    [
      ["Ctrl+P", "Quick Open: jump to a file"],
      ["Ctrl+S", "Save (Texo also saves automatically)"],
      ["Ctrl+Enter", "Compile"],
      ["Ctrl+W", "Close the current tab"],
      ["Ctrl+Tab / Ctrl+Shift+Tab", "Next / previous tab"],
    ],
  ],
  [
    "Editor",
    [
      ["Ctrl+B / Ctrl+I", "Bold / italic"],
      ["Ctrl+/", "Comment or uncomment lines"],
      ["Ctrl+F / Ctrl+H", "Find / replace"],
      ["Alt+Z", "Toggle word wrap"],
      ["Ctrl+= / Ctrl+- / Ctrl+0", "Zoom in / out / reset"],
      ["F1", "All editor commands"],
    ],
  ],
  [
    "PDF",
    [
      ["Ctrl+Alt+J", "Show the cursor's position in the PDF"],
      ["Double-click", "Jump from the PDF to the source"],
      ["Ctrl+F", "Find in the PDF (when it has focus)"],
      ["Ctrl+mouse wheel", "Zoom the PDF"],
    ],
  ],
  [
    "Files",
    [
      ["F2", "Rename the selected file"],
      ["Delete", "Move the selected file to the Recycle Bin"],
      ["Ctrl+Shift+/", "This list"],
    ],
  ],
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="grid max-h-[65vh] gap-5 overflow-auto pr-1 sm:grid-cols-2">
        {SHORTCUTS.map(([group, rows]) => (
          <section key={group}>
            <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{group}</h3>
            <dl className="space-y-1.5 text-sm">
              {rows.map(([keys, what]) => (
                <div key={keys} className="flex items-baseline justify-between gap-3">
                  <dt className="text-text/90">{what}</dt>
                  <dd className="shrink-0">
                    <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
                      {keys}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("");
  const engine = useApp((s) => s.engine);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);
  const engineName = !engine
    ? "…"
    : engine.bundled
      ? "Built-in engine (Tectonic)"
      : engine.compiler === "tectonic"
        ? "Tectonic"
        : engine.distribution ?? "None found";

  return (
    <Modal title="About Texo" onClose={onClose}>
      <div className="flex items-center gap-3">
        <Logo size={44} />
        <div>
          <div className="text-base font-semibold">Texo</div>
          <div className="text-sm text-muted">Version {version || "…"}</div>
        </div>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        A desktop LaTeX editor with a live PDF preview. Your projects stay plain folders on your disk.
      </p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">LaTeX engine</dt>
        <dd>{engineName}</dd>
        <dt className="text-muted">License</dt>
        <dd>MIT</dd>
      </dl>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={() => void openUrl(`${REPO}/releases`)}>
          <ExternalLink size={14} /> Releases
        </Button>
        <Button onClick={() => void openUrl(`${REPO}/issues`)}>
          <ExternalLink size={14} /> Report a problem
        </Button>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

/** Dialogs any screen can open, plus their global shortcuts. (Quick Open
 * belongs to the workspace and is rendered there.) */
export function GlobalDialogs() {
  const dialog = useUi((s) => s.dialog);
  const openDialog = useUi((s) => s.openDialog);
  const close = () => openDialog(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "?" || e.code === "Slash")) {
        e.preventDefault();
        openDialog("shortcuts");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDialog]);

  if (dialog === "shortcuts") return <ShortcutsDialog onClose={close} />;
  if (dialog === "about") return <AboutDialog onClose={close} />;
  return null;
}
