import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const secretRules = [
  {
    name: 'GitHub classic PAT',
    pattern: /\bghp_[A-Za-z0-9]{30,}\b/,
  },
  {
    name: 'GitHub fine-grained PAT',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  },
  {
    name: 'private key block',
    pattern:
      /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----\s+[A-Za-z0-9+/=\r\n]{40,}-----END \1-----/,
  },
];

const sensitiveAssignment = new RegExp(
  String.raw`^\s*(?:DB_PASSWORD|MAIL_API_KEY|SENSITIVE_DATA_KEY|RSA_PRIVATE_KEY|GITHUB_TOKEN|GH_TOKEN)\s*[:=]\s*["']?([^"'\r\n]+)`,
  'im'
);

const isSafePlaceholder = value => {
  const normalized = value
    .trim()
    .replace(/["',]$/, '')
    .trim();
  if (!normalized || /^\$\{[^}]+\}$/.test(normalized)) return true;
  return /^(?:change-me|example(?:[-_].*)?|test(?:[-_].*)?|your[-_].*|\[?redacted\]?|<.*>)$/i.test(
    normalized
  );
};

export const findSecretKinds = text => {
  if (typeof text !== 'string' || text.includes('\0')) return [];

  const findings = secretRules.filter(rule => rule.pattern.test(text)).map(rule => rule.name);
  const assignment = sensitiveAssignment.exec(text);
  if (assignment && !isSafePlaceholder(assignment[1])) {
    findings.push('non-placeholder sensitive assignment');
  }
  return [...new Set(findings)];
};

const listCandidateFiles = () => {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  return output.split('\0').filter(Boolean);
};

export const scanTrackedFiles = () => {
  const findings = [];
  for (const relativePath of listCandidateFiles()) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    let content;
    try {
      const buffer = fs.readFileSync(absolutePath);
      if (buffer.includes(0)) continue;
      content = buffer.toString('utf8');
    } catch (error) {
      findings.push({
        file: relativePath,
        kinds: [`unreadable tracked file (${error.code || 'error'})`],
      });
      continue;
    }

    const kinds = findSecretKinds(content);
    if (kinds.length > 0) findings.push({ file: relativePath, kinds });
  }
  return findings;
};

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const findings = scanTrackedFiles();
  if (findings.length > 0) {
    console.error('检测到待提交文件可能包含敏感信息：');
    for (const finding of findings) {
      console.error(`- ${finding.file}: ${finding.kinds.join(', ')}`);
    }
    console.error('未输出任何命中内容；请移除或改为明确占位符后重试。');
    process.exitCode = 1;
  } else {
    console.log('当前已跟踪和未忽略文件未发现已知敏感信息模式。');
  }
}
