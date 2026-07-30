{
  description = "Csound WebAssembly opcode workbench";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {nixpkgs, ...}: let
    systems = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-linux"
    ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    projectFor = system: let
      pkgs = import nixpkgs {inherit system;};
      inherit (pkgs) lib;
      wasi = pkgs.pkgsCross.wasi32;
      wasiCc = wasi.stdenv.cc;
      wasiPrefix = wasiCc.targetPrefix;
      wasiClang = "${wasiCc}/bin/${wasiPrefix}clang";
      wasiClangxx = "${wasiCc}/bin/${wasiPrefix}clang++";
      wasiCxxLibDir = "${wasiCc.libcxx}/lib";
      wasiLd = "${wasiCc.bintools.bintools}/bin/${wasiPrefix}wasm-ld";

      mkCommand = name: body:
        pkgs.writeShellApplication {
          name = "csound-opcode-${name}";
          runtimeInputs = [
            pkgs.bun
            pkgs.gnutar
            pkgs.gzip
          ];
          text = ''
            if [[ ! -f package.json ]]; then
              echo "Run this command from the project folder." >&2
              exit 1
            fi

            export WASI_CC="${wasiClang}"
            export WASI_CXX="${wasiClangxx}"
            export WASI_CXX_LIB_DIR="${wasiCxxLibDir}"
            export WASI_LD="${wasiLd}"

            ${body}
          '';
        };

      mkBunRun = name: script:
        mkCommand name ''
          exec bun run ${lib.escapeShellArg script} "$@"
        '';

      commandPackages = {
        install = mkCommand "install" ''
          exec bun install --frozen-lockfile "$@"
        '';
        setup-sdk = mkBunRun "setup-sdk" "setup:sdk";
        dev = mkBunRun "dev" "dev";
        typecheck = mkBunRun "typecheck" "typecheck";
        test = mkBunRun "test" "test";
        build = mkBunRun "build" "build";
        start = mkBunRun "start" "start";
      };

      commandApps =
        lib.mapAttrs (_: package: {
          type = "app";
          program = lib.getExe package;
        })
        commandPackages;
    in {
      packages =
        commandPackages
        // {
          default = commandPackages.dev;
        };

      apps =
        commandApps
        // {
          default = commandApps.dev;
        };

      devShell = pkgs.mkShellNoCC {
        packages = [
          pkgs.bun
          pkgs.gnutar
          pkgs.gzip
        ];

        WASI_CC = wasiClang;
        WASI_CXX = wasiClangxx;
        WASI_CXX_LIB_DIR = wasiCxxLibDir;
        WASI_LD = wasiLd;
      };
    };
  in {
    packages = forAllSystems (system: (projectFor system).packages);
    apps = forAllSystems (system: (projectFor system).apps);
    devShells = forAllSystems (system: {
      default = (projectFor system).devShell;
    });
  };
}
