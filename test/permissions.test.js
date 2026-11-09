const env = require("./helpers/env").sandbox();
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const perms = require("../src/sessions/permissions");
const { mutate, load, now } = require("../src/core/data");

const REPO = path.join(__dirname, "..");
const bash = (command, cwd = env.root) => perms.classify("Bash", { command }, cwd).kind;

test("reading, searching and editing ordinary files pass on their own", () => {
  assert.equal(perms.classify("Read", { file_path: path.join(env.root, "src/app.js") }).kind, "allow");
  assert.equal(perms.classify("Grep", { path: env.root }).kind, "allow");
  assert.equal(perms.classify("Edit", { file_path: path.join(env.root, "src/app.js") }).kind, "allow");
  assert.equal(perms.classify("Write", { file_path: "/somewhere/else/file.txt" }).kind, "allow");
  assert.equal(perms.classify("Read", { file_path: path.join(env.root, ".env.example") }).kind, "allow");
});

test("files with secrets are asked for with the dedicated tools", () => {
  for (const f of [".env", ".env.local", "api/.env.production", "certs/server.pem", "keys/deploy.key", ".mcp.json", "credentials.json", ".credentials.json", "/home/u/.aws/credentials"]) {
    assert.equal(perms.classify("Read", { file_path: path.join(env.root, f) }).kind, "ask", f);
  }
  assert.equal(perms.classify("Edit", { file_path: path.join(env.root, ".env") }).kind, "ask");
  assert.equal(perms.classify("Write", { file_path: "C:\\work\\api\\.env" }).kind, "ask");
});

test("shell commands that dump secrets are asked for", () => {
  assert.equal(bash("cat .env"), "ask");
  assert.equal(bash("grep TOKEN api/.env.local"), "ask");
  assert.equal(bash("echo $(cat .env)"), "ask");
  assert.equal(bash("head -5 .mcp.json"), "ask");
  assert.equal(bash("cat .env.example"), "allow");
});

test("ordinary development commands pass on their own", () => {
  for (const c of ["ls -la", "npm test", "php artisan test --parallel", "node scripts/board.js list", "git status", "git log --oneline -5", "git diff HEAD~1", "git checkout main", "git stash list", "git tag", "git tag -l", "gh pr view 12", "curl -s https://example.com", "launchctl print gui/501/x", "some-unknown-tool --flag", "sleep 5 && echo done"]) {
    assert.equal(bash(c), "allow", c);
  }
});

test("protected git and gh operations need an order", () => {
  for (const c of ["git commit -m wip", "git push", "git merge develop", "git tag v1.2.3", "git reset --hard", "git stash", "git rebase main", "git checkout -- .", "git checkout .", "ls && git push origin main", "gh pr merge 12", "gh api -X POST repos/x/y/issues", "gh variable list", "gh secret set X", "gh workflow run deploy"]) {
    assert.equal(bash(c), "protected", c);
  }
  const commit = perms.classify("Bash", { command: "git commit -m x" }, env.root);
  assert.equal(commit.git, "commit");
  assert.equal(perms.classify("Bash", { command: "gh pr merge 3" }, env.root).git, "merge");
  assert.equal(perms.classify("Bash", { command: "git rebase main" }, env.root).git, null);
});

test("commit, push and pull in the board repo pass on their own", () => {
  assert.equal(bash("git commit -m x", REPO), "allow");
  assert.equal(bash("git push", REPO), "allow");
  assert.equal(bash(`git -C ${REPO} commit -m x`), "allow");
  assert.equal(bash(`cd ${REPO} && git push`), "allow");
  assert.equal(bash("git reset --hard", REPO), "protected");
});

test("cloud tooling: reads pass, the rest and secret reads are protected", () => {
  assert.equal(bash("aws ec2 describe-instances --region eu-west-1"), "allow");
  assert.equal(bash("aws --profile x deploy list-deployments"), "allow");
  assert.equal(bash("aws s3 cp a s3://b"), "protected");
  assert.equal(bash("aws secretsmanager get-secret-value --secret-id x"), "protected");
  assert.equal(bash("aws ssm get-parameters --names x"), "protected");
  assert.equal(bash("terraform apply"), "protected");
});

test("ssh passes when it only reads and stops when it changes the server", () => {
  assert.equal(bash('ssh beta "ls -la /var/www"'), "allow");
  assert.equal(bash('ssh beta "tail -n 100 storage/logs/laravel.log > /tmp/out.txt"'), "allow");
  assert.equal(bash("ssh -N -L 8000:localhost:8000 mac"), "allow");
  assert.equal(bash('ssh beta "sudo systemctl restart php-fpm"'), "protected");
  assert.equal(bash('ssh beta "php artisan migrate --force"'), "protected");
  assert.equal(bash('ssh beta "echo x > /var/www/.env"'), "protected");
  assert.equal(bash(`ssh beta "php artisan tinker --execute='User::find(1)->delete()'"`), "protected");
  assert.equal(bash(`ssh beta "php artisan tinker --execute='User::count()'"`), "allow");
});

test("remote database access passes for reads and stops for writes", () => {
  assert.equal(bash(`ssh beta "mysql -e 'select count(*) from users'"`), "allow");
  assert.equal(bash(`ssh beta "mysql -e 'delete from users where id = 1'"`), "protected");
  assert.equal(bash("mysql -h db.example.com -e 'select 1'"), "allow");
  assert.equal(bash("mysql -h db.example.com -e 'update users set x = 1'"), "protected");
  assert.equal(bash("mysqldump -h db.example.com app"), "protected");
  assert.equal(bash("mysql -u root -e 'drop table x'"), "allow");
  fs.writeFileSync(path.join(env.root, "q.sql"), "UPDATE users SET a = 1;");
  assert.equal(bash(`ssh beta "mysql app" < q.sql`), "protected");
});

test("uploads with scp stop unless they go to /tmp", () => {
  assert.equal(bash("scp build.zip beta:/var/www/"), "protected");
  assert.equal(bash("scp build.zip beta:/tmp/"), "allow");
  assert.equal(bash("scp beta:/var/log/x.log ./"), "allow");
});

test("house rules: broad rm -r, taskkill by name and npm publish are asked", () => {
  assert.equal(bash("rm -rf /"), "ask");
  assert.equal(bash("rm -rf ~"), "ask");
  assert.equal(bash("rm -rf ."), "ask");
  assert.equal(bash("rm -rf ./build"), "allow");
  assert.equal(bash("rm file.txt"), "allow");
  assert.equal(bash("taskkill /IM node.exe /F"), "ask");
  assert.equal(bash("taskkill /PID 1234 /F"), "allow");
  assert.equal(bash('powershell -Command "taskkill /IM claude.exe"'), "ask");
  assert.equal(bash("npm publish"), "ask");
});

test("Jira writes: comments are protected, assignments and other edits pass", () => {
  assert.equal(bash('node scripts/jira-write.js comment WEB-1 "hola"'), "protected");
  assert.equal(bash("node scripts/jira-write.js assign WEB-1"), "allow");
  assert.equal(bash("node scripts/jira-write.js transition WEB-1 start"), "allow");
  assert.equal(perms.classify("mcp__jira__addCommentToJiraIssue", {}).kind, "protected");
  assert.equal(perms.classify("mcp__jira__transitionJiraIssue", {}).kind, "allow");
  assert.equal(perms.classify("mcp__jira__getJiraIssue", {}).kind, "allow");
});

test("other tools: Sentry updates protected, Artifacts publishing asked, the rest allowed", () => {
  assert.equal(perms.classify("mcp__sentry__update_issue", {}).kind, "protected");
  assert.equal(perms.classify("mcp__sentry__search_issues", {}).kind, "allow");
  assert.equal(perms.classify("Artifact", { action: "publish" }).kind, "ask");
  assert.equal(perms.classify("Artifact", {}).kind, "ask");
  assert.equal(perms.classify("Artifact", { action: "read" }).kind, "allow");
  assert.equal(perms.classify("mcp__playwright__browser_click", {}).kind, "allow");
  assert.equal(perms.classify("SomeFutureTool", {}).kind, "allow");
  assert.equal(perms.classify("Bash", {}).kind, "allow");
});

test("segments splits on shell operators but not inside quotes", () => {
  assert.deepEqual(perms.segments("a && b || c; d | e"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(perms.segments(`echo "a && b"; ls`), [`echo "a && b"`, "ls"]);
  assert.deepEqual(perms.segments("echo $(git push)"), ["echo", "git push"]);
});

test("check: protected actions pass with a recent deployment order for that session", () => {
  const conversation = "11111111-2222-4333-8444-555555555555";
  fs.writeFileSync(path.join(env.data, "sessions.json"), JSON.stringify({ areas: { wallet: { title: "Wallet", conversation } } }));
  const input = { session_id: conversation, tool_name: "Bash", tool_input: { command: "git push" }, cwd: env.root };
  mutate((d) => {
    d.deployments = [{ id: "dep-1", area: "wallet", status: "sent", at: now(), sentAt: now() }];
  });
  assert.deepEqual(perms.check(input), { decision: "allow" });
  mutate((d) => {
    d.deployments = [{ id: "dep-1", area: "wallet", status: "sent", at: "2020-01-01T00:00:00.000Z", sentAt: "2020-01-01T00:00:00.000Z" }];
  });
  const r = perms.check(input);
  assert.equal(r.decision, "wait");
  const p = load().permissions.find((x) => x.id === r.id);
  assert.equal(p.status, "pending");
  assert.equal(p.area, "wallet");
  assert.equal(p.protected, true);
  assert.deepEqual(perms.poll(r.id), { status: "pending", reason: null });
  assert.equal(perms.decide(r.id, "always", "ok"), true);
  assert.equal(load().permissionRules, undefined);
  assert.equal(perms.poll(r.id).status, "allowed");
});

test("check: an 'always' answer to an asked action becomes a rule", () => {
  const conversation = "11111111-2222-4333-8444-555555555555";
  const input = { session_id: conversation, tool_name: "Bash", tool_input: { command: "npm publish" }, cwd: env.root };
  const r = perms.check(input);
  assert.equal(r.decision, "wait");
  assert.equal(perms.decide(r.id, "always"), true);
  assert.deepEqual(load().permissionRules.map((x) => x.key), ["npm publish"]);
  assert.deepEqual(perms.check(input), { decision: "allow" });
  assert.equal(perms.removeRule("npm publish"), true);
  assert.equal(perms.check(input).decision, "wait");
});

test("check: a denied request reports denied with its reason", () => {
  const r = perms.check({ session_id: "x", tool_name: "Bash", tool_input: { command: "terraform destroy" }, cwd: env.root });
  assert.equal(r.decision, "wait");
  assert.equal(perms.decide(r.id, "deny", "no"), true);
  assert.deepEqual(perms.poll(r.id), { status: "denied", reason: "no" });
  assert.equal(perms.decide(r.id, "allow"), false);
  assert.deepEqual(perms.poll("perm-missing"), { status: "missing" });
});
