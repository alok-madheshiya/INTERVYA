// Flips Electron's build-time fuses on the packaged binary.
//
// This is the part of "nobody can tamper with it" that is actually real. Be
// clear about what it does and does not buy, because the difference matters:
//
//   It stops:  running the shipped electron.exe as a bare Node runtime,
//              injecting code through NODE_OPTIONS, attaching a debugger with
//              --inspect, dropping a loose `app/` folder next to app.asar to
//              shadow the real one, and starting at all from an app.asar whose
//              contents were edited.
//
//   It does not stop: reading the source. app.asar is an archive, not a safe —
//              `npx asar extract` opens it, and integrity validation only
//              refuses to *run* a modified one. Someone determined enough to
//              flip these bytes back can. Nothing available to an Electron app
//              changes that, and claiming otherwise would be a lie told to
//              whoever maintains this next.
//
// Ordering note: electron-builder calls this hook (info.afterPack) before the
// framework's own afterPack, which is what writes the asar integrity hashes
// into the executable. So the fuses are flipped first and the hashes are
// computed over the final binary — the right way round. If that order ever
// changes, EnableEmbeddedAsarIntegrityValidation is the first thing to suspect.
const path = require("node:path");

exports.default = async function afterPack(context) {
  // Loaded lazily: @electron/fuses is ESM-only in current versions, and this
  // file has to stay CommonJS for electron-builder to require() it.
  const { flipFuses, FuseVersion, FuseV1Options } = await import("@electron/fuses");

  const { productFilename } = context.packager.appInfo;
  const exe = context.electronPlatformName === "win32"
    ? path.join(context.appOutDir, `${productFilename}.exe`)
    : path.join(context.appOutDir, productFilename);

  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,

    // The big one for this app. ELECTRON_RUN_AS_NODE is set system-wide on the
    // machine this was built on, and main.cjs carries a whole re-exec dance to
    // survive it. With the fuse off, Electron ignores the variable outright —
    // so this both closes the injection route and quietly fixes that bug for
    // every friend who happens to have the same variable set.
    [FuseV1Options.RunAsNode]: false,

    // Two more ways to get arbitrary code into the main process at startup.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,

    // Without this, dropping an unpacked `app/` directory beside app.asar makes
    // Electron prefer it — the standard way to replace an app's code without
    // touching the archive at all.
    [FuseV1Options.OnlyLoadAppFromAsar]: true,

    // Refuses to start if app.asar's hash does not match the one embedded in
    // the executable. This is what turns "the archive is awkward to edit" into
    // "an edited archive does not run".
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,

    // The Gemini key never goes near a cookie, but session data written by the
    // renderer shouldn't sit in plaintext either.
    [FuseV1Options.EnableCookieEncryption]: true,

    // Nothing here is loaded over file://; everything goes through the loopback
    // server, so the extra privileges are pure attack surface.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });

  console.log(`  • fuses flipped on ${path.basename(exe)}`);
};
