# Chattering Anywhere relay on NixOS (design/85): the meeting point
# (anywhere/relay.js behind Caddy, which gets the certificate) and the TURN
# server (coturn) for phones that cannot reach their computer directly.
#
# In the relay machine's configuration:
#   imports = [ /path/to/chattering/anywhere/deploy/nixos.nix ];
#   services.chattering-anywhere = {
#     enable = true;
#     domain = "encrypted-link-to-your-devices.rockfrog.ai";
#     source = /path/to/chattering;          # a checkout (relay.js, public/, wsserver.js)
#     turnSecretFile = "/var/lib/secrets/anywhere-turn";  # one line: openssl rand -hex 32;
#                                   # owner root, group turnserver, mode 0440 (coturn reads it too)
#   };
#
# Nothing here writes a log of who connects: Caddy keeps no access log
# unless asked, the relay prints one line when it starts, coturn's log goes
# nowhere. Keep it that way: the promise to people is "we keep no logs".
{ config, lib, pkgs, ... }:
let
  cfg = config.services.chattering-anywhere;
  # Only what the relay runs: anywhere/ and the WebSocket server it shares
  # with Chattering (not the whole checkout and its runtime).
  relaySrc = lib.fileset.toSource {
    root = cfg.source;
    fileset = lib.fileset.unions [ (cfg.source + "/anywhere") (cfg.source + "/wsserver.js") ];
  };
in {
  options.services.chattering-anywhere = {
    enable = lib.mkEnableOption "the Chattering Anywhere relay";
    domain = lib.mkOption { type = lib.types.str; description = "The relay's name; its A/AAAA records point here."; };
    source = lib.mkOption { type = lib.types.path; description = "A Chattering checkout: anywhere/ and wsserver.js."; };
    port = lib.mkOption { type = lib.types.port; default = 8790; description = "The relay's local port, behind Caddy."; };
    turnSecretFile = lib.mkOption { type = lib.types.str; description = "File holding coturn's static-auth-secret (shared with the relay)."; };
    turnMinPort = lib.mkOption { type = lib.types.port; default = 49152; };
    turnMaxPort = lib.mkOption { type = lib.types.port; default = 65535; };
    # What one relayed connection may cost: a phone reading conversations
    # needs little; a video through the relay needs more. Per session, bytes/s.
    maxBps = lib.mkOption { type = lib.types.int; default = 3000000; };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall = {
      allowedTCPPorts = [ 80 443 3478 5349 ];
      allowedUDPPorts = [ 3478 5349 ];
      allowedUDPPortRanges = [ { from = cfg.turnMinPort; to = cfg.turnMaxPort; } ];
    };

    services.caddy = {
      enable = true;
      # No access log: Caddy writes none unless a `log` directive asks.
      # previews.<domain>: the previews' own site on a phone (design/67); it
      # needs A and AAAA records of its own.
      virtualHosts.${cfg.domain}.serverAliases = [ "previews.${cfg.domain}" ];
      virtualHosts.${cfg.domain}.extraConfig = ''
        encode zstd gzip
        reverse_proxy 127.0.0.1:${toString cfg.port}
      '';
    };

    systemd.services.chattering-anywhere = {
      description = "Chattering Anywhere relay";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        PORT = toString cfg.port;
        HOST = "127.0.0.1";
        TRUST_PROXY = "1";
        TURN_URLS = "turn:${cfg.domain}:3478?transport=udp,turn:${cfg.domain}:3478?transport=tcp,turns:${cfg.domain}:5349?transport=tcp";
      };
      # The secret reaches the sandboxed user through systemd's credentials.
      script = ''
        export TURN_SECRET="$(cat "$CREDENTIALS_DIRECTORY/turn")"
        exec ${pkgs.nodejs_22}/bin/node ${relaySrc}/anywhere/relay.js
      '';
      serviceConfig = {
        DynamicUser = true;
        Restart = "always";
        RestartSec = 2;
        # The relay keeps nothing: no state directory, a read-only system.
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        PrivateTmp = true;
        NoNewPrivileges = true;
        LoadCredential = [ "turn:${cfg.turnSecretFile}" ];
        MemoryMax = "512M";
      };
    };

    # coturn reads Caddy's certificate for TURN over TLS (port 5349), for
    # networks that let nothing but TLS out.
    users.users.turnserver.extraGroups = [ "caddy" ];
    services.coturn = {
      enable = true;
      realm = cfg.domain;
      use-auth-secret = true;
      static-auth-secret-file = cfg.turnSecretFile;
      min-port = cfg.turnMinPort;
      max-port = cfg.turnMaxPort;
      no-cli = true;
      cert = "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${cfg.domain}/${cfg.domain}.crt";
      pkey = "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${cfg.domain}/${cfg.domain}.key";
      extraConfig = ''
        fingerprint
        # No logs: not to a file, not to the journal.
        log-file=/dev/null
        no-stdout-log
        # A relay for phones and their computers, not for anything else:
        # never towards this machine or any private network, and a ceiling
        # on what one session and all of them may take.
        no-multicast-peers
        no-loopback-peers
        denied-peer-ip=0.0.0.0-0.255.255.255
        denied-peer-ip=10.0.0.0-10.255.255.255
        denied-peer-ip=100.64.0.0-100.127.255.255
        denied-peer-ip=127.0.0.0-127.255.255.255
        denied-peer-ip=169.254.0.0-169.254.255.255
        denied-peer-ip=172.16.0.0-172.31.255.255
        denied-peer-ip=192.0.0.0-192.0.0.255
        denied-peer-ip=192.168.0.0-192.168.255.255
        denied-peer-ip=198.18.0.0-198.19.255.255
        denied-peer-ip=::1
        denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
        denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
        max-bps=${toString cfg.maxBps}
        user-quota=12
        total-quota=1200
        stale-nonce=600
      '';
    };
  };
}
