import { lazy, Suspense, useEffect } from "react";
import { Dashboard } from "./components/Dashboard";
import { useApp } from "./store";

// The workspace pulls in Monaco (several MB); load it only when a project opens.
const Workspace = lazy(() => import("./workspace/Workspace").then((m) => ({ default: m.Workspace })));

export default function App() {
  const load = useApp((s) => s.load);
  const openProject = useApp((s) => s.openProject);

  useEffect(() => {
    void load();
  }, [load]);

  if (!openProject) return <Dashboard />;
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">Opening project…</div>}>
      <Workspace project={openProject} />
    </Suspense>
  );
}
