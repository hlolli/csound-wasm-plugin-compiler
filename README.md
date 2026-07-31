# Csound opcode workbench

A small browser IDE for Csound WebAssembly plugins.

Write a C or C++ opcode on the left. Write a CSD test on the right. Run builds the plugin inside a Web Worker, loads it into Csound, and starts audio. Export WAV renders the same code to a file.

The app is static. It has no compile server. It does not upload your source. Share puts the source in the URL and clipboard when you ask. WebMCP lets a browser agent work in the open tab when you enable it.

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

For browser builds, the compiler supplies a small `modload.h` adapter. The source API stays the same. The adapter uses `csound_opcode_init` because this Csound browser build cannot map callbacks from `csoundModuleInit`.

Native builds still use the normal Csound `modload.h`.

The compiler rejects a raw `csoundModuleInit` plugin before Run. That path stops on its first audio block in the pinned browser build.

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

Stop ends the active build, render, or playback. It also closes the current Csound instance.

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

The Wasm file uses the table and memory layout of the pinned Csound Wasm build. The compiler reads the linked file and tells the loader how much memory and table space it needs.

## Export WAV

Export WAV builds the active plugin and renders `example.csd` in a Csound worker. It downloads `opcode-wasm-render.wav` when the score ends.

The page changes the CSD output option for this render. Other CSD options stay in place. The editor text does not change.

Stop live playback before export. Stop can also end a render. A render has a 120 second limit.

## Share links

Share puts the current workspace in the URL and copies the link.

The link contains:

- The active C or C++ mode
- The CSD
- Changed C source
- Changed C++ source

The link uses Pako compression and a `#pako:` URL fragment. C and C++ source are left out when they match their initial text exactly. A link can still carry changes from both source modes.

Opening a valid share link replaces saved editor text with the shared workspace. The first editor or source mode change clears the old share fragment. Press Share again to make a new link.

## WebMCP

The page registers WebMCP tools through `document.modelContext` when the browser provides it.

For local Chrome use:

1. Open `chrome://flags/#enable-webmcp-testing`
2. Set WebMCP to Enabled
3. Relaunch Chrome
4. Open the workbench in a WebMCP browser agent

The tools can:

- Read the C, C++, and CSD editors
- Update editor text with a revision check
- Compile the active plugin
- Run and stop Csound
- Export Wasm and WAV files
- Make a share link

The revision check stops an agent from replacing a newer hand edit. Read the workspace again after a conflict.

WebMCP runs inside the open tab. Closing the tab removes the tools. The app still works when WebMCP is off.

The app does not send code to a model by itself. A WebMCP browser agent can read code when you ask it to use these tools. Check that agent and model before sharing private code.

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
- The app does not upload source
- Share writes source to the URL fragment and clipboard
- The browser does not send URL fragments to the static host
- The compiler files load from the same static host
- No cloud compile service receives the code

## Limits

- Source can use one `plugin.c` or `plugin.cpp` file
- Source size is 256 KiB
- Compiler output is 128 KiB
- Plugin size is 4 MiB
- Share data is limited to 1 MiB before compression
- The app warns when a share URL is longer than 64 KiB
- Compiler load gets 120 seconds
- A build gets 30 seconds
- An audio render gets 120 seconds
- One build runs at a time
- Extra source files and custom flags are not supported
- One C++ file can register up to 256 opcodes
- Load one exported OPCODE.WASM plugin in each Csound instance
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
