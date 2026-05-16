const KNOWN_METADATA_KEYS = new Map([
  ['target', 'target'],
  ['ip', 'target'],
  ['host', 'hostname'],
  ['hostname', 'hostname'],
  ['machine', 'machine'],
  ['box', 'machine'],
  ['name', 'machine'],
  ['os', 'os'],
  ['operating system', 'os'],
  ['difficulty', 'difficulty'],
  ['date', 'date'],
  ['client', 'client'],
  ['scope', 'scope'],
  ['author', 'author'],
  ['platform', 'platform']
]);

const COMMON_COMMANDS = new Set([
  'nmap',
  'masscan',
  'rustscan',
  'gobuster',
  'ffuf',
  'feroxbuster',
  'dirsearch',
  'nikto',
  'whatweb',
  'curl',
  'wget',
  'httpx',
  'ldapsearch',
  'smbclient',
  'smbmap',
  'enum4linux',
  'enum4linux-ng',
  'crackmapexec',
  'netexec',
  'rpcclient',
  'evil-winrm',
  'winrm',
  'ssh',
  'scp',
  'ftp',
  'telnet',
  'nc',
  'ncat',
  'socat',
  'rlwrap',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'php',
  'bash',
  'sh',
  'powershell',
  'pwsh',
  'cmd',
  'whoami',
  'id',
  'hostname',
  'ipconfig',
  'ifconfig',
  'ip',
  'netstat',
  'ss',
  'cat',
  'type',
  'more',
  'less',
  'ls',
  'dir',
  'find',
  'findstr',
  'grep',
  'sed',
  'awk',
  'strings',
  'file',
  'exiftool',
  'sudo',
  'su',
  'chmod',
  'chown',
  'cp',
  'mv',
  'tar',
  'unzip',
  '7z',
  'john',
  'hashcat',
  'hydra',
  'medusa',
  'sqlmap',
  'searchsploit',
  'msfconsole',
  'msfvenom',
  'linpeas.sh',
  'winpeas.exe',
  'peas',
  'bloodhound-python',
  'bloodhound',
  'neo4j',
  'kerbrute',
  'impacket-secretsdump',
  'secretsdump.py',
  'psexec.py',
  'wmiexec.py',
  'smbexec.py',
  'getnpusers.py',
  'getuserspns.py',
  'responder',
  'tcpdump',
  'wireshark',
  'snmpwalk',
  'onesixtyone',
  'showmount',
  'mount',
  'mysql',
  'psql',
  'redis-cli',
  'mongo',
  'xfreerdp',
  'rdesktop',
  'vncpwd'
]);

const IPV4_PATTERN =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

export function parseNotes(markdown, options = {}) {
  const source = normalizeNewlines(markdown);
  const lines = source.split('\n');
  const metadata = {};
  const sections = parseSections(lines);
  const commands = extractCommands(lines, sections);
  const credentials = extractCredentials(lines, sections, commands);
  const services = extractServices(lines);
  const cves = unique(source.match(/\bCVE-\d{4}-\d{4,7}\b/gi) || []).map((cve) => cve.toUpperCase());
  const flags = extractFlags(lines, sections);
  const ips = unique(source.match(IPV4_PATTERN) || []);
  const tools = extractTools(commands);

  for (const [index, line] of lines.entries()) {
    const meta = parseMetadataLine(line);
    if (!meta) continue;
    if (!metadata[meta.key]) metadata[meta.key] = meta.value;
    if (!metadata._lines) metadata._lines = {};
    if (!metadata._lines[meta.key]) metadata._lines[meta.key] = index + 1;
  }

  if (!metadata.target && ips.length > 0) metadata.target = ips[0];
  if (!metadata.date) metadata.date = formatDate(new Date());

  const machineName = deriveMachineName(metadata, options.defaultMachineName);
  const timeline = buildTimeline(sections, commands);

  const parsed = {
    original: source,
    lineCount: lines.length,
    metadata,
    machineName,
    sections,
    commands,
    credentials,
    services,
    cves,
    flags,
    ips,
    tools,
    timeline
  };

  parsed.stats = {
    sections: sections.length,
    commands: commands.length,
    credentials: credentials.length,
    services: services.length,
    cves: cves.length,
    flags: flags.length,
    tools: tools.length
  };

  return parsed;
}

export function maskSecret(value, options = {}) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw || /^\[?redacted\]?$/i.test(raw)) return '[REDACTED]';

  const mode = options.mode || 'credential';
  if (mode === 'flag') {
    return raw.length <= 4 ? `${raw[0] || '*'}***` : `${raw.slice(0, 4)}***`;
  }

  if (raw.length <= 2) return '*'.repeat(raw.length);
  return `${raw.slice(0, -2)}**`;
}

export function slugify(value, fallback = 'report') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeNewlines(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function parseSections(lines) {
  const sections = [];
  let current = null;

  for (const [index, line] of lines.entries()) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      current = {
        title: heading[2].trim(),
        level: heading[1].length,
        lineStart: index + 1,
        lineEnd: index + 1,
        lines: []
      };
      sections.push(current);
      continue;
    }

    if (!current) {
      current = {
        title: 'Notes',
        level: 1,
        lineStart: 1,
        lineEnd: index + 1,
        lines: []
      };
      sections.push(current);
    }

    current.lines.push(line);
    current.lineEnd = index + 1;
  }

  return sections
    .map((section) => ({
      ...section,
      content: section.lines.join('\n').trim()
    }))
    .filter((section) => section.title !== 'Notes' || section.content.length > 0);
}

function parseMetadataLine(line) {
  const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{1,40})\s*:\s*(.+?)\s*$/);
  if (!match) return null;
  const rawKey = match[1].trim().toLowerCase();
  const normalized = KNOWN_METADATA_KEYS.get(rawKey);
  if (!normalized) return null;
  return { key: normalized, value: match[2].trim() };
}

function extractCommands(lines, sections) {
  const commands = [];

  for (let index = 0; index < lines.length; index += 1) {
    const command = parseCommandLine(lines[index]);
    if (!command) continue;

    const output = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (/^#{1,6}\s+/.test(candidate)) break;
      if (parseCommandLine(candidate)) break;
      if (candidate.trim() === '' && output.length > 0) break;
      if (candidate.trim() === '' && output.length === 0) break;
      output.push(candidate);
    }

    const lineNumber = index + 1;
    const section = findSectionForLine(sections, lineNumber);
    commands.push({
      command,
      output: output.join('\n').trim(),
      line: lineNumber,
      section: section?.title || 'Notes',
      tool: getToolName(command)
    });
  }

  return commands;
}

function parseCommandLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^#{1,6}\s+/.test(trimmed)) return null;
  if (/^```/.test(trimmed)) return null;
  if (/^\/\//.test(trimmed)) return null;
  if (/^\d+\/(?:tcp|udp)\s+/i.test(trimmed)) return null;
  if (/\bEnumerator v\d/i.test(trimmed) || /^SMBMap\s+-\s+Samba\s+Share/i.test(trimmed)) return null;
  if (/^(found|got|open|closed|filtered|warning|error|note)\s*:/i.test(trimmed)) return null;

  const evilWinrm = trimmed.match(/\b(?:Evil-WinRM|\*Evil-WinRM\*)\s+PS>\s*(.+)$/i);
  if (evilWinrm) return evilWinrm[1].trim();

  const powershellPrompt = trimmed.match(/^(?:PS\s+)?[A-Z]:\\.*?>\s*(.+)$/i);
  if (powershellPrompt) return powershellPrompt[1].trim();

  const shellPrompt = trimmed.match(/^(?:\[[^\]]+\]\s*)?(?:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^\s]+|[$#>])\s+(.+)$/);
  if (shellPrompt) return shellPrompt[1].trim();

  const firstToken = trimmed.split(/\s+/)[0].replace(/^\.?\//, '').toLowerCase();
  if (COMMON_COMMANDS.has(firstToken)) return trimmed;

  if (/^(?:impacket-)?[a-z0-9_-]+\.py\b/i.test(firstToken)) return trimmed;
  if (/^(?:\.\/|\/)[A-Za-z0-9_./-]+\s+.+/.test(trimmed)) return trimmed;
  if (/^(?:\.\\|\\)[A-Za-z0-9_.\\-]+\.(?:exe|bat|cmd|ps1)(?:\s+.*)?$/i.test(trimmed)) return trimmed;
  if (/^(?:Invoke|Get|Set|New|Start|Stop|Restart|Remove|Add)-[A-Za-z0-9]+/.test(trimmed)) return trimmed;

  return null;
}

function extractCredentials(lines, sections, commands) {
  const credentials = [];

  const addCredential = (credential) => {
    const secret = cleanSecret(credential.secret || credential.password || credential.hash);
    const username = cleanSecret(credential.username || credential.user || '');
    if (!secret && !username) return;
    const key = `${username}|${secret}|${credential.type || 'credential'}|${credential.line}`;
    if (credentials.some((item) => item._key === key)) return;
    credentials.push({
      type: credential.type || 'credential',
      username,
      secret,
      context: credential.context || '',
      line: credential.line,
      section: credential.section || 'Notes',
      _key: key
    });
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const section = findSectionForLine(sections, lineNumber);

    const combined = line.match(/\b(?:user(?:name)?|login)\s*[:=]\s*([A-Za-z0-9._\\/@-]+).*?\b(?:pass(?:word)?|pwd|secret|hint)\b[^:=]*[:=]\s*([^\s'"`<>]+)/i);
    if (combined) {
      addCredential({
        type: 'username/password',
        username: combined[1],
        secret: combined[2],
        context: line.trim(),
        line: lineNumber,
        section: section?.title
      });
    }

    const userOnly = line.match(/\b(?:user(?:name)?|login)\s*[:=]\s*([A-Za-z0-9._\\/@-]+)/i);
    const secretOnly = line.match(/\b(?:pass(?:word)?|pwd|secret|token|api[_ -]?key|hash)\b[^:=]*[:=]\s*([^\s'"`<>]+)/i);
    if (secretOnly) {
      addCredential({
        type: /hash/i.test(line) ? 'hash' : 'secret',
        username: userOnly?.[1] || '',
        secret: secretOnly[1],
        context: line.trim(),
        line: lineNumber,
        section: section?.title
      });
    }
  }

  for (const item of commands) {
    const shortFlags = item.command.match(/(?:^|\s)-u\s+([^\s]+).*?(?:^|\s)-p\s+([^\s]+)/i);
    if (shortFlags) {
      addCredential({
        type: 'username/password',
        username: shortFlags[1],
        secret: shortFlags[2],
        context: item.command,
        line: item.line,
        section: item.section
      });
    }

    const longFlags = item.command.match(/(?:--user(?:name)?\s+|--user(?:name)?=)([^\s]+).*?(?:--pass(?:word)?\s+|--pass(?:word)?=)([^\s]+)/i);
    if (longFlags) {
      addCredential({
        type: 'username/password',
        username: longFlags[1],
        secret: longFlags[2],
        context: item.command,
        line: item.line,
        section: item.section
      });
    }
  }

  return credentials.map(({ _key, ...credential }) => credential);
}

function extractServices(lines) {
  const services = [];

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*(\d{1,5})\/(tcp|udp)\s+open\s+([^\s]+)\s*(.*)$/i);
    if (!match) continue;
    services.push({
      port: Number(match[1]),
      protocol: match[2].toLowerCase(),
      service: match[3],
      version: match[4].trim(),
      line: index + 1
    });
  }

  return services;
}

function extractFlags(lines, sections) {
  const flags = [];

  const addFlag = (flag) => {
    const key = `${flag.type}|${flag.value}|${flag.line}`;
    if (flags.some((item) => item._key === key)) return;
    flags.push({ ...flag, _key: key });
  };

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const section = findSectionForLine(sections, lineNumber);
    const trimmed = line.trim();

    const named = trimmed.match(/\b(user|root|system|admin)\s*(?:\.txt|flag|proof)\b\s*[:=]?\s*(.*)$/i);
    if (named) {
      const value = cleanSecret(named[2] || '');
      addFlag({
        type: named[1].toLowerCase(),
        value,
        context: trimmed,
        line: lineNumber,
        section: section?.title || 'Notes'
      });
    }

    const ctfFlag = trimmed.match(/\b([A-Za-z0-9_]{2,20}\{[^}]{4,}\})\b/);
    if (ctfFlag) {
      addFlag({
        type: 'ctf',
        value: ctfFlag[1],
        context: trimmed,
        line: lineNumber,
        section: section?.title || 'Notes'
      });
    }
  }

  return flags.map(({ _key, ...flag }) => flag);
}

function extractTools(commands) {
  const tools = [];

  for (const command of commands) {
    const name = getToolName(command.command);
    if (!name) continue;
    const existing = tools.find((tool) => tool.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.count += 1;
      existing.sections = unique([...existing.sections, command.section]);
      continue;
    }

    tools.push({
      name,
      purpose: guessToolPurpose(name),
      count: 1,
      sections: [command.section]
    });
  }

  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

function buildTimeline(sections, commands) {
  const timeline = [];

  for (const section of sections) {
    timeline.push({
      order: timeline.length + 1,
      type: 'section',
      title: section.title,
      detail: firstMeaningfulLine(section.content) || 'Section documented.',
      line: section.lineStart
    });
  }

  for (const command of commands) {
    timeline.push({
      order: timeline.length + 1,
      type: 'command',
      title: command.section,
      detail: command.command,
      line: command.line
    });
  }

  return timeline.sort((a, b) => a.line - b.line).map((item, index) => ({
    ...item,
    order: index + 1
  }));
}

function deriveMachineName(metadata, fallback = 'target') {
  const machine = metadata.machine || metadata.hostname || metadata.target || fallback;
  return String(machine).trim() || fallback;
}

function findSectionForLine(sections, lineNumber) {
  return sections.find((section) => lineNumber >= section.lineStart && lineNumber <= section.lineEnd);
}

function getToolName(command) {
  const tokens = String(command || '').trim().split(/\s+/);
  if (tokens.length === 0) return '';
  let token = tokens[0];
  if (token.toLowerCase() === 'sudo' && tokens[1]) token = tokens[1];
  if (token.toLowerCase() === 'rlwrap' && tokens[1]) token = tokens[1];
  return token.replace(/^\.?\//, '').split(/[\\/]/).pop();
}

function guessToolPurpose(name) {
  const normalized = name.toLowerCase();
  if (['nmap', 'masscan', 'rustscan'].includes(normalized)) return 'Port scanning and service discovery';
  if (['gobuster', 'ffuf', 'feroxbuster', 'dirsearch', 'nikto'].includes(normalized)) return 'Web content discovery';
  if (['ldapsearch', 'bloodhound-python', 'kerbrute'].includes(normalized)) return 'Active Directory and LDAP enumeration';
  if (['smbclient', 'smbmap', 'enum4linux', 'enum4linux-ng', 'rpcclient'].includes(normalized)) return 'SMB enumeration';
  if (['evil-winrm', 'ssh', 'xfreerdp', 'rdesktop'].includes(normalized)) return 'Remote access';
  if (['john', 'hashcat', 'hydra', 'medusa'].includes(normalized)) return 'Credential attack or cracking';
  if (['linpeas.sh', 'winpeas.exe', 'peas'].includes(normalized)) return 'Privilege escalation enumeration';
  if (normalized.includes('secretsdump') || normalized.includes('psexec') || normalized.includes('wmiexec')) return 'Impacket post-exploitation';
  if (['curl', 'wget'].includes(normalized)) return 'HTTP request or file transfer';
  if (['nc', 'ncat', 'socat'].includes(normalized)) return 'Network connection or shell handling';
  return 'Documented during assessment';
}

function cleanSecret(value) {
  return String(value || '')
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/[),.;]+$/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function firstMeaningfulLine(content) {
  return String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !/^```/.test(line));
}
