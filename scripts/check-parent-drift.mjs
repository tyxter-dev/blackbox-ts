import { appendFile, readFile, writeFile } from 'node:fs/promises';

const inventory = JSON.parse(
  await readFile(new URL('../docs/parity-inventory.json', import.meta.url), 'utf8'),
);

const reportPath = argument('--output');
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'blackbox-ts-parity-drift',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(process.env.GITHUB_TOKEN === undefined
    ? {}
    : { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
};
const apiRoot = `https://api.github.com/repos/${inventory.parent.repository}`;
const head = await githubJson(`${apiRoot}/commits/${inventory.parent.default_branch}`);
const currentCommit = head.sha;
const drifted = currentCommit !== inventory.parent.commit;
let comparison;
if (drifted) {
  comparison = await githubJson(
    `${apiRoot}/compare/${inventory.parent.commit}...${encodeURIComponent(inventory.parent.default_branch)}`,
  );
}
const report = {
  schema_version: 1,
  parent_repository: inventory.parent.repository,
  parent_default_branch: inventory.parent.default_branch,
  pinned_commit: inventory.parent.commit,
  current_commit: currentCommit,
  drifted,
  ahead_by: comparison?.ahead_by ?? 0,
  behind_by: comparison?.behind_by ?? 0,
  total_commits: comparison?.total_commits ?? 0,
  feature_catalog_changed:
    comparison?.files?.some((file) => file.filename === inventory.parent.feature_catalog) ?? false,
  commits:
    comparison?.commits?.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message.split('\n')[0],
      committed_at: commit.commit.committer?.date ?? commit.commit.author?.date ?? null,
    })) ?? [],
  files:
    comparison?.files?.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })) ?? [],
};
const markdown = renderMarkdown(report);
console.log(markdown);
if (reportPath !== undefined) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
}
if (drifted && process.argv.includes('--fail-on-drift')) process.exitCode = 1;

async function githubJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function renderMarkdown(report) {
  const lines = [
    '# Python parent drift report',
    '',
    `- Repository: \`${report.parent_repository}\``,
    `- Pinned: \`${report.pinned_commit}\``,
    `- Current \`${report.parent_default_branch}\`: \`${report.current_commit}\``,
    `- Drift: **${report.drifted ? 'detected' : 'none'}**`,
  ];
  if (report.drifted) {
    lines.push(
      `- Commits ahead: ${report.ahead_by}`,
      `- Feature catalog changed: ${report.feature_catalog_changed ? 'yes' : 'no'}`,
      '',
      '## Changed files',
      '',
      ...report.files.map(
        (file) => `- \`${file.path}\` (${file.status}, +${file.additions}/-${file.deletions})`,
      ),
      '',
      'Do not update the pinned commit automatically. Open an intentional parity-baseline PR, regenerate cross-language fixtures, and review every changed parent feature.',
    );
  }
  return lines.join('\n');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
