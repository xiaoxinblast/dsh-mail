import { DEFAULT_SETTINGS } from "../src/settings.mjs";

export function mailPaneSizes(width, rootWidth, settings = DEFAULT_SETTINGS) {
  if (rootWidth < 760) return { folder: 0, list: width, reader: 0, handles: 0 };
  const handles = rootWidth >= 1100 ? 12 : 6;
  const folderMax = Math.min(480, width - 260 - 300 - handles);
  const folder = rootWidth >= 1100 ? Math.max(180, Math.min(settings.mailFolderWidth ?? 240, folderMax)) : 0;
  const listMax = Math.min(720, width - folder - 300 - handles);
  const list = Math.max(260, Math.min(settings.mailListWidth ?? 340, listMax));
  return { folder, list, reader: width - folder - list - handles, handles, folderMax, listMax };
}
