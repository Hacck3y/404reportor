#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import chalk from 'chalk';
import dotenv from 'dotenv';
import ora from 'ora';
import { parseNotes } from '../src/parser.js';
import {
  analyzeImagesWithClaude,
  analyzeImagesWithGemini,
  buildLocalImageAnalysis,
  countImageCategories,
  processImages
} from '../src/image-processor.js';
import {
  AI_PROVIDERS,
  createReport,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_GEMINI_MODEL,
  REPORT_TYPES
} from '../src/ai-engine.js';
import { formatBytes, normalizeFormat, renderReport } from '../src/renderer.js';

const program = new Command();

program
  .name('404reportor')
  .description('Turn raw cybersecurity notes and screenshots into professional reports.')
  .version('1.0.0')
  .showHelpAfterError()
  .option('-i, --input <file>', 'notes markdown file', 'main.md')
  .option('--img-dir <dir>', 'screenshot directory', 'img')
  .option('-o, --output <dir>', 'output directory', '.')
  .option('-f, --format <format>', 'output format: html, pdf, md', 'html')
  .option('-t, --type <type>', 'report type: htb, ctf, pentest, cpts, oscp', 'pentest')
  .option('--provider <provider>', 'AI provider: auto, google, anthropic', 'auto')
  .option('--model <model>', 'AI model name')
  .option('--save-md', 'save the AI-generated Markdown draft alongside HTML/PDF output')
  .option('--no-ai', 'disable AI generation and use local fallback')
  .action((options) => runSafely(() => runReport(options)));

program
  .command('init')
  .description('Scaffold main.md, img/, img/captions.txt, and .env in the current folder.')
  .option('--force', 'overwrite existing scaffold files')
  .action((options) => runSafely(() => initProject(options)));

program
  .command('setup')
  .description('Create or update .env for a Google AI Studio or Anthropic API key.')
  .option('--provider <provider>', 'AI provider: google or anthropic', 'google')
  .option('--ask-key', 'prompt for the API key and save it in local .env')
  .option('--force', 'replace existing provider/model values')
  .action((options) => runSafely(() => setupProvider(options)));

program
  .command('run')
  .description('Parse notes, process screenshots, generate a report, and render the selected output.')
  .option('-i, --input <file>', 'notes markdown file', 'main.md')
  .option('--img-dir <dir>', 'screenshot directory', 'img')
  .option('-o, --output <dir>', 'output directory', '.')
  .option('-f, --format <format>', 'output format: html, pdf, md', 'html')
  .option('-t, --type <type>', 'report type: htb, ctf, pentest, cpts, oscp', 'pentest')
  .option('--provider <provider>', 'AI provider: auto, google, anthropic', 'auto')
  .option('--model <model>', 'AI model name')
  .option('--save-md', 'save the AI-generated Markdown draft alongside HTML/PDF output')
  .option('--no-ai', 'disable AI generation and use local fallback')
  .action((options) => runSafely(() => runReport(options)));

if (process.argv.length <= 2) {
  program.help();
}

program.parseAsync(process.argv);

async function initProject(options) {
  const cwd = process.cwd();
  const writes = [];

  await fs.mkdir(path.join(cwd, 'img'), { recursive: true });
  writes.push(chalk.green('[OK]') + ' Ensured img/ exists');

  writes.push(await writeFileIfAllowed(path.join(cwd, 'main.md'), starterNotes(), options.force));
  writes.push(await writeFileIfAllowed(path.join(cwd, '.env'), envTemplate(), options.force));
  writes.push(await writeFileIfAllowed(path.join(cwd, 'img', 'captions.txt'), captionsTemplate(), options.force));

  console.log(chalk.bold('404reportor workspace initialized'));
  for (const line of writes.filter(Boolean)) console.log(line);
  console.log('');
  console.log(`Next: edit ${chalk.cyan('main.md')} and run ${chalk.cyan('404reportor run --format html')}`);
}

async function setupProvider(options) {
  const cwd = process.cwd();
  const provider = normalizeProvider(options.provider || 'google');
  if (provider === 'auto') throw new Error('setup requires a concrete provider. Use google or anthropic.');
  const envPath = path.join(cwd, '.env');
  let apiKey = '';

  if (options.askKey) {
    apiKey = await askApiKey(provider);
  }

  const values = provider === 'google'
    ? {
        RECON_REPORT_PROVIDER: 'google',
        GEMINI_API_KEY: apiKey,
        GEMINI_MODEL: DEFAULT_GEMINI_MODEL
      }
    : {
        RECON_REPORT_PROVIDER: 'anthropic',
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_MODEL: DEFAULT_ANTHROPIC_MODEL
      };

  await upsertEnvFile(envPath, values, { force: options.force, keepBlankSecrets: !apiKey });

  console.log(chalk.bold('AI provider configured'));
  console.log(`${chalk.green('[OK]')} Updated ${path.relative(cwd, envPath)}`);
  console.log(`Provider: ${provider}`);
  if (!apiKey) {
    const keyName = provider === 'google' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
    console.log(`Next: open ${chalk.cyan('.env')} and paste your key into ${chalk.cyan(`${keyName}=`)}`);
  }
}

async function runReport(options) {
  const cwd = process.cwd();
  const format = normalizeFormat(options.format);
  const reportType = normalizeReportType(options.type);
  const inputPath = path.resolve(cwd, options.input);
  const outputDir = path.resolve(cwd, options.output);

  dotenv.config({ path: path.join(cwd, '.env'), quiet: true });

  const ai = resolveAiConfig(options);

  let spinner = ora(`Reading ${path.relative(cwd, inputPath) || inputPath}...`).start();
  const [content, fileStats] = await Promise.all([fs.readFile(inputPath, 'utf8'), fs.stat(inputPath)]);
  const lineCount = content.split(/\r?\n/).length;
  spinner.succeed(`Read ${path.basename(inputPath)} (${formatBytes(fileStats.size)}, ${lineCount} lines)`);

  spinner = ora('Parsing notes...').start();
  const parsed = parseNotes(content);
  spinner.succeed(`Parsed ${parsed.stats.sections} sections, ${parsed.stats.commands} commands, ${parsed.stats.credentials} credentials found`);

  spinner = ora(`Processing images from ${options.imgDir}/...`).start();
  const images = await processImages({ cwd, imgDir: options.imgDir });
  let imageAnalysis = {};

  if (images.length === 0) {
    spinner.succeed('No images found');
  } else if (ai.useAi && ai.apiKey) {
    try {
      const imageAnalyzer = ai.provider === 'anthropic' ? analyzeImagesWithClaude : analyzeImagesWithGemini;
      imageAnalysis = await imageAnalyzer(images, { apiKey: ai.apiKey, model: ai.model });
      spinner.succeed(`Images analyzed: ${formatCategoryCounts(countImageCategories(imageAnalysis))}`);
    } catch (error) {
      imageAnalysis = buildLocalImageAnalysis(images);
      spinner.warn(`Image AI analysis failed, local image metadata used: ${error.message}`);
    }
  } else {
    imageAnalysis = buildLocalImageAnalysis(images);
    spinner.succeed(`Images indexed locally: ${formatCategoryCounts(countImageCategories(imageAnalysis))}`);
  }

  spinner = ora(ai.useAi && ai.apiKey ? `Generating report with ${providerLabel(ai.provider)} (${ai.model})...` : 'Generating report locally...').start();
  const report = await createReport({
    parsed,
    imageAnalysis,
    reportType,
    provider: ai.provider,
    apiKey: ai.apiKey,
    model: ai.model,
    useAi: ai.useAi
  });

  if (report.warning) {
    spinner.warn(report.warning);
  } else {
    spinner.succeed(`Report generated (${report.stats.words} words, ${report.stats.sections} sections, source: ${report.source})`);
  }

  if (options.saveMd && format !== 'md') {
    const mdRender = await renderReport({
      markdown: report.markdown,
      parsed,
      images,
      imageAnalysis,
      reportType,
      format: 'md',
      outputDir,
      imgDir: options.imgDir
    });
    console.log(chalk.dim(`Saved Markdown draft: ${path.relative(cwd, mdRender.outputPath)} (${mdRender.size})`));
  }

  spinner = ora(`Rendering ${format.toUpperCase()} output...`).start();
  const rendered = await renderReport({
    markdown: report.markdown,
    parsed,
    images,
    imageAnalysis,
    reportType,
    format,
    outputDir,
    imgDir: options.imgDir
  });
  spinner.succeed(`Saved: ${path.relative(cwd, rendered.outputPath)} (${rendered.size})`);

  printSummary({ parsed, report, rendered, imageAnalysis, reportType, ai });
}

async function writeFileIfAllowed(filePath, content, force) {
  try {
    await fs.access(filePath);
    if (!force) return chalk.yellow('[SKIP]') + ` ${path.basename(filePath)} already exists`;
  } catch {
    // File does not exist, so writing is safe.
  }

  await fs.writeFile(filePath, content, 'utf8');
  return chalk.green('[OK]') + ` Wrote ${path.relative(process.cwd(), filePath)}`;
}

function resolveAiConfig(options) {
  if (options.ai === false) {
    return {
      useAi: false,
      provider: 'google',
      apiKey: '',
      model: options.model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
    };
  }

  const requestedProvider = normalizeProvider(options.provider || process.env.RECON_REPORT_PROVIDER || process.env.AI_PROVIDER || 'auto');
  const googleKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

  if (requestedProvider === 'auto') {
    if (googleKey) {
      return {
        useAi: true,
        provider: 'google',
        apiKey: googleKey,
        model: options.model || process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || DEFAULT_GEMINI_MODEL
      };
    }
    if (anthropicKey) {
      return {
        useAi: true,
        provider: 'anthropic',
        apiKey: anthropicKey,
        model: options.model || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL
      };
    }
    return {
      useAi: false,
      provider: 'google',
      apiKey: '',
      model: options.model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
    };
  }

  if (requestedProvider === 'anthropic') {
    return {
      useAi: Boolean(anthropicKey),
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: options.model || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL
    };
  }

  return {
    useAi: Boolean(googleKey),
    provider: 'google',
    apiKey: googleKey,
    model: options.model || process.env.GEMINI_MODEL || process.env.GOOGLE_MODEL || DEFAULT_GEMINI_MODEL
  };
}

function normalizeReportType(type) {
  const normalized = String(type || 'pentest').toLowerCase();
  if (REPORT_TYPES.has(normalized)) return normalized;
  throw new Error(`Invalid report type "${type}". Use htb, ctf, pentest, cpts, or oscp.`);
}

function normalizeProvider(provider) {
  const normalized = String(provider || 'auto').toLowerCase();
  if (normalized === 'gemini' || normalized === 'google-ai') return 'google';
  if (normalized === 'claude') return 'anthropic';
  if (AI_PROVIDERS.has(normalized)) return normalized;
  throw new Error(`Invalid provider "${provider}". Use auto, google, or anthropic.`);
}

function providerLabel(provider) {
  return provider === 'anthropic' ? 'Claude' : 'Gemini';
}

function formatCategoryCounts(counts) {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${count} ${category}`);
  return parts.length > 0 ? parts.join(', ') : '0 images';
}

function printSummary({ parsed, report, rendered, reportType, ai }) {
  const metadata = parsed.metadata;
  const findings = report.stats.findings || 'not counted';
  const severities = Object.entries(report.stats.severityCounts || {})
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(', ') || 'None counted';

  console.log('');
  console.log(chalk.bold('Summary:'));
  console.log(`  Machine: ${parsed.machineName}${metadata.difficulty ? ` (${metadata.difficulty})` : ''}${metadata.os ? ` - ${metadata.os}` : ''}`);
  console.log(`  Report Type: ${reportType}`);
  console.log(`  AI Provider: ${ai.useAi ? `${providerLabel(ai.provider)} (${ai.model})` : 'local fallback'}`);
  console.log(`  Findings: ${findings}`);
  console.log(`  Severity Mentions: ${severities}`);
  console.log(`  Tools: ${parsed.tools.map((tool) => tool.name).slice(0, 8).join(', ') || 'Not parsed'}`);
  console.log(`  Output: ${rendered.outputPath}`);
}

function starterNotes() {
  return `TARGET:
MACHINE:
OS:
DIFFICULTY:

# Recon

Paste scan commands and output here.

# Web Enumeration

Paste web notes here.

# Initial Access

Paste exploitation steps here.

# Privilege Escalation

Paste privilege escalation notes here.

# Proof

user.txt:
root.txt:
`;
}

function envTemplate() {
  return `RECON_REPORT_PROVIDER=google
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-20250514
`;
}

function captionsTemplate() {
  return `# Optional screenshot captions.
# Format:
# 01-nmap.png: Initial Nmap scan showing exposed services.
`;
}

async function runSafely(task) {
  try {
    await task();
  } catch (error) {
    console.error(chalk.red('[ERROR]'), error.message);
    process.exitCode = 1;
  }
}

async function askApiKey(provider) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const keyName = provider === 'google' ? 'Gemini / Google AI Studio API key' : 'Anthropic API key';
    const value = await rl.question(`Paste your ${keyName}: `);
    return value.trim();
  } finally {
    rl.close();
  }
}

async function upsertEnvFile(filePath, values, options = {}) {
  let content = '';
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch {
    content = '';
  }

  const lines = content ? content.split(/\r?\n/) : [];
  const keyIndexes = new Map();

  for (const [index, line] of lines.entries()) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (match) keyIndexes.set(match[1], index);
  }

  for (const [key, value] of Object.entries(values)) {
    const nextLine = `${key}=${value}`;
    const existingIndex = keyIndexes.get(key);
    const secret = key.endsWith('API_KEY');

    if (existingIndex !== undefined) {
      if (value || !secret) {
        lines[existingIndex] = nextLine;
      }
      continue;
    }

    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push(nextLine);
  }

  await fs.writeFile(filePath, `${lines.join('\n').replace(/\n+$/g, '')}\n`, 'utf8');
}
