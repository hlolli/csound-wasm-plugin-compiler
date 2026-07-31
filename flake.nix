{
  description = "Csound WebAssembly opcode workbench";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {nixpkgs, ...}: let
    systems = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    forAllSystems = nixpkgs.lib.genAttrs systems;
    projectFor = system: let
      pkgs = import nixpkgs {inherit system;};
      inherit (pkgs) lib;

      mkCommand = name: body:
        pkgs.writeShellApplication {
          name = "csound-opcode-${name}";
          runtimeInputs = [
            pkgs.bun
          ];
          text = ''
            if [[ ! -f package.json ]]; then
              echo "Run this command from the project folder." >&2
              exit 1
            fi

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
        dev = mkBunRun "dev" "dev";
        typecheck = mkBunRun "typecheck" "typecheck";
        test = mkBunRun "test" "test";
        build = mkBunRun "build" "build";
        preview = mkBunRun "preview" "preview";
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
        ];
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
