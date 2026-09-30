{
  # The Android app's tools, pinned (design/85): the SDK platform, build
  # tools, the emulator with one Android 15 image, a JDK. Builds and
  # emulator tests run on any Nix machine; on lambda they replaced a
  # hand-installed SDK that a cleanup deleted.
  #
  #   nix develop ./android -c ../scripts/build-android.sh   (from android/: nix develop -c …)
  #   nix develop ./android -c scripts/android-emulator.sh start
  description = "Chattering for Android: build and emulator tools";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        # Google's SDK license, accepted here on purpose: the SDK cannot be
        # used without it.
        config = { android_sdk.accept_license = true; allowUnfree = true; };
      };
      android = pkgs.androidenv.composeAndroidPackages {
        platformVersions = [ "35" ];
        buildToolsVersions = [ "35.0.0" ];
        includeEmulator = true;
        includeSystemImages = true;
        systemImageTypes = [ "google_apis" ];
        abiVersions = [ "x86_64" ];
        includeNDK = false;
        includeSources = false;
      };
      sdk = "${android.androidsdk}/libexec/android-sdk";
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = [ android.androidsdk pkgs.jdk17_headless pkgs.apksigner ];
        ANDROID_HOME = sdk;
        ANDROID_SDK_ROOT = sdk;
        JAVA_HOME = "${pkgs.jdk17_headless}/lib/openjdk";
        # Gradle downloads its own aapt2, a binary built for other Linux
        # systems: use the SDK's.
        GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/build-tools/35.0.0/aapt2";
      };
    };
}
