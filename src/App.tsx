import { useEffect } from "react";
import { Dashboard } from "./components/Dashboard";
import { ProjectView } from "./components/ProjectView";
import { useApp } from "./store";

export default function App() {
  const load = useApp((s) => s.load);
  const openProject = useApp((s) => s.openProject);

  useEffect(() => {
    void load();
  }, [load]);

  return openProject ? <ProjectView project={openProject} /> : <Dashboard />;
}
