import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function lineIndex(haystack: string, needle: string): number {
  return haystack.split("\n").findIndex((line) => line.includes(needle));
}

const compose = read("server/docker-compose.yml");
const config = read("server/etc/3proxy.cfg");
const gitignore = read(".gitignore");

describe("server compose file", () => {
  it("pins the 3proxy LTS image by digest and never uses latest", () => {
    expect(compose).toMatch(
      /image:\s+3proxy\/3proxy:lts-busybox@sha256:[a-f0-9]{64}/,
    );
    const imageLines = compose
      .split("\n")
      .filter((line) => /^\s*image:/.test(line));
    expect(imageLines.length).toBeGreaterThan(0);
    for (const line of imageLines) {
      expect(line).not.toMatch(/:latest\b/);
    }
  });

  it("publishes only the TLS port and keeps 3129 internal", () => {
    expect(compose).toMatch(/"\$\{PUBLIC_PORT:-443\}:3129\/tcp"/);
    expect(compose).not.toMatch(/"3129:3129"/);
    expect(compose).not.toMatch(/network_mode:\s*host/);
  });

  it("runs unprivileged with dropped capabilities", () => {
    expect(compose).toMatch(/user:\s*"\$\{PROXY_UID:-1000\}:\$\{PROXY_GID:-1000\}"/);
    expect(compose).toMatch(/cap_drop:\s*\[ALL\]/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toMatch(/restart:\s*unless-stopped/);
  });

  it("mounts config, users and certificates read-only and has a healthcheck", () => {
    expect(compose).toMatch(/.\/etc:\/etc\/3proxy:ro/);
    expect(compose).toMatch(/.\/certs:\/etc\/3proxy\/certs:ro/);
    expect(compose).toMatch(/healthcheck:/);
    expect(compose).toMatch(/healthcheck-container\.sh/);
  });
});

describe("3proxy configuration", () => {
  it("enables TLS with a minimum of TLS 1.2 and an explicit certificate", () => {
    expect(config).toMatch(/^ssl_serv$/m);
    expect(config).toMatch(/^ssl_server_min_proto_version TLSv1\.2$/m);
    expect(config).toMatch(/^ssl_server_cert \/etc\/3proxy\/certs\/fullchain\.pem$/m);
    expect(config).toMatch(/^ssl_server_key \/etc\/3proxy\/certs\/privkey\.pem$/m);
    expect(config).toMatch(/^proxy -p3129 -i0\.0\.0\.0$/m);
  });

  it("requires strong authentication for every request", () => {
    expect(config).toMatch(/^auth strong$/m);
    expect(config).toMatch(/^users \$\/etc\/3proxy\/passwd$/m);
    expect(config).not.toMatch(/^auth none$/m);
    expect(config).not.toMatch(/^allow \*$/m);
  });

  it("denies private, loopback, link-local and metadata targets before allowing", () => {
    const deny = lineIndex(config, "deny * * 0.0.0.0/8,10.0.0.0/8");
    const allow = lineIndex(config, "allow * * * 80,443");
    expect(deny).toBeGreaterThanOrEqual(0);
    expect(allow).toBeGreaterThan(deny);
    for (const cidr of [
      "127.0.0.0/8",
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "169.254.0.0/16",
      "100.64.0.0/10",
      "::ffff:0:0/96",
      "fc00::/7",
      "fe80::/10",
    ]) {
      expect(config).toContain(cidr);
    }
  });

  it("blocks SMTP ports and allows web ports plus the approved methods", () => {
    const smtp = lineIndex(config, "deny * * * 25,465,587");
    const allow = lineIndex(config, "allow * * * 80,443");
    expect(smtp).toBeGreaterThanOrEqual(0);
    expect(allow).toBeGreaterThan(smtp);
    for (const method of [
      "HTTP_CONNECT",
      "HTTP_GET",
      "HTTP_POST",
      "HTTP_HEAD",
      "HTTP_PUT",
      "HTTP_OTHER",
    ]) {
      expect(config).toContain(method);
    }
    expect(config).toMatch(/^deny \*$/m);
  });

  it("enforces global and per-user limits", () => {
    expect(config).toMatch(/^include \/etc\/3proxy\/user-limits\.cfg$/m);
    expect(config).toMatch(/^connlim 100 0 \* \* \* \*$/m);
    const limitsBeforeDefaults =
      lineIndex(config, "include /etc/3proxy/user-limits.cfg") <
      lineIndex(config, "connlim 100 0 * * * *");
    expect(limitsBeforeDefaults).toBe(true);
  });

  it("logs host-only fields without leaking request paths or credentials", () => {
    const logformat = config
      .split("\n")
      .find((line) => line.startsWith("logformat "));
    expect(logformat).toBeDefined();
    expect(logformat).toContain("user=%U dst=%n:%q method=%1-1T status=%E in=%I out=%O");
    expect(logformat).not.toContain("%T");
    expect(logformat).not.toMatch(/Proxy-Authorization/i);
    expect(config).toMatch(/^rotate 7$/m);
  });

  it("never enables admin, HTTP admin or SOCKS services", () => {
    for (const forbidden of ["admin", "http ", "socks ", "socks5"]) {
      expect(config).not.toMatch(new RegExp(`^${forbidden}`, "m"));
    }
  });

  it("never uses MD5-crypt or a plaintext password file", () => {
    expect(config).not.toMatch(/\$1\$/);
    expect(config).not.toMatch(/passwd[^\n]*plain/i);
  });
});

describe("secret hygiene", () => {
  it("gitignores runtime secrets and certificates", () => {
    for (const pattern of [
      ".env",
      "server/etc/passwd",
      "server/certs/*",
      "server/etc/user-limits.cfg",
    ]) {
      expect(gitignore).toContain(pattern);
    }
  });

  it("uses 128-bit random passwords and refuses non-BLAKE2b hashes", () => {
    const addUser = read("server/scripts/add-user.sh");
    const lib = read("server/scripts/lib.sh");
    expect(addUser).toContain("generate_password");
    expect(lib).toContain("openssl rand -hex 16");
    expect(addUser).toContain('CR:\\$3\\$*');
    expect(addUser).not.toContain("openssl passwd -1");
    expect(addUser).not.toMatch(/md5/i);
  });

  it("ships the documented user lifecycle and health scripts", () => {
    for (const script of [
      "server/scripts/add-user.sh",
      "server/scripts/rotate-user.sh",
      "server/scripts/revoke-user.sh",
      "server/scripts/list-users.sh",
      "server/scripts/healthcheck.sh",
      "server/scripts/issue-cert.sh",
      "server/scripts/renew-cert.sh",
      "server/scripts/install-renew-cron.sh",
      "server/scripts/smoke-test.sh",
      "server/scripts/init.sh",
    ]) {
      expect(existsSync(resolve(repoRoot, script))).toBe(true);
    }
  });
});

describe("spike documentation", () => {
  it("records the tested 3proxy version and the pinned image digest", () => {
    const report = read("docs/server-spike-3.1.1.md");
    const digest = /sha256:[a-f0-9]{64}/.exec(compose)?.[0];
    expect(digest).toBeDefined();
    expect(report).toContain("3proxy-0.9.9.1");
    expect(report).toContain(digest as string);
    expect(report).toContain("ssl_serv");
    expect(report).toContain("CR:$3$");
    expect(report).toContain("SRV-AC-1");
  });
});

describe("CR:$3$ hash helper", () => {
  it("matches the reference 3proxy_crypt vectors", () => {
    const result = spawnSync("python3", ["server/scripts/3proxy-crypt.py", "--self-test"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.error) {
      // python3 is optional on developer machines; CI/demo hosts install it.
      return;
    }
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "CR:$3$testsalt$rLpPSsFiEZbWom3uj3E.40",
    );
    expect(result.stdout).toContain(
      "CR:$3$abcdefgh12345678$dm1YsEIvPs2Z280yw3fmv0",
    );
  });

  it("produces a CR:$3$ hash for a generated salt", () => {
    try {
      execFileSync("python3", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }
    const output = execFileSync(
      "python3",
      ["server/scripts/3proxy-crypt.py", "abcdefgh12345678", "spikeuserpass123"],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
    expect(output).toBe("CR:$3$abcdefgh12345678$dm1YsEIvPs2Z280yw3fmv0");
    expect(output).not.toContain("$1$");
  });
});
