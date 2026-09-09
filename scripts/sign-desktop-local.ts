// Builds the T3 Code desktop DMG, signs the bundled .app locally with your
// own Apple signing certificate, and repacks a signed DMG you can just open
// and drag to Applications. The point is a *stable* code-signing identity so
// macOS keeps notification permission for the app and lists "T3 Code" under
// System Settings -> Notifications instead of forgetting it on every rebuild.
//
// This is a local-only convenience: it deliberately does NOT enable the
// hardened runtime and does NOT notarize, so the result is not distributable.
// The release pipeline (T3CODE_DESKTOP_SIGNED=1 in build-desktop-artifact.ts)
// owns hardened-runtime + notarized builds for distribution.
//
// Usage:
//   node scripts/sign-desktop-local.ts                       # arm64, auto identity
//   node scripts/sign-desktop-local.ts --arch x64            # Intel
//   node scripts/sign-desktop-local.ts --skip-build          # reuse newest DMG in release/
//   node scripts/sign-desktop-local.ts --identity "Apple Development: Name (TEAMID)"

import { sign } from "@electron/osx-sign";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

class SignDesktopError extends Schema.TaggedError<SignDesktopError>()("SignDesktopError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const collectStream = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

// Runs a subprocess to completion, returning its captured stdout. Streams
// stdout/stderr through to the terminal when `inherit` is set (used for the
// long build and the signature verification so their progress is visible).
const runCommand = Effect.fn("runCommand")(function* (
  command: ChildProcess.Command,
  options: { readonly label: string; readonly inherit?: boolean },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStream(child.stdout).pipe(
        Effect.tap((text) => (options.inherit ? Console.log(text.trimEnd()) : Effect.void)),
      ),
      collectStream(child.stderr).pipe(
        Effect.tap((text) => (options.inherit ? Console.error(text.trimEnd()) : Effect.void)),
      ),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* new SignDesktopError({
      detail: `${options.label} failed (exit ${exitCode})${stderr.trim() ? `:\n${stderr.trim()}` : ""}`,
    });
  }
  return stdout;
});

// Prefer a "Developer ID Application" cert, fall back to "Apple Development" —
// both give a stable identity; the latter only validates on this machine.
const resolveIdentity = Effect.fn("resolveIdentity")(function* () {
  const output = yield* runCommand(
    ChildProcess.make("security", ["find-identity", "-v", "-p", "codesigning"]),
    { label: "security find-identity" },
  ).pipe(Effect.orElseSucceed(() => ""));
  const names = [...output.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
  const identity =
    names.find((name) => name.startsWith("Developer ID Application")) ??
    names.find((name) => name.startsWith("Apple Development")) ??
    names[0];
  if (!identity) {
    return yield* new SignDesktopError({
      detail: [
        "No code-signing certificate found in your keychain.",
        "",
        "Create one once (needs an Apple Developer account):",
        "  Xcode -> Settings -> Accounts -> add your Apple account",
        '    -> "Manage Certificates..." -> "+" -> "Apple Development"',
        "",
        "Then verify with:  security find-identity -v -p codesigning",
        'Or pass it directly: --identity "Apple Development: Your Name (TEAMID)"',
      ].join("\n"),
    });
  }
  return identity;
});

const newestDmg = Effect.fn("newestDmg")(function* (releaseDir: string, arch: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(releaseDir))) {
    return yield* new SignDesktopError({ detail: `No release directory at ${releaseDir}.` });
  }
  const suffix = `-${arch}.dmg`;
  const candidates = (yield* fs.readDirectory(releaseDir)).filter(
    (name) => name.startsWith("T3-Code-") && name.endsWith(suffix),
  );
  const withMtime = yield* Effect.forEach(candidates, (name) => {
    const full = path.join(releaseDir, name);
    return fs.stat(full).pipe(
      Effect.map((info) => ({
        full,
        mtime: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
      })),
    );
  });
  const newest = withMtime.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) {
    return yield* new SignDesktopError({
      detail: `No DMG matching release/T3-Code-*-${arch}.dmg. Build first or drop --skip-build.`,
    });
  }
  return newest.full;
});

// electron-builder mounts the DMG while applying its Finder layout, and that
// volume can linger half-detached after the build. Attaching again then reads
// the stale device and every file copy fails with "Unknown error: 1000", so
// force-detach any existing attachment of this exact image first.
const detachExistingMounts = Effect.fn("detachExistingMounts")(function* (dmg: string) {
  const info = yield* runCommand(ChildProcess.make("hdiutil", ["info"]), {
    label: "hdiutil info",
  }).pipe(Effect.orElseSucceed(() => ""));
  for (const block of info.split(/^=+$/m)) {
    if (!block.includes(dmg)) continue;
    const device = block.match(/\/dev\/disk\d+\b/)?.[0];
    if (device) {
      yield* runCommand(ChildProcess.make("hdiutil", ["detach", device, "-force"]), {
        label: "hdiutil detach (stale)",
      }).pipe(Effect.ignore);
    }
  }
});

// Attach at an explicit private mountpoint so we never collide with (or read)
// a shared `/Volumes/...` mount left behind by another process.
const mountDmg = Effect.fn("mountDmg")(function* (dmg: string, mountPoint: string) {
  yield* detachExistingMounts(dmg);
  yield* runCommand(
    ChildProcess.make("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountPoint,
      dmg,
    ]),
    { label: "hdiutil attach" },
  );
  return mountPoint;
});

const signDesktopLocal = Effect.fn("signDesktopLocal")(function* (input: {
  readonly arch: "arm64" | "x64";
  readonly skipBuild: boolean;
  readonly identity: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const releaseDir = path.join(repoRoot, "release");

  const identity = input.identity ?? (yield* resolveIdentity());
  yield* Console.log(`[sign-local] Signing identity: ${identity}`);

  if (input.skipBuild) {
    yield* Console.log("[sign-local] --skip-build -> reusing the newest DMG in release/.");
  } else {
    yield* Console.log(`[sign-local] Building desktop DMG (${input.arch})...`);
    yield* runCommand(
      ChildProcess.make("pnpm", ["run", `dist:desktop:dmg:${input.arch}`], { cwd: repoRoot }),
      { label: "pnpm run dist:desktop:dmg", inherit: true },
    );
  }

  const srcDmg = yield* newestDmg(releaseDir, input.arch);
  yield* Console.log(`[sign-local] Source DMG: ${srcDmg}`);

  const stage = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sign-" });
  const mountDir = path.join(stage, "mnt");
  // The output DMG is packed from `payload/` only, so the mount lives outside it.
  const payloadDir = path.join(stage, "payload");
  yield* fs.makeDirectory(mountDir, { recursive: true });
  yield* fs.makeDirectory(payloadDir, { recursive: true });

  // Mount only for the extraction, then detach immediately: holding the volume
  // until program exit races the temp-dir cleanup (EBUSY on the mountpoint).
  // acquireUseRelease still guarantees the detach if extraction throws.
  const appName = yield* Effect.acquireUseRelease(
    mountDmg(srcDmg, mountDir),
    (mountPoint) =>
      Effect.gen(function* () {
        const app = (yield* fs.readDirectory(mountPoint)).find((name) => name.endsWith(".app"));
        if (!app) {
          return yield* new SignDesktopError({ detail: "No .app found in the DMG." });
        }
        yield* Console.log(`[sign-local] Extracting ${app}...`);
        yield* runCommand(
          ChildProcess.make("ditto", [path.join(mountPoint, app), path.join(payloadDir, app)]),
          { label: "ditto" },
        );
        return app;
      }),
    (mountPoint) =>
      runCommand(ChildProcess.make("hdiutil", ["detach", mountPoint, "-force", "-quiet"]), {
        label: "hdiutil detach",
      }).pipe(Effect.ignore),
  );
  const stagedApp = path.join(payloadDir, appName);

  // @electron/osx-sign signs inside-out (frameworks and helper apps first,
  // outer bundle last), which a single `codesign --deep` cannot do reliably
  // for an Electron bundle. Hardened runtime stays off: without notarization
  // it only adds ways for the local launch to break, and it is not needed for
  // a stable notification identity.
  yield* Console.log("[sign-local] Signing app (inside-out, no hardened runtime)...");
  yield* Effect.tryPromise({
    try: () =>
      sign({
        app: stagedApp,
        identity,
        platform: "darwin",
        type: "development",
        optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
      }),
    catch: (cause) => new SignDesktopError({ detail: `Signing failed: ${String(cause)}` }),
  });
  yield* runCommand(ChildProcess.make("codesign", ["--verify", "--verbose=2", stagedApp]), {
    label: "codesign --verify",
    inherit: true,
  });
  yield* Console.log("[sign-local] Signature ok.");

  yield* runCommand(
    ChildProcess.make("ln", ["-s", "/Applications", path.join(payloadDir, "Applications")]),
    { label: "ln -s /Applications" },
  );
  const outDmg = path.join(releaseDir, `${path.basename(srcDmg, ".dmg")}-signed.dmg`);
  yield* fs.remove(outDmg, { force: true });
  yield* Console.log("[sign-local] Packing signed DMG...");
  yield* runCommand(
    ChildProcess.make("hdiutil", [
      "create",
      "-volname",
      path.basename(appName, ".app"),
      "-srcfolder",
      payloadDir,
      "-ov",
      "-format",
      "UDZO",
      outDmg,
    ]),
    { label: "hdiutil create" },
  );

  yield* Console.log(`[sign-local] Done. Signed DMG: ${outDmg}`);
  yield* Console.log(
    '[sign-local] Open it, drag the app to "Applications", launch it. macOS may prompt once ' +
      'for notification permission; "T3 Code" then stays listed under System Settings -> Notifications.',
  );
});

const signDesktopLocalCli = Command.make("sign-desktop-local", {
  arch: Flag.choice("arch", ["arm64", "x64"]).pipe(
    Flag.withDescription("Target architecture (arm64 or x64)."),
    Flag.withDefault("arm64" as const),
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription("Reuse the newest DMG in release/ instead of rebuilding."),
    Flag.withDefault(false),
  ),
  identity: Flag.string("identity").pipe(
    Flag.withDescription("Signing identity name; auto-discovered from the keychain when omitted."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Locally sign the T3 Code desktop DMG for a stable notification identity.",
  ),
  Command.withHandler((input) =>
    signDesktopLocal({
      arch: input.arch,
      skipBuild: input.skipBuild,
      identity: Option.getOrUndefined(input.identity),
    }),
  ),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(signDesktopLocalCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
