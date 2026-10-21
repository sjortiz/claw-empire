import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function sameFile(left: string, right: string): boolean {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return !fs.existsSync(left) && !fs.existsSync(right);
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

/** Copy-on-write where available, with isolated writable files and relative package links. */
export function reuseWorktreeDependencies(
  projectPath: string,
  worktreePath: string,
  otherWorktrees: string[] = [],
): boolean {
  const target = path.join(worktreePath, "node_modules");
  if (fs.existsSync(target)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(worktreePath, "package.json"), "utf8"));
    if (
      manifest.workspaces ||
      manifest.pnpm?.patchedDependencies ||
      fs.existsSync(path.join(worktreePath, "pnpm-workspace.yaml")) ||
      ["preinstall", "install", "postinstall", "prepare"].some((script) => manifest.scripts?.[script]) ||
      [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies].some((group) =>
        Object.values(group ?? {}).some((version) => /^(file:|link:|workspace:)/.test(String(version))),
      )
    ) {
      return false;
    }
    if (!fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml"))) return false;
    for (const sourcePath of [projectPath, ...otherWorktrees]) {
      if (sourcePath === worktreePath) continue;
      const source = path.join(sourcePath, "node_modules");
      if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) continue;
      if (
        !["package.json", "pnpm-lock.yaml", ".npmrc", ".pnpmfile.cjs", "pnpm-workspace.yaml"].every((file) =>
          sameFile(path.join(sourcePath, file), path.join(worktreePath, file)),
        ) ||
        !fs.existsSync(path.join(source, ".pnpm", "lock.yaml")) ||
        !sameFile(path.join(sourcePath, "pnpm-lock.yaml"), path.join(source, ".pnpm", "lock.yaml"))
      ) {
        continue;
      }
      const temporary = path.join(worktreePath, `.climpire-dependencies-${randomUUID()}`);
      try {
        fs.cpSync(source, temporary, {
          recursive: true,
          verbatimSymlinks: true,
          mode: fs.constants.COPYFILE_FICLONE,
          filter: (entry) => {
            if (fs.lstatSync(entry).isSymbolicLink()) {
              const link = fs.readlinkSync(entry);
              const relative = path.relative(source, path.resolve(path.dirname(entry), link));
              if (path.isAbsolute(link) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
                throw new Error("external_dependency_symlink");
              }
            }
            return true;
          },
        });
        // pnpm's executable wrappers may embed their original node_modules path.
        const binPath = path.join(temporary, ".bin");
        if (fs.existsSync(binPath)) {
          for (const file of fs.readdirSync(binPath)) {
            const entry = path.join(binPath, file);
            if (!fs.lstatSync(entry).isFile()) continue;
            const script = fs.readFileSync(entry, "utf8");
            if (script.includes(source)) fs.writeFileSync(entry, script.replaceAll(source, target));
          }
        }
        fs.renameSync(temporary, target);
        return true;
      } catch {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  } catch {
    // Reuse is optional: missing/stale installs fall back to the agent's normal install.
  }
  return false;
}
