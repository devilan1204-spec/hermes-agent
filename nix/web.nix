# nix/web.nix — Hermes Web Dashboard (Vite/React) frontend build
{ pkgs, hermesNpmLib, ... }:
let
  src = ../apps;
  npmDeps = pkgs.fetchNpmDeps {
    inherit src;
    hash = "sha256-6qhGuifHVtCeep1SiQdCUxBMr7UGhYpdMTvXhrQu/zA=";
  };

  npm = hermesNpmLib.mkNpmPassthru { folder = "apps/dashboard"; attr = "web"; pname = "hermes-web"; };

  packageJson = builtins.fromJSON (builtins.readFile (src + "/dashboard/package.json"));
  version = packageJson.version;
in
pkgs.buildNpmPackage (npm // {
  pname = "hermes-web";
  inherit src npmDeps version;
  sourceRoot = "apps/dashboard";

  doCheck = false;

  buildPhase = ''
    npx tsc -b
    npx vite build --outDir dist
  '';

  installPhase = ''
    runHook preInstall
    cp -r dist $out
    runHook postInstall
  '';
})
