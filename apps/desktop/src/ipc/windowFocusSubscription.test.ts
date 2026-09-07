import { describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./channels.ts";
import { subscribeWindowFocusState } from "./windowFocusSubscription.ts";

describe("subscribeWindowFocusState", () => {
  it.each([
    { initial: true, transitioned: false },
    { initial: false, transitioned: true },
  ])(
    "observes a $initial -> $transitioned transition during the initial snapshot",
    ({ initial, transitioned }) => {
      let focused = initial;
      let focusListener: ((event: unknown, focused: unknown) => void) | undefined;
      const listener = vi.fn();
      const ipcRenderer = {
        on: vi.fn((_channel: string, registered: typeof focusListener) => {
          focusListener = registered;
        }),
        removeListener: vi.fn(),
        sendSync: vi.fn(() => {
          expect(focusListener).toBeDefined();
          focused = transitioned;
          focusListener?.({}, focused);
          return focused;
        }),
      };

      const unsubscribe = subscribeWindowFocusState(
        ipcRenderer as unknown as Parameters<typeof subscribeWindowFocusState>[0],
        listener,
      );

      expect(ipcRenderer.on).toHaveBeenCalledWith(
        IpcChannels.WINDOW_FOCUS_STATE_CHANNEL,
        expect.any(Function),
      );
      expect(listener.mock.calls).toEqual([[transitioned], [transitioned]]);

      unsubscribe();
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
        IpcChannels.WINDOW_FOCUS_STATE_CHANNEL,
        focusListener,
      );
    },
  );
});
