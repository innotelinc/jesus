import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const repository = process.env.CI_REPOSITORY;
const branch = process.env.CI_DEFAULT_BRANCH;
const head = process.env.HEAD_SHA;
const shaPattern = /^[0-9a-f]{40}$/i;
// The workflow that runs this script is ci.yml in the standalone project and a
// ported name when the project lives inside a larger tree, so read the name
// from the run that is executing rather than assuming one. GitHub reports it
// as owner/repository/.github/workflows/<file>@<ref>.
function workflowFile() {
  const reference = process.env.GITHUB_WORKFLOW_REF ?? "";
  const separator = reference.lastIndexOf("@");
  const path = separator === -1 ? reference : reference.slice(0, separator);
  const name = path.split("/").pop();
  return name ? name : "ci.yml";
}

function ancestor(base) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function write(base, reason) {
  const output = { base, reason };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `base=${base}\nreason=${reason.replace(/[\r\n]/g, " ")}\n`,
    );
  }
  console.log(JSON.stringify(output));
}

if (!repository || !branch || !head || !shaPattern.test(head)) {
  write("", "Repository, default branch, or checked-out head is invalid");
} else {
  try {
    const response = execFileSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${repository}/actions/workflows/${encodeURIComponent(workflowFile())}/runs`,
        "-f",
        `branch=${branch}`,
        "-f",
        "event=push",
        "-f",
        "status=success",
        "-F",
        "per_page=100",
      ],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const runs = JSON.parse(response).workflow_runs;
    if (!Array.isArray(runs))
      throw new Error("GitHub returned no workflow run list");
    const base = runs.find(
      (run) =>
        run?.event === "push" &&
        run?.conclusion === "success" &&
        run?.head_branch === branch &&
        run?.head_repository?.full_name === repository &&
        typeof run?.head_sha === "string" &&
        shaPattern.test(run.head_sha) &&
        run.head_sha.toLowerCase() !== head.toLowerCase() &&
        ancestor(run.head_sha),
    )?.head_sha;
    if (base) write(base, "");
    else
      write(
        "",
        "No trusted successful CI push baseline is an ancestor of this head",
      );
  } catch {
    write("", "Could not read a successful CI push baseline from GitHub");
  }
}
