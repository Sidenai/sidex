{
  description = "SideX - VSCode's workbench, without Electron";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;

      pkgsFor = system: import nixpkgs { inherit system; };

      sidex = pkgs:
        pkgs.callPackage ./nix/package.nix {
          src = self;
          version = "0.1.3";
        };
    in
    {
      packages = forAllSystems (system: {
        default = sidex (pkgsFor system);
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${sidex (pkgsFor system)}/bin/SideX";
        };
      });

      devShells = forAllSystems (system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            nativeBuildInputs = with pkgs; [
              pkg-config
              wrapGAppsHook4
              cargo
              cargo-tauri
              nodejs
              rustc
            ];

            buildInputs = with pkgs; [
              librsvg
              webkitgtk_4_1
            ];

            shellHook = ''
              export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH"
            '';
          };
        });

      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}