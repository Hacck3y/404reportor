import Anthropic from '@anthropic-ai/sdk';
import { maskSecret, slugify } from './parser.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_MODEL = DEFAULT_GEMINI_MODEL;
export const REPORT_TYPES = new Set(['htb', 'ctf', 'pentest', 'cpts', 'oscp']);
export const AI_PROVIDERS = new Set(['auto', 'google', 'anthropic']);

const SYSTEM_PROMPT = `You are an expert penetration tester and technical writer with 10+ years experience.
You write clear, professional cybersecurity reports that are both technically accurate
and readable by non-technical stakeholders. You NEVER fabricate information -
if something isn't in the notes, you say it wasn't documented. You format reports
in clean Markdown with proper sections. For OSCP/CPTS style reports you follow
the official exam report structure exactly.`;

export async function createReport(options) {
  const reportType = normalizeReportType(options.reportType);
  const provider = normalizeProvider(options.provider);
  const model = options.model || (provider === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_GEMINI_MODEL);

  if (options.useAi && options.apiKey) {
    try {
      const generator = provider === 'anthropic' ? generateReportWithClaude : generateReportWithGemini;
      const markdown = await generator({
        parsed: options.parsed,
        imageAnalysis: options.imageAnalysis || {},
        reportType,
        apiKey: options.apiKey,
        model
      });
      const redacted = redactKnownSecrets(markdown, options.parsed);
      return {
        markdown: redacted,
        source: provider === 'anthropic' ? 'claude' : 'gemini',
        model,
        stats: summarizeMarkdown(redacted)
      };
    } catch (error) {
      const fallback = generateFallbackReport({
        parsed: options.parsed,
        imageAnalysis: options.imageAnalysis || {},
        reportType
      });
      return {
        markdown: fallback,
        source: 'fallback',
        model,
        warning: `${provider === 'anthropic' ? 'Claude' : 'Gemini'} generation failed, local fallback used: ${error.message}`,
        stats: summarizeMarkdown(fallback)
      };
    }
  }

  const fallback = generateFallbackReport({
    parsed: options.parsed,
    imageAnalysis: options.imageAnalysis || {},
    reportType
  });

  return {
    markdown: fallback,
    source: 'fallback',
    model: null,
    stats: summarizeMarkdown(fallback)
  };
}

export async function generateReportWithClaude({ parsed, imageAnalysis, reportType, apiKey, model = DEFAULT_ANTHROPIC_MODEL }) {
  const client = new Anthropic({ apiKey });
  const prompt = buildReportPrompt({ parsed, imageAnalysis, reportType });

  const response = await client.messages.create({
    model,
    max_tokens: 12000,
    temperature: 0.2,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  });

  const markdown = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!markdown) throw new Error('Claude returned an empty report.');
  return markdown;
}

export async function generateReportWithGemini({ parsed, imageAnalysis, reportType, apiKey, model = DEFAULT_GEMINI_MODEL }) {
  const prompt = buildReportPrompt({ parsed, imageAnalysis, reportType });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${geminiModelPath(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 12000
      }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`Gemini API request failed: ${message}`);
  }

  const markdown = extractGeminiText(payload);
  if (!markdown) throw new Error('Gemini returned an empty report.');
  return stripMarkdownFences(markdown);
}

export function buildReportPrompt({ parsed, imageAnalysis, reportType }) {
  const parsedSummary = {
    metadata: parsed.metadata,
    machineName: parsed.machineName,
    stats: parsed.stats,
    services: parsed.services,
    commands: parsed.commands,
    credentials: parsed.credentials.map((credential) => ({
      ...credential,
      secret: credential.secret ? '[present in notes]' : ''
    })),
    cves: parsed.cves,
    flags: parsed.flags.map((flag) => ({
      ...flag,
      value: flag.value ? '[present in notes]' : ''
    })),
    tools: parsed.tools,
    timeline: parsed.timeline
  };

  return [
    `Section 1: Report type and metadata`,
    JSON.stringify({ reportType, metadata: parsed.metadata, machineName: parsed.machineName }, null, 2),
    '',
    `Section 2: Full parsed main.md content`,
    'Parsed summary:',
    JSON.stringify(parsedSummary, null, 2),
    '',
    'Raw notes:',
    '```markdown',
    parsed.original,
    '```',
    '',
    `Section 3: Image analysis JSON`,
    '```json',
    JSON.stringify(imageAnalysis || {}, null, 2),
    '```',
    '',
    `Section 4: Instruction block`,
    buildInstructionBlock(reportType)
  ].join('\n');
}

export function generateFallbackReport({ parsed, imageAnalysis = {}, reportType = 'pentest' }) {
  const findings = deriveFindings(parsed, imageAnalysis);
  const highestSeverity = getHighestSeverity(findings);
  const reportTitle = `${typeLabel(reportType)} Report: ${parsed.machineName}`;
  const metadata = parsed.metadata;
  const attackPath = deriveAttackPath(parsed);

  return [
    `# ${reportTitle}`,
    '',
    `**Overall Severity:** ${highestSeverity}`,
    '',
    '## Executive Summary',
    '',
    buildExecutiveSummary(parsed, findings, reportType),
    '',
    '## Target Information',
    '',
    markdownTable(
      ['Field', 'Value'],
      [
        ['Target', metadata.target || 'Not documented'],
        ['Machine / Hostname', parsed.machineName || 'Not documented'],
        ['Operating System', metadata.os || 'Not documented'],
        ['Difficulty', metadata.difficulty || 'Not documented'],
        ['Platform', metadata.platform || inferPlatform(metadata.machine) || 'Not documented'],
        ['Report Date', metadata.date || 'Not documented']
      ]
    ),
    '',
    '## Timeline',
    '',
    buildTimelineTable(parsed),
    '',
    '## Attack Narrative',
    '',
    buildAttackNarrative(parsed, attackPath),
    '',
    '## Technical Findings',
    '',
    findings.map((finding, index) => renderFinding(finding, index + 1)).join('\n\n'),
    '',
    '## Exploitation Steps',
    '',
    renderExploitationSteps(parsed),
    '',
    '## Credentials',
    '',
    renderCredentials(parsed),
    '',
    '## Flags / Proof',
    '',
    renderFlags(parsed, imageAnalysis),
    '',
    '## Tools Used',
    '',
    renderTools(parsed),
    '',
    '## Recommendations Summary',
    '',
    renderRecommendations(findings),
    '',
    '## Appendix: Raw Notes',
    '',
    fence(parsed.original || 'No raw notes were provided.', 'markdown')
  ].join('\n');
}

export function summarizeMarkdown(markdown) {
  const text = String(markdown || '');
  const words = text.replace(/```[\s\S]*?```/g, ' ').match(/\b[\w'-]+\b/g) || [];
  const sections = text.match(/^#{1,3}\s+/gm) || [];
  const findings = text.match(/\*\*Severity:\*\*\s*(Critical|High|Medium|Low|Info)\b/gi) || [];
  return {
    words: words.length,
    sections: sections.length,
    findings: findings.length,
    severityCounts: countSeverities(text)
  };
}

export function countSeverities(markdown) {
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  const matches = String(markdown || '').matchAll(/\*\*Severity:\*\*\s*(Critical|High|Medium|Low|Info)\b/g);
  for (const match of matches) {
    const severity = match[1];
    if (Object.hasOwn(counts, severity)) counts[severity] += 1;
  }
  return counts;
}

function buildInstructionBlock(reportType) {
  return `Generate a complete ${reportType} report from the above notes.

REPORT MUST INCLUDE (adapt sections to report type):
1. Executive Summary (2-3 sentences, non-technical)
2. Target Information table (IP, hostname, OS, difficulty, date)
3. Attack Narrative - story-form walkthrough of the full compromise chain
4. Technical Findings - for each vulnerability found:
   - Finding name
   - Severity (Critical/High/Medium/Low/Info)
   - Description
   - Steps to reproduce (numbered, with exact commands)
   - Evidence (reference images by filename)
   - Remediation recommendation
5. Exploitation Steps - step-by-step with exact commands used,
   outputs trimmed to relevant lines
6. Flags / Proof (user.txt, root.txt, screenshots)
7. Tools Used (table: tool, version/source, purpose)
8. Recommendations Summary
9. Appendix - full raw command outputs if lengthy

RULES:
- Extract ALL commands from the notes and present them in code blocks
- Infer OS, services, and attack vectors from the commands used
- If credentials were found, document them in a Credentials table (censor last 2 chars)
- Identify the CVE or technique name for each vulnerability
- Timeline: infer order of operations from the notes and present as a table
- Severity ratings follow CVSS v3 logic
- Keep the Attack Narrative engaging and readable
- Flag values: show only first 4 chars + ***
- DO NOT invent steps not evidenced in the notes
- Output clean Markdown only, no preamble`;
}

function deriveFindings(parsed, imageAnalysis) {
  const text = parsed.original.toLowerCase();
  const findings = [];

  const add = (finding) => {
    if (findings.some((item) => item.name === finding.name)) return;
    findings.push({
      ...finding,
      commands: relevantCommands(parsed, finding.keywords || []),
      evidence: relevantImages(imageAnalysis, finding.imageCategories || [])
    });
  };

  if (/anonymous\s+bind|anon\s+bind|ldapsearch|ldap:\/\//i.test(parsed.original)) {
    add({
      name: 'LDAP Enumeration Exposed Sensitive Directory Data',
      severity: /anonymous\s+bind|anon\s+bind/i.test(parsed.original) ? 'High' : 'Medium',
      technique: 'LDAP enumeration',
      keywords: ['ldap', 'ldapsearch', 'anonymous', 'anon bind'],
      imageCategories: ['recon'],
      description: 'The notes document LDAP enumeration that exposed useful account or directory information.',
      remediation: 'Disable anonymous LDAP binds, restrict directory queries to authenticated users, and remove sensitive data from account attributes.'
    });
  }

  if (parsed.credentials.length > 0 || /\bpassword\b|\bcredential\b|\bcreds\b/i.test(parsed.original)) {
    add({
      name: 'Credential Disclosure in Assessment Notes',
      severity: parsed.credentials.length > 0 ? 'High' : 'Medium',
      technique: 'Credential discovery',
      keywords: ['password', 'credential', 'creds', '-p ', 'hash'],
      imageCategories: ['exploit', 'privesc', 'proof'],
      description: 'Credentials, hashes, or password material were documented during the attack path.',
      remediation: 'Rotate exposed credentials, remove passwords from descriptions or configuration values, and enforce least-privilege access.'
    });
  }

  if (/tightvnc|vncpwd|vnc/i.test(text)) {
    add({
      name: 'Recoverable VNC Password Material',
      severity: 'High',
      technique: 'Insecure credential storage',
      keywords: ['vnc', 'tightvnc', 'vncpwd', 'registry'],
      imageCategories: ['privesc'],
      description: 'The notes reference VNC password material that could be recovered and reused.',
      remediation: 'Remove stored VNC passwords, rotate affected credentials, and prevent local users from reading sensitive registry or configuration locations.'
    });
  }

  if (/ad recycle bin|deleted user|attribute|arksvc/i.test(parsed.original)) {
    add({
      name: 'Sensitive Active Directory Attribute Exposure',
      severity: 'Critical',
      technique: 'Active Directory data exposure',
      keywords: ['recycle', 'deleted user', 'attribute', 'arksvc', 'active directory'],
      imageCategories: ['privesc', 'proof'],
      description: 'The notes document Active Directory data exposure that contributed to privilege escalation.',
      remediation: 'Audit delegated AD permissions, clear sensitive attributes, monitor access to deleted objects, and restrict privileged group membership.'
    });
  }

  if (/gobuster|ffuf|dirsearch|\/admin|\/uploads/i.test(parsed.original)) {
    add({
      name: 'Discoverable Web Paths',
      severity: 'Medium',
      technique: 'Web content discovery',
      keywords: ['gobuster', 'ffuf', 'dirsearch', 'admin', 'uploads'],
      imageCategories: ['recon'],
      description: 'Directory enumeration identified web paths that may reveal administrative or restricted functionality.',
      remediation: 'Remove unused paths, enforce authentication and authorization checks, and avoid exposing sensitive directories.'
    });
  }

  for (const cve of parsed.cves) {
    add({
      name: `${cve} Referenced in Notes`,
      severity: 'High',
      technique: cve,
      keywords: [cve],
      imageCategories: ['exploit'],
      description: `${cve} was referenced in the notes and should be validated against the affected service version.`,
      remediation: 'Apply vendor patches, disable vulnerable functionality, and verify the fix with a targeted retest.'
    });
  }

  if (findings.length === 0) {
    findings.push({
      name: 'Insufficiently Documented Finding',
      severity: 'Info',
      technique: 'Documentation gap',
      commands: parsed.commands.slice(0, 3),
      evidence: [],
      description: 'The notes do not contain enough explicit vulnerability evidence to derive a confirmed finding.',
      remediation: 'Capture the affected service, exact weakness, reproduction commands, evidence, and remediation for each confirmed issue.'
    });
  }

  return findings;
}

function buildExecutiveSummary(parsed, findings, reportType) {
  const serviceText = parsed.services.length > 0
    ? `${parsed.services.length} open service${parsed.services.length === 1 ? '' : 's'}`
    : 'the documented target services';
  const severity = getHighestSeverity(findings);
  const type = typeLabel(reportType).toLowerCase();
  return `This ${type} summarizes the documented compromise path for ${parsed.machineName}. The notes show assessment activity against ${serviceText}, resulting in ${findings.length} finding${findings.length === 1 ? '' : 's'} with an overall severity of ${severity}. Any missing details are marked as not documented rather than inferred beyond the available evidence.`;
}

function buildAttackNarrative(parsed, attackPath) {
  const sections = parsed.sections.map((section) => section.title).filter(Boolean);
  const commandCount = parsed.commands.length;
  const services = parsed.services.map((service) => `${service.port}/${service.protocol} ${service.service}`).join(', ');

  const parts = [];
  parts.push(`The assessment began with the documented reconnaissance notes${services ? `, which identified ${services}` : ''}.`);
  if (sections.length > 0) parts.push(`The workflow then moved through ${sections.slice(0, 6).join(' -> ')}.`);
  if (commandCount > 0) parts.push(`${commandCount} command${commandCount === 1 ? '' : 's'} were captured and preserved in the exploitation steps for reproducibility.`);
  if (parsed.credentials.length > 0) parts.push('Credential material was discovered during the process and is masked in this report.');
  if (parsed.flags.length > 0) parts.push('Proof artifacts were documented and are summarized in the Flags / Proof section.');
  parts.push(`Observed attack path: ${attackPath}.`);
  return parts.join(' ');
}

function buildTimelineTable(parsed) {
  const rows = parsed.timeline.slice(0, 20).map((item) => [
    String(item.order),
    item.type,
    item.title,
    trimForTable(item.detail, 120),
    String(item.line)
  ]);

  if (rows.length === 0) return 'No timeline entries were parsed from the notes.';
  return markdownTable(['#', 'Type', 'Stage', 'Detail', 'Line'], rows);
}

function renderFinding(finding, index) {
  const commands = finding.commands.length > 0
    ? finding.commands.slice(0, 4).map((command, commandIndex) => `${commandIndex + 1}. ${fence(withOutput(command), 'bash')}`).join('\n')
    : 'No exact reproduction command was documented for this finding.';

  const evidence = finding.evidence.length > 0
    ? finding.evidence.map((item) => `- ${item}`).join('\n')
    : '- No screenshot evidence was mapped to this finding.';

  return [
    `### ${index}. ${finding.name}`,
    '',
    `**Severity:** ${finding.severity}`,
    '',
    `**Technique:** ${finding.technique || 'Not documented'}`,
    '',
    `**Description:** ${finding.description}`,
    '',
    '**Steps to Reproduce:**',
    '',
    commands,
    '',
    '**Evidence:**',
    '',
    evidence,
    '',
    `**Remediation:** ${finding.remediation}`
  ].join('\n');
}

function renderExploitationSteps(parsed) {
  if (parsed.commands.length === 0) return 'No commands were documented.';
  return parsed.commands
    .map((command, index) => [
      `### Step ${index + 1}: ${command.section}`,
      '',
      fence(withOutput(command), inferFenceLanguage(command.command))
    ].join('\n'))
    .join('\n\n');
}

function renderCredentials(parsed) {
  if (parsed.credentials.length === 0) return 'No credentials were parsed from the notes.';

  return markdownTable(
    ['Type', 'Username', 'Secret', 'Context', 'Line'],
    parsed.credentials.map((credential) => [
      credential.type,
      credential.username || 'Not documented',
      credential.secret ? maskSecret(credential.secret) : 'Not documented',
      trimForTable(credential.context, 90),
      String(credential.line || '')
    ])
  );
}

function renderFlags(parsed, imageAnalysis) {
  const rows = parsed.flags.map((flag) => [
    flag.type,
    flag.value ? maskSecret(flag.value, { mode: 'flag' }) : 'Documented, value not captured',
    flag.section,
    String(flag.line || '')
  ]);

  const proofImages = Object.entries(imageAnalysis)
    .filter(([, analysis]) => analysis.category === 'proof')
    .map(([filename, analysis]) => `- ${filename}: ${analysis.label || 'Proof screenshot'}`);

  const parts = [];
  parts.push(rows.length > 0 ? markdownTable(['Type', 'Value', 'Section', 'Line'], rows) : 'No flag values were parsed from the notes.');
  if (proofImages.length > 0) {
    parts.push('');
    parts.push('Proof screenshots:');
    parts.push(proofImages.join('\n'));
  }
  return parts.join('\n');
}

function renderTools(parsed) {
  if (parsed.tools.length === 0) return 'No tools were parsed from command lines.';
  return markdownTable(
    ['Tool', 'Count', 'Purpose'],
    parsed.tools.map((tool) => [tool.name, String(tool.count), tool.purpose])
  );
}

function renderRecommendations(findings) {
  return findings
    .map((finding) => `- **${finding.name}:** ${finding.remediation}`)
    .join('\n');
}

function relevantCommands(parsed, keywords) {
  if (!keywords || keywords.length === 0) return parsed.commands.slice(0, 3);
  const lowerKeywords = keywords.map((keyword) => keyword.toLowerCase());
  return parsed.commands.filter((command) => {
    const haystack = `${command.command}\n${command.output}\n${command.section}`.toLowerCase();
    return lowerKeywords.some((keyword) => haystack.includes(keyword));
  });
}

function relevantImages(imageAnalysis, categories) {
  return Object.entries(imageAnalysis)
    .filter(([, analysis]) => categories.includes(analysis.category))
    .map(([filename, analysis]) => `${filename} (${analysis.label || analysis.category})`);
}

function deriveAttackPath(parsed) {
  const hints = [];
  const text = parsed.original.toLowerCase();
  if (/ldap|active directory|ad /.test(text)) hints.push('LDAP/AD Enumeration');
  if (/gobuster|ffuf|web|http/.test(text)) hints.push('Web Enumeration');
  if (/password|creds?|credential|hash/.test(text)) hints.push('Credential Discovery');
  if (/evil-winrm|ssh|shell|foothold/.test(text)) hints.push('Initial Access');
  if (/vnc|registry|tightvnc|vncpwd/.test(text)) hints.push('Stored Credential Recovery');
  if (/privesc|privilege|root|system|administrator|recycle bin/.test(text)) hints.push('Privilege Escalation');
  if (hints.length === 0 && parsed.sections.length > 0) return parsed.sections.map((section) => section.title).slice(0, 6).join(' -> ');
  return hints.length > 0 ? [...new Set(hints)].join(' -> ') : 'Not fully documented';
}

function getHighestSeverity(findings) {
  const order = ['Critical', 'High', 'Medium', 'Low', 'Info'];
  for (const severity of order) {
    if (findings.some((finding) => finding.severity === severity)) return severity;
  }
  return 'Info';
}

function redactKnownSecrets(markdown, parsed) {
  let output = markdown;
  for (const credential of parsed.credentials) {
    if (credential.secret) output = replaceAllLiteral(output, credential.secret, maskSecret(credential.secret));
  }
  for (const flag of parsed.flags) {
    if (flag.value) output = replaceAllLiteral(output, flag.value, maskSecret(flag.value, { mode: 'flag' }));
  }
  return output;
}

function replaceAllLiteral(input, search, replacement) {
  if (!search || search.length < 3) return input;
  return input.split(search).join(replacement);
}

function markdownTable(headers, rows) {
  const safeHeaders = headers.map(escapeCell);
  const safeRows = rows.map((row) => row.map(escapeCell));
  return [
    `| ${safeHeaders.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...safeRows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');
}

function escapeCell(value) {
  return String(value ?? 'Not documented')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim() || 'Not documented';
}

function fence(value, language = '') {
  const content = String(value || '').replace(/```/g, '` ` `');
  return `~~~${language}\n${content}\n~~~`;
}

function withOutput(command) {
  return command.output ? `${command.command}\n${command.output}` : command.command;
}

function inferFenceLanguage(command) {
  if (/powershell|evil-winrm|winrm|Get-|Set-|Invoke-/i.test(command)) return 'powershell';
  if (/python|\.py\b/i.test(command)) return 'python';
  return 'bash';
}

function normalizeReportType(type) {
  const normalized = String(type || 'pentest').toLowerCase();
  return REPORT_TYPES.has(normalized) ? normalized : 'pentest';
}

function normalizeProvider(provider) {
  const normalized = String(provider || 'google').toLowerCase();
  if (normalized === 'gemini') return 'google';
  if (AI_PROVIDERS.has(normalized)) return normalized === 'auto' ? 'google' : normalized;
  return 'google';
}

function extractGeminiText(payload) {
  return (payload?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function geminiModelPath(model) {
  const clean = String(model || DEFAULT_GEMINI_MODEL).replace(/^models\//, '');
  return `models/${encodeURIComponent(clean)}`;
}

function stripMarkdownFences(markdown) {
  const trimmed = String(markdown || '').trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function typeLabel(type) {
  switch (normalizeReportType(type)) {
    case 'htb':
      return 'HTB Machine';
    case 'ctf':
      return 'CTF Writeup';
    case 'cpts':
      return 'CPTS-Style';
    case 'oscp':
      return 'OSCP-Style';
    case 'pentest':
    default:
      return 'Penetration Test';
  }
}

function inferPlatform(machine) {
  const value = String(machine || '').toLowerCase();
  if (value.includes('htb')) return 'Hack The Box';
  if (value.includes('tryhackme') || value.includes('thm')) return 'TryHackMe';
  return '';
}

function trimForTable(value, maxLength) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean || 'Not documented';
  return `${clean.slice(0, maxLength - 3)}...`;
}
