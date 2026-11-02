import { DEFAULT_SETTINGS } from "../src/settings.mjs";

export function mailPaneSizes(width, rootWidth, settings = DEFAULT_SETTINGS) {
  if (rootWidth < 760) return { folder: 0, list: width, reader: 0, handles: 0 };
  const handles = 6, folder = 0;
  const listMax = Math.min(720, width - folder - 300 - handles);
  const list = Math.max(260, Math.min(settings.mailListWidth ?? 340, listMax));
  return { folder, list, reader: width - list - handles, handles, listMax };
}
