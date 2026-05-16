import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';

export const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
export const IMAGE_CATEGORIES = ['recon', 'exploit', 'privesc', 'proof', 'misc'];
export const DEFAULT_ANTHROPIC_VISION_MODEL = 'claude-sonnet-4-20250514';
export const DEFAULT_GEMINI_VISION_MODEL = 'gemini-2.5-flash';

export async function processImages(options = {}) {
  const cwd = options.cwd || process.cwd();
  const imgDir = options.imgDir || 'img';
  const rootDir = path.resolve(cwd, imgDir);

  const files = await discoverImageFiles(rootDir);
  if (files.length === 0) return [];

  const captions = await readCaptions(rootDir);
  const images = [];

  for (const absolutePath of files) {
    images.push(await prepareImage(absolutePath, rootDir, captions));
  }

  return images;
}

export async function analyzeImagesWithClaude(images, options = {}) {
  if (!images || images.length === 0) return {};
  if (!options.apiKey) return buildLocalImageAnalysis(images);

  const client = new Anthropic({ apiKey: options.apiKey });
  const content = [
    {
      type: 'text',
      text: [
        'Analyze these cybersecurity report screenshots.',
        'Return JSON only. Do not wrap it in prose.',
        'Use this exact shape:',
        '{ "relative/path.png": { "label": "...", "description": "...", "extracted_text": "...", "category": "recon|exploit|privesc|proof|misc", "tools": ["..."], "sensitive_values": ["..."] } }',
        'Focus on visible commands, tool output, credentials, hashes, flags, proof files, usernames, hostnames, and services.',
        'If a value is sensitive, mention that it exists but do not expand it beyond what is needed for reporting.'
      ].join('\n')
    }
  ];

  for (const image of images) {
    content.push({
      type: 'text',
      text: `Image: ${image.relativePath}\nSuggested label: ${image.label}\nLocal category guess: ${image.category}`
    });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.aiMime || image.mime,
        data: image.aiBase64 || image.base64
      }
    });
  }

  const response = await client.messages.create({
    model: options.model || DEFAULT_ANTHROPIC_VISION_MODEL,
    max_tokens: options.maxTokens || 4096,
    temperature: 0,
    messages: [{ role: 'user', content }]
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const parsed = parseJsonObject(text);
  return mergeImageAnalysis(images, parsed);
}

export async function analyzeImagesWithGemini(images, options = {}) {
  if (!images || images.length === 0) return {};
  if (!options.apiKey) return buildLocalImageAnalysis(images);

  const parts = [
    {
      text: [
        'Analyze these cybersecurity report screenshots.',
        'Return JSON only. Do not wrap it in prose.',
        'Use this exact shape:',
        '{ "relative/path.png": { "label": "...", "description": "...", "extracted_text": "...", "category": "recon|exploit|privesc|proof|misc", "tools": ["..."], "sensitive_values": ["..."] } }',
        'Focus on visible commands, tool output, credentials, hashes, flags, proof files, usernames, hostnames, and services.',
        'If a value is sensitive, mention that it exists but do not expand it beyond what is needed for reporting.'
      ].join('\n')
    }
  ];

  for (const image of images) {
    parts.push({
      text: `Image: ${image.relativePath}\nSuggested label: ${image.label}\nLocal category guess: ${image.category}`
    });
    parts.push({
      inline_data: {
        mime_type: image.aiMime || image.mime,
        data: image.aiBase64 || image.base64
      }
    });
  }

  const model = options.model || DEFAULT_GEMINI_VISION_MODEL;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${geminiModelPath(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': options.apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: options.maxTokens || 4096
      }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`Gemini image analysis failed: ${message}`);
  }

  const text = extractGeminiText(payload);
  const parsed = parseJsonObject(text);
  return mergeImageAnalysis(images, parsed);
}

export function buildLocalImageAnalysis(images) {
  return Object.fromEntries(
    images.map((image) => [
      image.relativePath,
      {
        label: image.label,
        description: image.caption || `${image.label} screenshot captured during the assessment.`,
        extracted_text: '',
        category: image.category,
        tools: [],
        sensitive_values: []
      }
    ])
  );
}

export function mergeImageAnalysis(images, analysis = {}) {
  const local = buildLocalImageAnalysis(images);
  const merged = {};

  for (const image of images) {
    const fromAi = analysis[image.relativePath] || analysis[image.name] || analysis[path.basename(image.relativePath)] || {};
    const category = normalizeCategory(fromAi.category || local[image.relativePath].category);
    merged[image.relativePath] = {
      ...local[image.relativePath],
      ...fromAi,
      label: fromAi.label || local[image.relativePath].label,
      description: fromAi.description || local[image.relativePath].description,
      extracted_text: fromAi.extracted_text || '',
      category,
      tools: Array.isArray(fromAi.tools) ? fromAi.tools : [],
      sensitive_values: Array.isArray(fromAi.sensitive_values) ? fromAi.sensitive_values : []
    };
  }

  return merged;
}

export function countImageCategories(analysis = {}) {
  const counts = Object.fromEntries(IMAGE_CATEGORIES.map((category) => [category, 0]));
  for (const item of Object.values(analysis)) {
    const category = normalizeCategory(item.category);
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

async function discoverImageFiles(rootDir) {
  try {
    await fs.access(rootDir);
  } catch {
    return [];
  }

  const results = [];

  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) results.push(absolutePath);
    }
  }

  await walk(rootDir);
  return results.sort((a, b) => normalizePath(path.relative(rootDir, a)).localeCompare(normalizePath(path.relative(rootDir, b))));
}

async function readCaptions(rootDir) {
  const captionPath = path.join(rootDir, 'captions.txt');
  const captions = new Map();

  try {
    const content = await fs.readFile(captionPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf(':');
      if (separator === -1) continue;
      const key = normalizePath(trimmed.slice(0, separator).trim()).toLowerCase();
      const caption = trimmed.slice(separator + 1).trim();
      if (key && caption) captions.set(key, caption);
    }
  } catch {
    return captions;
  }

  return captions;
}

async function prepareImage(absolutePath, rootDir, captions) {
  const relativePath = normalizePath(path.relative(rootDir, absolutePath));
  const name = path.basename(relativePath);
  const extension = path.extname(name).toLowerCase();
  const mime = extensionToMime(extension);
  const buffer = await fs.readFile(absolutePath);
  const metadata = await readImageMetadata(buffer);
  const caption = captions.get(relativePath.toLowerCase()) || captions.get(name.toLowerCase()) || '';
  const label = caption || autoLabel(relativePath);
  const category = inferCategory(`${relativePath} ${caption} ${label}`);
  const aiCopy = await buildAiImageCopy(buffer, mime, metadata);

  return {
    absolutePath,
    relativePath,
    name,
    extension,
    mime,
    base64: buffer.toString('base64'),
    dataUri: `data:${mime};base64,${buffer.toString('base64')}`,
    sizeBytes: buffer.byteLength,
    width: metadata.width || null,
    height: metadata.height || null,
    label,
    caption,
    category,
    aiMime: aiCopy.mime,
    aiBase64: aiCopy.base64
  };
}

async function readImageMetadata(buffer) {
  try {
    const metadata = await sharp(buffer).metadata();
    return {
      width: metadata.width || null,
      height: metadata.height || null,
      format: metadata.format || null
    };
  } catch {
    return { width: null, height: null, format: null };
  }
}

async function buildAiImageCopy(buffer, mime, metadata) {
  const supportedByVision = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime);
  const isLarge = (metadata.width || 0) > 1568 || (metadata.height || 0) > 1568;

  if (supportedByVision && !isLarge) {
    return { mime, base64: buffer.toString('base64') };
  }

  try {
    const converted = await sharp(buffer)
      .rotate()
      .resize({ width: 1568, height: 1568, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
    return { mime: 'image/png', base64: converted.toString('base64') };
  } catch {
    return { mime, base64: buffer.toString('base64') };
  }
}

function extensionToMime(extension) {
  switch (extension) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.png':
    default:
      return 'image/png';
  }
}

function autoLabel(relativePath) {
  const base = path.basename(relativePath, path.extname(relativePath));
  const cleaned = base
    .replace(/^\d+[\s._-]*/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const searchable = `${relativePath} ${cleaned}`.toLowerCase();
  if (/\bnmap\b/.test(searchable)) return 'Initial Nmap Scan';
  if (/\bldap\b/.test(searchable)) return 'LDAP Enumeration';
  if (/\bsmb\b/.test(searchable)) return 'SMB Enumeration';
  if (/\b(web|gobuster|ffuf|ferox|dirsearch|admin|uploads?)\b/.test(searchable)) return 'Web Enumeration';
  if (/\b(shell|foothold|reverse)\b/.test(searchable)) return 'Initial Shell';
  if (/\b(root|system|proof)\b/.test(searchable)) return 'Root Proof';
  if (/\buser\b/.test(searchable)) return 'User Proof';
  if (/\b(priv|privesc|escalation)\b/.test(searchable)) return 'Privilege Escalation Evidence';
  if (/\b(creds?|password|hash|secret)\b/.test(searchable)) return 'Credential Evidence';

  return titleCase(cleaned || base || 'Screenshot');
}

function inferCategory(value) {
  const text = value.toLowerCase();
  if (/\b(root|user\.txt|root\.txt|flag|proof|system)\b/.test(text)) return 'proof';
  if (/\b(priv|privesc|escalation|sudo|registry|vnc|token|suid)\b/.test(text)) return 'privesc';
  if (/\b(exploit|shell|payload|reverse|foothold|rce|upload)\b/.test(text)) return 'exploit';
  if (/\b(nmap|scan|enum|ldap|smb|web|gobuster|ffuf|dirsearch|recon)\b/.test(text)) return 'recon';
  return 'misc';
}

function titleCase(value) {
  const acronyms = new Map([
    ['ad', 'AD'],
    ['api', 'API'],
    ['cve', 'CVE'],
    ['http', 'HTTP'],
    ['https', 'HTTPS'],
    ['ldap', 'LDAP'],
    ['nmap', 'Nmap'],
    ['rdp', 'RDP'],
    ['smb', 'SMB'],
    ['sql', 'SQL'],
    ['ssh', 'SSH'],
    ['vnc', 'VNC'],
    ['winrm', 'WinRM']
  ]);

  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return acronyms.get(lower) || `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(' ');
}

function parseJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate || !candidate.trim().startsWith('{')) {
    throw new Error('Claude image analysis did not return a JSON object.');
  }
  return JSON.parse(candidate);
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
  const clean = String(model || DEFAULT_GEMINI_VISION_MODEL).replace(/^models\//, '');
  return `models/${encodeURIComponent(clean)}`;
}

function normalizeCategory(value) {
  const normalized = String(value || '').toLowerCase();
  return IMAGE_CATEGORIES.includes(normalized) ? normalized : 'misc';
}

function normalizePath(value) {
  return String(value || '').split(path.sep).join('/');
}
