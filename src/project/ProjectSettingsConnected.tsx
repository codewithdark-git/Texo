// The Project settings dialog's data: reads the workspace, compile, history
// and AI stores and the backend, and hands `ProjectSettingsView` a model.
// Loaded only when the dialog opens (see ProjectSettingsDialog.tsx). Every
// change goes through the stores' own actions. Most show their own toasts;
// the compile store's `setEngine` only records its error, so a failed engine
// change is toasted here.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../lib/api";
import { memoryApi, profilesApi } from "../lib/agentsApi";
import { libraryApi, type LibraryStatus } from "../lib/libraryApi";
import { useAiSettings } from "../ai/aiPrefs";
import { memorySizeText, memoryUsage } from "../ai/settings/agentSettingsLogic";
import { useHistory } from "../history/historyStore";
import { toast, useUi } from "../ui";
import { useCompile } from "../workspace/compileStore";
import { useWorkspace } from "../workspace/store";
import { ProjectSettingsView, type ProjectSettingsModel } from "./ProjectSettingsDialog";
import {
  AI_SETTINGS_PAGE_KEY,
  bibScanSummary,
  linkedBibFiles,
  mainDocCandidates,
  texFilesToScan,
  type AiSettingsPage,
} from "./projectSettingsLogic";

/** Reads the `.tex` files once each (by path and size) and keeps their text for this dialog. */
function useTexContents(project: string) {
  const files = useWorkspace((s) => s.files);
  const [contents, setContents] = useState<Record<string, string> | null>(null);
  const cache = useRef(new Map<string, { size: number; text: string | null }>());
  const toScan = useMemo(() => texFilesToScan(files), [files]);

  useEffect(() => {
    let live = true;
    const sizes = new Map(files.map((f) => [f.path, f.size]));
    void (async () => {
      const read = cache.current;
      const missing = toScan.filter((p) => read.get(p)?.size !== sizes.get(p));
      // A few at a time, so a large project doesn't flood the backend.
      for (let i = 0; i < missing.length; i += 8) {
        await Promise.all(
          missing.slice(i, i + 8).map(async (p) => {
            try {
              const c = await api.readFile(project, p);
              read.set(p, { size: sizes.get(p) ?? 0, text: c.kind === "text" ? c.content : null });
            } catch {
              read.set(p, { size: sizes.get(p) ?? 0, text: null });
            }
          }),
        );
        if (!live) return;
      }
      if (!live) return;
      const out: Record<string, string> = {};
      for (const p of toScan) {
        const text = read.get(p)?.text;
        if (typeof text === "string") out[p] = text;
      }
      setContents(out);
    })();
    return () => {
      live = false;
    };
  }, [project, files, toScan]);

  return { files, contents };
}

export default function ProjectSettingsConnected({ project, onClose }: { project: string; onClose: () => void }) {
  const summary = useWorkspace((s) => s.project);
  const { files, contents } = useTexContents(project);
  const history = useHistory((s) => (s.project === project ? s.status : null));
  const historyError = useHistory((s) => (s.project === project ? s.error : null));
  const aiEnabled = useAiSettings((s) => s.settings.enabled);

  const [library, setLibrary] = useState<LibraryStatus | null | "error">(null);
  const [rescanning, setRescanning] = useState(false);
  const [scan, setScan] = useState<{ files: string[]; text: string } | null>(null);
  const [memorySize, setMemorySize] = useState<string | null>(null);
  const [projectProfiles, setProjectProfiles] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void useHistory.getState().refreshStatus();
    void useAiSettings.getState().load();
    libraryApi.status().then(
      (s) => live && setLibrary(s),
      () => live && setLibrary("error"),
    );
    memoryApi.get(project).then(
      (m) => live && setMemorySize(memorySizeText(memoryUsage(m.bytes, m.maxBytes))),
      () => {},
    );
    profilesApi.list(project).then(
      (v) => live && setProjectProfiles(v.profiles.filter((p) => p.source === "project").length),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [project]);

  const mainDocument = summary?.mainDocument ?? null;
  const mainCandidates = useMemo(() => (contents ? mainDocCandidates(files, contents) : null), [files, contents]);
  const bibFiles = useMemo(() => {
    if (scan) return scan.files;
    if (!contents) return null;
    return linkedBibFiles(files, mainDocument, mainDocument ? (contents[mainDocument] ?? null) : null);
  }, [scan, contents, files, mainDocument]);

  const model: ProjectSettingsModel = {
    name: summary?.name ?? "",
    path: summary?.path ?? project,
    external: summary?.external ?? false,
    mainDocument,
    mainCandidates,
    setMainDocument: (path) => {
      if (path !== mainDocument) void useWorkspace.getState().setMainDocument(path);
    },
    engine: summary?.engine ?? "pdflatex",
    setEngine: (engine) => {
      if (engine === summary?.engine) return;
      void useCompile
        .getState()
        .setEngine(engine)
        .then(() => {
          // On failure the store keeps the old engine and only sets `error`.
          if (useWorkspace.getState().project?.engine !== engine) {
            toast(useCompile.getState().error ?? "Couldn't change the engine.", "error");
          }
        });
    },
    history,
    historyError,
    setHistoryEnabled: (on) => void useHistory.getState().setEnabled(on),
    keepHistoryOutOfGit: () => void useHistory.getState().answerGitExclude(true),
    bibFiles,
    library,
    rescanning,
    lastScan: scan?.text ?? null,
    rescan: () => {
      if (rescanning) return;
      setRescanning(true);
      libraryApi.syncBib(project).then(
        (r) => {
          setScan({ files: r.files, text: bibScanSummary(r) });
          setRescanning(false);
        },
        (err) => {
          setRescanning(false);
          toast(errorText(err), "error");
        },
      );
    },
    aiEnabled,
    memorySize,
    projectProfiles,
    openSettings: (section, aiPage?: AiSettingsPage) => {
      if (aiPage) {
        try {
          localStorage.setItem(AI_SETTINGS_PAGE_KEY, aiPage);
        } catch {
          // Settings opens on its last page instead.
        }
      }
      onClose();
      useUi.getState().openSettings(section);
    },
  };

  return <ProjectSettingsView model={model} onClose={onClose} />;
}
