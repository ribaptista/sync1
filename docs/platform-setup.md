# Platform setup

sync1 has been developed and tested on Linux. This covers what's needed to build and run it on macOS
and Windows too, plus how to verify the two native dependencies (`better-sqlite3`, `sodium-native`)
before relying on either platform for real. See
[cross-platform-filesystem.md](architecture/cross-platform-filesystem.md) for the filesystem-level work
(case-insensitivity, Windows file-locking) this setup is paired with.

## Prerequisites (all platforms)

- [Node.js](https://nodejs.org/) >= 20
- git

## Linux

```bash
git clone <repo-url> sync1
cd sync1
npm install
npm run build
node dist/cli.js --help
```

## macOS

Same as Linux:

```bash
git clone <repo-url> sync1
cd sync1
npm install
npm run build
node dist/cli.js --help
```

If `npm install` ever needs to compile a native dependency from source instead of using a prebuilt
binary (see [Verifying native dependencies](#verifying-native-dependencies) below), install the Xcode
Command Line Tools first:

```bash
xcode-select --install
```

## Windows

Same steps, from PowerShell:

```powershell
git clone <repo-url> sync1
cd sync1
npm install
npm run build
node dist/cli.js --help
```

If `npm install` needs to compile a native dependency from source, it needs a C++ toolchain and Python,
neither of which ship with Windows by default:

- Visual Studio Build Tools, with the **"Desktop development with C++"** workload
- Python 3

## Running without building

`npm run dev` (all platforms) runs the CLI directly from TypeScript source via `tsx`, without a build
step — useful for development, not for a real install.

## Verifying native dependencies

`better-sqlite3` and `sodium-native` are both native Node addons. Both are confirmed to ship prebuilt
binaries for `darwin-arm64`, `darwin-x64`, `win32-arm64`, and `win32-x64` as of the versions this project
pins (checked directly: `sodium-native` bundles every platform's prebuild inside its own npm package,
independent of the install host; `better-sqlite3` fetches a matching prebuild from its GitHub releases
at install time). In the normal case, **`npm install` should never need to compile anything** on either
platform — a source build only kicks in if a matching prebuild is missing for your exact Node version and
architecture.

To confirm a real install actually used a prebuild rather than compiling from source, watch `npm
install`'s output for a `node-gyp rebuild` line (its absence means a prebuild was used) — or, after
install, run the tool and confirm it starts without errors:

```bash
node dist/cli.js --help
```

If a source build ever _is_ triggered and fails, that's when the prerequisites above (Xcode Command Line
Tools on macOS; Visual Studio Build Tools + Python on Windows) are needed.

## Verifying the tool works end-to-end

Once built, the fastest way to confirm everything actually functions on a given platform is to run it
against a real (or LocalStack) S3 bucket by hand:

```bash
node dist/cli.js init_remote --bucket <bucket> --root <a-test-directory>
```

then create a file or two under that directory and run `sync`. This exercises the native dependencies,
the filesystem layer, and the S3 client together, which is a stronger signal than any individual check
above.
