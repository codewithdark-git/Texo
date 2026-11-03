import { lazy, Suspense, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dashboard } from "./components/Dashboard";
import { GlobalDialogs } from "./components/GlobalDialogs";
import { Toaster } from "./components/Toaster";
import { useApp } from "./store";

// The workspace pulls in Monaco (several MB); load it only when a project opens.
const Workspace = lazy(() => import("./workspace/Workspace").then((m) => ({ default: m.Workspace })));

export default function App() {
  const load = useApp((s) => s.load);
  const openProject = useApp((s) => s.openProject);

  useEffect(() => {
    void load();
  }, [load]);

  // The workspace sets a more specific title while a project is open.
  useEffect(() => {
    if (!openProject) void getCurrentWindow().setTitle("Texo").catch(() => {});
  }, [openProject]);

  return (
    <>
      {openProject ? (
        <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">Opening project…</div>}>
          <Workspace project={openProject} />
        </Suspense>
      ) : (
        <Dashboard />
      )}
      <GlobalDialogs />
      <Toaster />
    </>
  );
}
