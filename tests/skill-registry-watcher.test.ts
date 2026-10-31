import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const extensionUrl = pathToFileURL(join(import.meta.dirname, "..", "extensions", "skill-registry.ts")).href;

for (const code of ["ENOENT", "EMFILE"]) {
	test(`registered skill watcher survives asynchronous ${code} and preserves other roots`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "gentle-skill-watch-error-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			import { join, sep } from "node:path";
			const root = ${JSON.stringify(root)};
			const cwd = join(root, "workspace");
			const home = join(root, "home");
			process.env.HOME = home;
			process.env.USERPROFILE = home;
			delete process.env.GENTLE_PI_AGENTS_CHILD;
			delete process.env.GENTLE_PI_NO_SKILL_REGISTRY;
			const userRoot = join(home, ".codex", "skills");
			const assets = join(userRoot, "imagegen", "assets");
			const projectSkill = join(cwd, "skills", "local", "SKILL.md");
			const userSkill = join(userRoot, "imagegen", "SKILL.md");
			fs.mkdirSync(assets, { recursive: true });
			fs.mkdirSync(join(cwd, "skills", "local"), { recursive: true });
			fs.writeFileSync(projectSkill, "---\\nname: local\\ndescription: Initial project skill.\\n---\\n");
			fs.writeFileSync(userSkill, "---\\nname: imagegen\\ndescription: Initial user skill.\\n---\\n");
			const nativeWatch = fs.watch;
			let userWatcher;
			fs.watch = function (path, options, listener) {
				const watcher = nativeWatch(path, options, listener);
				if (path === userRoot && options?.recursive) userWatcher = watcher;
				return watcher;
			};
			syncBuiltinESMExports();
			const { default: skillRegistry, __testing } = await import(${JSON.stringify(extensionUrl)});
			const events = new Map();
			const commands = new Map();
			const notices = [];
			skillRegistry({
				on: (name, handler) => events.set(name, handler),
				registerCommand: (name, command) => commands.set(name, command),
				registerFlag: () => {},
				getFlag: () => false,
			});
			const ctx = { cwd, hasUI: true, ui: { notify: (message, level) => notices.push({ message, level }) } };
			const waitFor = async (predicate) => {
				// Must stay well below the parent's spawnSync timeout so a missed
				// outcome fails with this assertion instead of an opaque ETIMEDOUT.
				const deadline = Date.now() + 5000;
				while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
				assert.ok(predicate(), "timed out waiting for watcher outcome");
			};
			try {
				await events.get("session_start")(undefined, ctx);
				await __testing.startupSettled(); // Startup regeneration runs after session_start returns.
				assert.ok(userWatcher, "fixture must start the real recursive user watcher");
				const initialWatchers = __testing.activeWatcherCount();
				assert.equal(initialWatchers, 2);
				const code = ${JSON.stringify(code)};
				if (code === "ENOENT" && process.platform !== "darwin" && process.platform !== "win32") {
					// Force the transient missing-directory race at Node's real recursive
					// readdir boundary, after watcher creation, not in our refresh callback.
					// Older Node rescans the parent folder; Node 24.22+ resolves new files
					// via lstat and only readdirs a newly added directory, so trigger with
					// a directory and fail whichever readdir lands under assets.
					const nativeReaddir = fs.readdirSync;
					let reachedRescan = false;
					fs.readdirSync = function (path, options) {
						if (typeof path === "string" && (path === assets || path.startsWith(assets + sep))) {
							fs.readdirSync = nativeReaddir;
							reachedRescan = true;
							throw Object.assign(new Error("ENOENT: transient skill assets disappeared"), { code, syscall: "scandir", path });
						}
						return nativeReaddir(path, options);
					};
					fs.mkdirSync(join(assets, "trigger"));
					// The rescan race needs live recursive-watch events. Where the OS
					// cannot deliver them (an exhausted inotify budget, some WSL2
					// setups), waiting the full waitFor budget is pointless: settle
					// briefly for the natural race, then exercise the public error
					// listener directly, as the manual fallback below always did.
					const raceDeadline = Date.now() + 2000;
					while (!reachedRescan && Date.now() < raceDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
					fs.readdirSync = nativeReaddir;
					// Newer Node versions swallow rescan ENOENT themselves. Still
					// exercise our public error listener without requiring Node's bug.
					if (!notices.some(({ message, level }) => level === "warning" && message.includes(code))) {
						userWatcher.emit("error", Object.assign(new Error("ENOENT: skill watcher failed"), { code }));
					}
				} else {
					// Native Darwin/Windows recursion has no JS readdir boundary;
					// inject its public error event, as for asynchronous resource errors.
					setImmediate(() => userWatcher.emit("error", Object.assign(new Error(code + ": skill watcher failed"), { code })));
				}
				await waitFor(() => notices.some(({ message, level }) => level === "warning" && message.includes(code)));
				assert.equal(__testing.activeWatcherCount(), initialWatchers - 1, "only the failed root must stop");
				assert.ok(notices.some(({ message }) => message.includes("/skill-registry:refresh")));
				fs.writeFileSync(projectSkill, "---\\nname: local\\ndescription: Changed project skill.\\n---\\n");
				const registry = join(cwd, ".atl", "skill-registry.md");
				await waitFor(() => fs.readFileSync(registry, "utf8").includes("Changed project skill"));
				fs.writeFileSync(userSkill, "---\\nname: imagegen\\ndescription: Manually changed user skill.\\n---\\n");
				await commands.get("skill-registry:refresh").handler("", ctx);
				assert.match(fs.readFileSync(registry, "utf8"), /Manually changed user skill/);
			} finally {
				await events.get("session_shutdown")(undefined, ctx);
			}
			assert.equal(__testing.activeWatcherCount(), 0);
			await events.get("session_start")(undefined, ctx);
			await __testing.startupSettled();
			assert.equal(__testing.activeWatcherCount(), 2, "a later session must rewatch the failed root");
			await events.get("session_shutdown")(undefined, ctx);
			assert.equal(__testing.activeWatcherCount(), 0);
			console.log("SURVIVED ${code}");
		`], {
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
		});
		assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, new RegExp(`SURVIVED ${code}`));
	});
}

test("a replaced session's stale ctx never crashes the skill watcher", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-skill-watch-stale-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { join } from "node:path";
		const root = ${JSON.stringify(root)};
		const cwd = join(root, "workspace");
		const home = join(root, "home");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		delete process.env.GENTLE_PI_AGENTS_CHILD;
		delete process.env.GENTLE_PI_NO_SKILL_REGISTRY;
		const projectSkill = join(cwd, "skills", "local", "SKILL.md");
		fs.mkdirSync(join(cwd, "skills", "local"), { recursive: true });
		fs.writeFileSync(projectSkill, "---\\nname: local\\ndescription: Initial project skill.\\n---\\n");
		const crashes = [];
		process.on("uncaughtException", (error) => crashes.push(error.message));
		process.on("unhandledRejection", (error) => crashes.push(String(error?.message ?? error)));
		const nativeWatch = fs.watch;
		const watched = [];
		fs.watch = function (path, options, listener) {
			const watcher = nativeWatch(path, options, listener);
			watched.push({ watcher, listener });
			return watcher;
		};
		syncBuiltinESMExports();
		const { default: skillRegistry, __testing } = await import(${JSON.stringify(extensionUrl)});
		const events = new Map();
		skillRegistry({
			on: (name, handler) => events.set(name, handler),
			registerCommand: () => {},
			registerFlag: () => {},
			getFlag: () => false,
		});
		let stale = false;
		const staleError = "This extension ctx is stale after session replacement or reload.";
		const ctx = {
			cwd,
			hasUI: true,
			get ui() {
				if (stale) throw new Error(staleError);
				return { notify: () => {} };
			},
		};
		try {
			await events.get("session_start")(undefined, ctx);
			await __testing.startupSettled();
			assert.ok(watched.length > 0, "fixture must start a real skill watcher");
			// A skill change schedules a debounced refresh, then the session is replaced.
			fs.writeFileSync(projectSkill, "---\\nname: local\\ndescription: Changed project skill.\\n---\\n");
			watched[0].listener("change", "local/SKILL.md");
			await events.get("session_shutdown")(undefined, ctx);
			stale = true;
			// A late watcher error after replacement reaches the captured notifier.
			watched[0].watcher.emit("error", Object.assign(new Error("EMFILE: late watcher failure"), { code: "EMFILE" }));
			await new Promise((resolve) => setTimeout(resolve, 1500));
			assert.deepEqual(crashes, []);
			const registry = join(cwd, ".atl", "skill-registry.md");
			assert.doesNotMatch(fs.readFileSync(registry, "utf8"), /Changed project skill/, "a replaced session must not refresh");
			console.log("SURVIVED STALE CTX");
		} catch (error) {
			console.error(error);
			process.exit(1);
		}
	`], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
	});
	assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /SURVIVED STALE CTX/);
});
