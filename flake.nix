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
  in {
    devShells = forAllSystems (system: {
      default = let
        pkgs = import nixpkgs {inherit system;};
      in
        pkgs.mkShellNoCC {
          packages = [
            pkgs.bun
          ];
        };
    });
  };
}
