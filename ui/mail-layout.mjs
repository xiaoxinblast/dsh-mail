import { DEFAULT_SETTINGS } from "../src/settings.mjs";

export const DEFAULT_ASSISTANT_WIDTH = 390;

export function assistantPaneSizes(preferred, available) {
  const overlay = available <= 1000;
  const max = Math.max(0, Math.min(720, overlay ? available : available - 600));
  const min = Math.min(300, max);
  const width = Math.round(Math.max(min, Math.min(max, Number.isFinite(preferred) ? preferred : DEFAULT_ASSISTANT_WIDTH)));
  return { width, min, max, overlay };
}

export function mailPaneSizes(width, rootWidth, settings = DEFAULT_SETTINGS) {
  if (rootWidth < 760) return { folder: 0, list: width, reader: 0, handles: 0 };
  const handles = 6, folder = 0;
  const listMax = Math.min(720, width - folder - 300 - handles);
  const list = Math.max(260, Math.min(settings.mailListWidth ?? 340, listMax));
  return { folder, list, reader: width - list - handles, handles, listMax };
}
