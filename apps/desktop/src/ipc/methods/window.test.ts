import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect, vi } from "vite-plus/test";

import type * as Electron from "electron";

const { notificationListeners, notificationShow } = vi.hoisted(() => ({
  notificationListeners: new Map<string, () => void>(),
  notificationShow: vi.fn(),
}));

vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true;
    }

    on(event: string, listener: () => void) {
      notificationListeners.set(event, listener);
    }

    show() {
      notificationShow();
    }
  },
}));

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import {
  getLocalEnvironmentBootstraps,
  getWindowFullscreenState,
  pickProjectFavicon,
  showNotification,
} from "./window.ts";

const readyWslConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "wsl.exe",
  args: ["-d", "Ubuntu", "--", "node", "/app/bin.mjs"],
  entryPath: "/app/bin.mjs",
  cwd: "/app",
  env: {},
  extendEnv: false,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3774,
    host: "0.0.0.0",
    desktopBootstrapToken: "bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "stdin",
  httpBaseUrl: new URL("http://127.0.0.1:3774"),
  captureOutput: true,
  preflightFailure: Option.none(),
  runningDistro: "Ubuntu",
};

const defaultWslInstance: DesktopBackendManager.DesktopBackendInstance = {
  id: DesktopBackendManager.BackendInstanceId("wsl:default"),
  label: Effect.succeed("WSL (default distro)"),
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(readyWslConfig)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(123),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
};

describe("getLocalEnvironmentBootstraps", () => {
  it.effect("publishes the concrete running distro without replacing the stable instance id", () =>
    Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();

      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (Ubuntu)",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3774/",
          wsBaseUrl: "ws://127.0.0.1:3774/",
          bootstrapToken: "bootstrap-token",
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([defaultWslInstance]))),
  );

  it.effect("publishes a pending bootstrap only while a transient retry is scheduled", () => {
    const retryingConfig: DesktopBackendManager.DesktopBackendStartConfig = {
      ...readyWslConfig,
      preflightFailure: Option.some({
        reason: "WSL probe timed out",
        fatal: false,
        retryLimit: 12,
      }),
    };
    const retryingInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(Option.some(retryingConfig)),
      snapshot: Effect.succeed({
        desiredRunning: true,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 2,
        restartScheduled: true,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, [
        {
          id: "wsl:default",
          label: "WSL (default distro)",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
        },
      ]);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([retryingInstance])));
  });

  it.effect("omits a bounded transient bootstrap after retries stop", () => {
    const stoppedInstance: DesktopBackendManager.DesktopBackendInstance = {
      ...defaultWslInstance,
      currentConfig: Effect.succeed(
        Option.some({
          ...readyWslConfig,
          preflightFailure: Option.some({
            reason: "WSL probe timed out",
            fatal: false,
            retryLimit: 12,
          }),
        }),
      ),
      snapshot: Effect.succeed({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 12,
        restartScheduled: false,
      }),
    };

    return Effect.gen(function* () {
      const result = yield* getLocalEnvironmentBootstraps.handler();
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(DesktopBackendPool.layerTest([stoppedInstance])));
  });
});

describe("getWindowFullscreenState", () => {
  it.effect("reads the current native window state", () => {
    const window = { isFullScreen: () => true } as Electron.BrowserWindow;

    return Effect.gen(function* () {
      assert.isTrue(yield* getWindowFullscreenState.handler());
    }).pipe(
      Effect.provide(
        Layer.mock(ElectronWindow.ElectronWindow)({
          currentMainOrFirst: Effect.succeed(Option.some(window)),
        }),
      ),
    );
  });
});

describe("showNotification", () => {
  it.effect(
    "resolves the main window on click and waits for its renderer before navigating",
    () => {
      const send = vi.fn();
      const staleSend = vi.fn();
      const staleWindow = {
        isDestroyed: () => false,
        isMinimized: () => false,
        show: vi.fn(),
        focus: vi.fn(),
        webContents: { send: staleSend },
      } as unknown as Electron.BrowserWindow;
      let finishLoading: (() => void) | undefined;
      const window = {
        isDestroyed: () => false,
        webContents: {
          isLoadingMainFrame: () => true,
          once: (event: string, listener: () => void) => {
            assert.strictEqual(event, "did-finish-load");
            finishLoading = listener;
          },
          send,
        },
      } as unknown as Electron.BrowserWindow;
      const revealOrCreateMain = vi.fn(() => Effect.succeed(window));

      return Effect.gen(function* () {
        yield* showNotification.handler({
          title: "Done",
          body: "The agent finished",
          environmentId: "local",
          threadId: "thread-1",
        });

        notificationListeners.get("click")?.();
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(revealOrCreateMain).toHaveBeenCalledOnce()),
        );
        assert.isUndefined(send.mock.lastCall);
        assert.isUndefined(staleSend.mock.lastCall);

        finishLoading?.();
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(send).toHaveBeenCalledWith("desktop:navigate-to-thread", {
              environmentId: "local",
              threadId: "thread-1",
            }),
          ),
        );
        expect(revealOrCreateMain).toHaveBeenCalledTimes(2);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronWindow.ElectronWindow)({
              currentMainOrFirst: Effect.succeed(Option.some(staleWindow)),
            }),
            Layer.mock(DesktopWindow.DesktopWindow)({
              revealOrCreateMain: Effect.suspend(revealOrCreateMain),
            }),
          ),
        ),
      );
    },
  );
});

describe("pickProjectFavicon", () => {
  it.effect("opens a single-image picker from the project directory", () =>
    Effect.gen(function* () {
      const pickFiles = vi.fn(() => Effect.succeed(["/pictures/icon.png"]));
      const result = yield* pickProjectFavicon.handler("/project").pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
            Layer.mock(ElectronWindow.ElectronWindow)({
              focusedMainOrFirst: Effect.succeed(Option.none()),
            }),
          ),
        ),
      );

      assert.strictEqual(result, "/pictures/icon.png");
      assert.deepEqual(pickFiles.mock.calls, [
        [
          {
            owner: Option.none(),
            defaultPath: Option.some("/project"),
            multiple: false,
            filters: [
              {
                name: "Images",
                extensions: ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"],
              },
            ],
          },
        ],
      ]);
    }),
  );
});
