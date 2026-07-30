# Csound opcode workbench

A small self-hosted IDE for Csound WebAssembly plugins.

Write a C or C++ opcode on the left. Write a CSD test on the right. Run compiles the active source with Nix cross Clang, loads the plugin into Csound, then starts audio. Export WASM downloads the last good build.

Nothing is sent to a cloud service.

## Quick start

You need Nix with flakes enabled.

The flake supports Apple Silicon macOS and x86_64 or aarch64 Linux.

Then run:

```sh
nix run .#install
nix run .#setup-sdk
nix run .#dev
```

Open <http://127.0.0.1:5173>.

Nix supplies Bun and the WASI cross compiler. Bun still installs the web packages into `node_modules`. The packages are not built or copied into the Nix store.

`setup:sdk` unpacks the Csound headers from the archive inside `@csound/wasm-bin`. The default output is `.cache/csound-plugin-sdk`.

To check the compiler:

```sh
curl http://127.0.0.1:8787/api/health
```

## C and C++

Use the `C | C++` switch above the source editor.

- C uses `plugin.c` and `WASI_CC`
- C++ uses `plugin.cpp` and `WASI_CXX`
- Each mode keeps its own saved source
- Both modes use the same CSD

The C++ example uses Csound's `csnd::Plugin` helper from `modload.h`.

C++ exceptions and run-time type checks are off. This keeps the plugin small and matches the Csound WASM example build.

## Run a production build

Build the web files first:

```sh
nix run .#build
nix run .#start
```

Open <http://127.0.0.1:8787>.

The Bun server serves `dist` and the compile API.

## Commands

| Command | Use |
| --- | --- |
| `nix run .#install` | Install the web packages with Bun |
| `nix run .#setup-sdk` | Unpack the Csound plugin headers |
| `nix run .#dev` | Start Vite and the compile server |
| `nix run .#typecheck` | Check TypeScript |
| `nix run .#test` | Run tests |
| `nix run .#build` | Typecheck and build the web app |
| `nix run .#start` | Serve `dist` and the compile API |

`nix run .` is the same as `nix run .#dev`.

You can also enter the shell:

```sh
nix develop
```

The shell has Bun, `tar`, `WASI_CC`, `WASI_CXX`, `WASI_CXX_LIB_DIR`, and `WASI_LD`. Direct `bun run` commands work there.

## Why there is no WASI SDK download

[WASI SDK](https://github.com/WebAssembly/wasi-sdk) is a ready-made set of Clang, LLD, wasi-libc, and compiler runtime files. Clang already knows how to emit WebAssembly.

Raw Clang is not enough for this app. The sample includes C headers, calls `memset`, and links two WASI helper libraries.

The flake uses the maintained [`pkgsCross.wasi32`](https://github.com/NixOS/nixpkgs/blob/master/lib/systems/examples.nix) toolchain from Nixpkgs. Its Clang wrappers supply wasi-libc, libc++, the compiler runtime, and the target paths. The app calls those wrappers and their matching linker by full Nix store path.

Nixpkgs now names this target `wasm32-unknown-wasip1`. It is the current name for the old `wasm32-wasi` target.

There is no `WASI_SDK_PATH`. Nix sets the C compiler, C++ compiler, libc++ path, and linker.

## Settings

| Variable | Default | Use |
| --- | --- | --- |
| `WASI_CC` | Set by Nix | WASI Clang wrapper |
| `WASI_CXX` | Set by Nix | WASI Clang++ wrapper |
| `WASI_CXX_LIB_DIR` | Set by Nix | Matching libc++ archive folder |
| `WASI_LD` | Set by Nix | Matching WebAssembly linker |
| `CSOUND_WASM_SDK_PATH` | `.cache/csound-plugin-sdk` | Csound headers from `setup:sdk` |
| `HOST` | `127.0.0.1` | Production server host |
| `PORT` | `8787` | Production server port |

Relative SDK paths start at the project root.

Vite uses port `5173` in development and proxies `/api` to port `8787`.

Keep `HOST=127.0.0.1` unless you mean to share the compiler on your network. The compile service runs Clang on submitted source. It uses a fresh temporary folder and removes it after each job, but it is not an operating system sandbox. Do not expose it to the public internet.

## How Run works

1. The browser posts `plugin.c` or `plugin.cpp` to `POST /api/compile` as plain UTF-8 text.
2. The `X-Plugin-Language` header selects C or C++.
3. A Bun worker thread writes the source to a new temporary folder.
4. Nix cross Clang builds `plugin.wasm` for WASI Preview 1.
5. The server adds an `OPCODE.WASM` custom section.
6. The worker returns diagnostics and the `.wasm` buffer.
7. The server sends JSON metadata and the plugin in one multipart response.
8. The browser marks Clang errors in the source editor.
9. A new Csound browser instance loads the plugin, compiles the CSD, and starts audio.

The current audio keeps playing while Clang works. A failed build leaves it alone. A good build stops it and starts the new plugin.

The compiler worker sends the finished `.wasm` with a transferable `ArrayBuffer`. This moves ownership to the server thread without cloning the binary.

The full browser path is not zero-copy. The app gives `@csound/browser` a Blob URL through `withPlugins`. The package fetches that URL into its own `ArrayBuffer`. Its current worker setup then uses structured clone for the plugin buffer because that buffer is not in the package transfer list. Removing that copy needs a change in `@csound/browser`.

## Export WASM

After a good build, Export WASM downloads `plugin.wasm`. Editing the source or switching its language disables the button until the next good build.

The file has a WebAssembly custom section named `OPCODE.WASM`. Its value is:

```text
Built by OPCODE.WASM
```

The section sits just after the standard eight-byte WebAssembly file header. It does not change the plugin code or imports.

## Why every Run creates Csound again

The selected `@csound/browser` build loads plugins only through `withPlugins` while a new `Csound(...)` instance is being made.

It does not offer a supported call that adds a new WebAssembly plugin to an instance that is already running.

Each Run therefore:

1. Stops and closes the old instance
2. Creates a new instance with the new plugin in `withPlugins`
3. Compiles the CSD
4. Starts audio

Stop ends playback and closes the current instance. Natural score completion does the same cleanup.

The app uses the package's AudioWorklet and worker path with `useWorker: true` and `useSAB: false`. It does not provide alternate audio setups.

## Files and data

- Both source buffers and the CSD save to `localStorage`
- The active C or C++ source goes to the server only when you run it
- Temporary compiler folders are removed after every job
- No project files or editor text go to an outside service

The backend accepts one C or C++ file. The Nix Clang wrappers supply wasi-libc and libc++. The backend adds the Csound headers from `@csound/wasm-bin`.

## Limits

- Source is limited to 256 KiB
- Compiler output is limited to 128 KiB
- A plugin is limited to 4 MiB
- Clang gets 10 seconds
- One compile runs at a time
- Up to four jobs may wait
- The compiler accepts one `plugin.c` or `plugin.cpp` file
- Extra source files and custom linker flags are not supported
- The plugin must export `__wasm_call_ctors` and a Csound plugin entry point
- The current browser loader does not support every Csound plugin kind
- Audio needs WebAudio and a user action in the browser

## Use the source in native Csound

The C sample uses the normal Csound plugin API:

- `csound.h`
- `csdl.h`
- `OENTRY`
- `LINKAGE`

The C++ sample uses `modload.h` and `csnd::Plugin`.

You can copy either source into a native Csound plugin project and build it with that project's normal compiler setup. The source has no browser calls.

Build against headers and numeric precision that match your native Csound install. This app builds WebAssembly with double precision. It does not build a native shared library.

Native macOS and Linux exports are not included. They need a matching Csound build, numeric precision, C library, and platform SDK. A generic native download could load with the wrong ABI.

You can also copy the CSD into native Csound after the native plugin is installed where Csound can load it.
