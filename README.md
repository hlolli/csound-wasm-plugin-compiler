# Csound opcode workbench

A small browser IDE for Csound WebAssembly plugins.

Write a C or C++ opcode on the left. Write a CSD test on the right. Run builds the plugin inside a Web Worker, loads it into Csound, and starts audio.

The app is static. It has no compile server. Your source stays in the browser.

## Quick start

You need Bun 1.3.13 or newer.

```sh
bun install --frozen-lockfile
bun run dev
```

Open <http://127.0.0.1:5173>.

The first Run loads the browser compiler. The raw compiler files are about 105 MB. A host with gzip or Brotli sends about 27 MB.

Later runs use the browser cache.

## Build

```sh
bun run build
bun run preview
```

Open <http://127.0.0.1:4173>.

The full app is in `dist`. You can copy that folder to any static host. Asset links are relative, so the app can also live in a path such as `/opcode-wasm/`.

## Commands

| Command | Use |
| --- | --- |
| `bun install --frozen-lockfile` | Install web packages |
| `bun run dev` | Start Vite |
| `bun run typecheck` | Check TypeScript |
| `bun run test` | Run tests and real C and C++ builds |
| `bun run build` | Check and build the static app |
| `bun run preview` | Serve the built app |

## Optional Nix shell

The flake gives you the pinned Bun from Nixpkgs. It does not build the compiler or web packages.

```sh
nix develop
bun install --frozen-lockfile
bun run dev
```

Web packages still come from npm and stay in `node_modules`.

## C and C++

Use the `C | C++` switch above the source editor.

- C uses `plugin.c`
- C++ uses `plugin.cpp`
- Each mode keeps its own source
- Both modes use the same CSD

The C++ sample uses `csnd::Plugin` from `modload.h`.

C++ exceptions and RTTI are off. This keeps the plugin small and matches the Csound WebAssembly plugin build.

## How Run works

1. The page starts a compiler Web Worker
2. The worker loads Clang, LLD, the WASI files, and the Csound headers
3. Clang builds `plugin.wasm` for WASI Preview 1
4. The worker parses errors and adds the `OPCODE.WASM` section
5. The worker transfers the Wasm buffer to the page
6. The page ends the compiler worker to free its memory
7. CodeMirror marks source errors
8. Csound loads the plugin, compiles the CSD, and starts audio

A failed build leaves the current audio alone. A good build replaces the current Csound instance.

Stop ends the active build or playback. It also closes the current Csound instance.

## Browser compiler

The app pins `@yowasp/clang` at `22.0.0-git20542-10`.

It contains Clang, LLD, wasi-libc, compiler-rt, libc++, and the WASI helper libraries. The Csound headers come from the matching `@csound/wasm-bin` package.

You do not need Nix, WASI SDK, or a native cross compiler.

The YoWASP source repo is read only now. Keep the package version pinned. Test any toolchain change with both sample plugins.

## Export WASM

After a good build, Export WASM downloads `plugin.wasm`.

Editing the source or changing its language clears the last build. Run again before export.

The file has a WebAssembly custom section named `OPCODE.WASM`. Its value is:

```text
Built by OPCODE.WASM
```

The section does not change the plugin code or imports.

## Csound plugin loading

The selected `@csound/browser` build accepts plugins through `withPlugins` while it creates a Csound instance.

It has no supported call that adds a new Wasm plugin to a running instance. Each good Run must:

1. Stop and close the old instance
2. Create an instance with the new plugin
3. Compile the CSD
4. Start audio

The app uses the AudioWorklet and worker path with `useWorker: true` and `useSAB: false`.

## Saved data

- C source saves in `localStorage`
- C++ source saves in `localStorage`
- The CSD saves in `localStorage`
- Source never leaves the browser
- The compiler files load from the same static host
- No cloud service receives the code

## Limits

- Source can use one `plugin.c` or `plugin.cpp` file
- Source size is 256 KiB
- Compiler output is 128 KiB
- Plugin size is 4 MiB
- Compiler load gets 120 seconds
- A build gets 30 seconds
- One build runs at a time
- Extra source files and custom flags are not supported
- The plugin must export `__wasm_call_ctors`
- The plugin must export a Csound plugin entry point

Use a recent browser with WebAssembly, Web Workers, `DecompressionStream`, and Web Audio.

Your static host should send `.wasm` as `application/wasm`. Compression is strongly advised for the compiler files.

## Native Csound

The C sample uses:

- `csound.h`
- `csdl.h`
- `OENTRY`
- `LINKAGE`

The C++ sample uses `modload.h` and `csnd::Plugin`.

You can copy either source into a native Csound plugin project. Build it against the headers and numeric precision of that Csound install.

This app builds double precision Wasm. It does not build native macOS or Linux libraries.

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled code, fonts, and matching Csound build source.
