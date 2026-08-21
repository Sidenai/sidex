{
  lib,
  stdenv,
  rustPlatform,
  fetchNpmDeps,
  npmHooks,
  nodejs,
  pkg-config,
  wrapGAppsHook4,
  cargo-tauri,
  openssl,
  glib-networking,
  webkitgtk_4_1,
  gtk3,
  glib,
  librsvg,
  libayatana-appindicator,
  libsoup_3,
  nix-update-script,
  src,
  version,
  maintainers ? [ ],
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "sidex";
  inherit src version;

  cargoRoot = "src-tauri";
  buildAndTestSubdir = "src-tauri";

  RUST_MIN_STACK = "16777216";

  cargoHash = "sha256-3l4mtUc5po8rtnuYhQTJgOGYm6ooYIAPcRglROewr8k=";

  npmDeps = fetchNpmDeps {
    inherit src;
    name = "sidex";
    hash = "sha256-F7RgMBNLNz/+mV0QccfKIqSckX8fMtFUdcUcx+22Dfw=";
  };

  npmFlags = [ "--legacy-peer-deps" ];

  nativeBuildInputs = [
    cargo-tauri.hook
    npmHooks.npmConfigHook
    nodejs
    pkg-config
    wrapGAppsHook4
  ];

  buildInputs =
    [ openssl ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [
      glib-networking
      webkitgtk_4_1
      gtk3
      glib
      librsvg
      libayatana-appindicator
      libsoup_3
    ];

  doCheck = false;

  preBuild = ''
    export TAURI_FRONTEND_PATH="$PWD"
  '';

  preFixup = ''
    gappsWrapperArgs+=(--set-default WEBKIT_DISABLE_DMABUF_RENDERER 1)
  '';

  passthru.updateScript = nix-update-script { };

  meta = {
    description = "VSCode's workbench, without Electron";
    homepage = "https://github.com/Sidenai/sidex";
    license = lib.licenses.mit;
    mainProgram = "SideX";
    maintainers = maintainers;
    platforms = lib.platforms.linux;
  };
})
