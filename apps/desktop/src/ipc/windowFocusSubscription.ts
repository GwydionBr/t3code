import type { IpcRenderer, IpcRendererEvent } from "electron";

import * as IpcChannels from "./channels.ts";

type WindowFocusIpcRenderer = Pick<IpcRenderer, "on" | "removeListener" | "sendSync">;

/** Registers first, then synchronously delivers the initial focus snapshot. */
export function subscribeWindowFocusState(
  ipcRenderer: WindowFocusIpcRenderer,
  listener: (focused: boolean) => void,
): () => void {
  const wrappedListener = (_event: IpcRendererEvent, focused: unknown) => {
    if (typeof focused !== "boolean") return;
    listener(focused);
  };

  ipcRenderer.on(IpcChannels.WINDOW_FOCUS_STATE_CHANNEL, wrappedListener);
  listener(ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FOCUS_STATE_CHANNEL) === true);

  return () => {
    ipcRenderer.removeListener(IpcChannels.WINDOW_FOCUS_STATE_CHANNEL, wrappedListener);
  };
}
