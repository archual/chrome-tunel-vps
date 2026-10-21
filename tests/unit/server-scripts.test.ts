import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const workDir = mkdtempSync(join(tmpdir(), "vps-tunnel-scripts-"));
const passwdFile = join(workDir, "passwd");
const limitsFile = join(workDir, "user-limits.cfg");

const env = {
  ...process.env,
  ENV_FILE: "/dev/null",
  PASSWD_FILE: passwdFile,
  LIMITS_FILE: limitsFile,
  SKIP_RESTART: "1",
};

function run(script: string, args: string[]) {
  return spawnSync("bash", [resolve(repoRoot, "server/scripts", script), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

function readPasswd(): string {
  return readFileSync(passwdFile, "utf8");
}

function credentials(output: string): { login: string; password: string } {
  const login = /^PROXY_LOGIN=(.+)$/m.exec(output)?.[1];
  const password = /^PROXY_PASSWORD=(.+)$/m.exec(output)?.[1];
  expect(login).toBeTruthy();
  expect(password).toBeTruthy();
  return { login: login as string, password: password as string };
}

const toolsAvailable = (() => {
  const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  return openssl.status === 0 && python.status === 0;
})();

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(!toolsAvailable)("server user scripts", () => {
  it("hands the shared etc directory to the proxy uid when run as root", () => {
    const fakeBin = join(workDir, "fake-bin");
    const target = join(workDir, "root-owned-etc");
    const chownLog = join(workDir, "chown.log");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(target);

    writeFileSync(join(fakeBin, "id"), '#!/bin/sh\necho 0\n');
    writeFileSync(join(fakeBin, "chown"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${chownLog}'\n`);
    chmodSync(join(fakeBin, "id"), 0o755);
    chmodSync(join(fakeBin, "chown"), 0o755);

    const lib = resolve(repoRoot, "server/scripts/lib.sh");
    const result = spawnSync(
      "bash",
      ["-c", `source '${lib}' && fix_dir_ownership '${target}'`],
      {
        cwd: repoRoot,
        env: { ...env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(chownLog, "utf8").trim()).toBe(`1000:1000 ${target}`);
    expect(statSync(target).mode & 0o777).toBe(0o750);
  });

  it("adds a user with a 128-bit password and a CR:$3$ hash only", () => {
    const result = run("add-user.sh", ["--output", "env", "alice"]);
    expect(result.status, result.stderr).toBe(0);
    const { login, password } = credentials(result.stdout);
    expect(login).toBe("alice");
    expect(password).toMatch(/^[0-9a-f]{32}$/);

    const passwd = readPasswd();
    expect(passwd).toMatch(/^alice:CR:\$3\$[A-Za-z0-9._-]+\$[./0-9A-Za-z]{22}$/m);
    expect(passwd).not.toContain(password);
    expect(passwd).not.toContain("$1$");
  });

  it("refuses duplicate users and writes per-user limits", () => {
    const duplicate = run("add-user.sh", ["--output", "env", "alice"]);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toContain("already exists");

    const bob = run("add-user.sh", [
      "--output",
      "env",
      "--connlim",
      "7",
      "--bandwidth",
      "8000000",
      "bob",
    ]);
    expect(bob.status, bob.stderr).toBe(0);
    const limits = readFileSync(limitsFile, "utf8");
    expect(limits).toContain("connlim 7 0 bob * * *");
    expect(limits).toContain("bandlimin 8000000 bob * * *");
    expect(limits).toContain("bandlimout 8000000 bob * * *");
  });

  it("rotates a password and removes the old hash", () => {
    const before = readPasswd();
    const oldHash = /^alice:(.+)$/m.exec(before)?.[1];
    const rotated = run("rotate-user.sh", ["--output", "env", "alice"]);
    expect(rotated.status, rotated.stderr).toBe(0);
    const { password } = credentials(rotated.stdout);
    expect(password).toMatch(/^[0-9a-f]{32}$/);

    const after = readPasswd();
    expect(after).not.toBe(before);
    expect(after).not.toContain(oldHash as string);
    expect(after).not.toContain(password);
  });

  it("lists logins without hashes", () => {
    const result = run("list-users.sh", []);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").sort()).toEqual(["alice", "bob"]);
    expect(result.stdout).not.toContain("CR:$3$");
  });

  it("matches logins exactly, not as regular expressions", () => {
    expect(run("add-user.sh", ["--output", "env", "a.b"]).status).toBe(0);
    expect(run("add-user.sh", ["--output", "env", "axb"]).status).toBe(0);
    const axbHash = /^axb:(.+)$/m.exec(readPasswd())?.[1];

    const rotated = run("rotate-user.sh", ["--output", "env", "a.b"]);
    expect(rotated.status, rotated.stderr).toBe(0);
    expect(readPasswd()).toMatch(new RegExp(`^axb:${(axbHash as string).replace(/[$]/g, "\\$")}$`, "m"));

    expect(run("revoke-user.sh", ["axb"]).status).toBe(0);
    expect(readPasswd()).toMatch(/^a\.b:CR:\$3\$/m);
    expect(readPasswd()).not.toMatch(/^axb:/m);
    expect(run("revoke-user.sh", ["a.b"]).status).toBe(0);
  });

  it("removes limits for the exact login only", () => {
    expect(run("add-user.sh", ["--output", "env", "--connlim", "3", "a.b"]).status).toBe(0);
    expect(run("add-user.sh", ["--output", "env", "--connlim", "5", "axb"]).status).toBe(0);

    expect(run("revoke-user.sh", ["a.b"]).status).toBe(0);
    const limits = readFileSync(limitsFile, "utf8");
    expect(limits).toContain("connlim 5 0 axb * * *");
    expect(limits).not.toContain("connlim 3 0 a.b * * *");

    expect(run("revoke-user.sh", ["axb"]).status).toBe(0);
    expect(readFileSync(limitsFile, "utf8")).not.toContain("axb");
  });

  it("revokes users, removes limits and keeps the users file valid", () => {
    expect(run("revoke-user.sh", ["bob"]).status).toBe(0);
    expect(readFileSync(limitsFile, "utf8")).not.toContain("bob");

    expect(run("revoke-user.sh", ["alice"]).status).toBe(0);
    const passwd = readPasswd();
    expect(passwd).toMatch(/^__disabled__:CR:\$3\$[A-Za-z0-9._-]+\$[./0-9A-Za-z]{22}$/m);

    const listed = run("list-users.sh", []);
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim()).toBe("");
  });

  it("rejects invalid logins and unsafe limits", () => {
    expect(run("add-user.sh", ["--output", "env", "bad login"]).status).not.toBe(0);
    expect(run("add-user.sh", ["--output", "env", "--connlim", "0", "carol"]).status).not.toBe(0);
    expect(run("add-user.sh", ["--output", "env", "--bandwidth", "10", "carol"]).status).not.toBe(0);
  });
});
