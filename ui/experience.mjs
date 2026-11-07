import { ACCENTS } from "../src/settings.mjs";
export function experienceStyle(settings) {
  const theme = settings.theme === "dark" ? { "--dsw-alias-bg-layer-1": "#151b28", "--dsw-alias-bg-layer-2": "#1e2738", "--dsw-alias-border-l2": "#354158", "--dsw-alias-label-primary": "#e9eef8", "--dsw-alias-label-secondary": "#a8b5cd", colorScheme: "dark" } : settings.theme === "light" ? { "--dsw-alias-bg-layer-1": "#ffffff", "--dsw-alias-bg-layer-2": "#f4f6fb", "--dsw-alias-border-l2": "#dce3ef", "--dsw-alias-label-primary": "#202c43", "--dsw-alias-label-secondary": "#5b6a83", colorScheme: "light" } : {};
  if (settings.theme === "dark" || settings.theme === "light") {
    const dark = settings.theme === "dark", base = theme["--dsw-alias-bg-layer-1"], surface = theme["--dsw-alias-bg-layer-2"], text = theme["--dsw-alias-label-primary"], muted = theme["--dsw-alias-label-secondary"], border = theme["--dsw-alias-border-l2"];
    Object.assign(theme, {
      "--dsw-alias-bg-base": base, "--dsw-alias-bg-module-platform": base, "--dsw-alias-bg-overlay": surface,
      "--dsw-specific-input-major": surface, "--dsw-specific-bubble": dark ? "#24324b" : "#edf2ff", "--dsw-specific-bubble-highlight": dark ? "#35486a" : "#dce7ff", "--dsw-specific-menu": surface, "--dsw-specific-selector": surface,
      "--dsw-alias-border-l1": border, "--dsw-alias-border-l3": border, "--dsw-alias-border-l4": border,
      "--dsw-alias-label-primary-bluish": text, "--dsw-alias-label-primary-dimmed": text, "--dsw-alias-label-tertiary": muted, "--dsw-alias-label-caption": muted, "--dsw-alias-label-dimmed": dark ? "#7888a2" : "#8a96ab",
      "--dsw-alias-interactive-bg-hover": dark ? "#ffffff0d" : "#17212b0a", "--dsw-alias-interactive-bg-hover-solid": surface, "--dsw-alias-state-business-tertiary": dark ? "#24324b" : "#edf2ff"
    });
  }
  return { ...theme, "--dm-brand": ACCENTS[settings.accent] || ACCENTS.blue, "--dm-ui-size": `${({ small: 12, standard: 14, large: 16 })[settings.interfaceSize] || 14}px`, "--dm-reading-size": `${settings.readingSize || 14}px`, "--dm-row-space": `${({ compact: 9, standard: 14, comfortable: 20 })[settings.density] || 14}px` };
}
