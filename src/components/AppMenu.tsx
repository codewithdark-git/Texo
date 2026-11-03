import { useEffect, useState } from "react";
import { Info, Keyboard, Monitor, Moon, Settings2, Sun } from "lucide-react";
import { getThemePref, onThemeChange, setThemePref, type ThemePref } from "../lib/theme";
import { useUi } from "../ui";
import { Menu, type MenuItem } from "./Menu";

const THEMES: [ThemePref, string, typeof Sun][] = [
  ["system", "Match system", Monitor],
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
];

/** The gear menu: theme, keyboard shortcuts, and About. */
export function AppMenu({ align = "right" }: { align?: "left" | "right" }) {
  const [pref, setPref] = useState(getThemePref);
  const openDialog = useUi((s) => s.openDialog);
  useEffect(() => onThemeChange(() => setPref(getThemePref())), []);

  const items: (MenuItem | "divider")[] = [
    ...THEMES.map(([value, label, Icon]) => ({
      label,
      icon: <Icon size={15} />,
      hint: pref === value ? "✓" : undefined,
      onSelect: () => setThemePref(value),
    })),
    "divider",
    {
      label: "Keyboard shortcuts",
      icon: <Keyboard size={15} />,
      hint: "Ctrl+Shift+/",
      onSelect: () => openDialog("shortcuts"),
    },
    { label: "About Texo", icon: <Info size={15} />, onSelect: () => openDialog("about") },
  ];

  return (
    <Menu
      align={align}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-label="Settings and help"
          title="Settings and help"
          onClick={toggle}
          className={`rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-text ${open ? "bg-surface-2 text-text" : ""}`}
        >
          <Settings2 size={16} />
        </button>
      )}
      items={items}
    />
  );
}
