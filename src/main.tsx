import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyMotion } from "./lib/motion";
import { applyTheme } from "./lib/theme";
import "./styles.css";

applyTheme();
applyMotion();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
