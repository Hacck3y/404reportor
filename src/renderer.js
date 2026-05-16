import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { marked } from 'marked';
import hljs from 'highlight.js';
import puppeteer from 'puppeteer';
import { slugify } from './parser.js';

const require = createRequire(import.meta.url);
const TEMPLATE_DIR = new URL('./templates/', import.meta.url);

export async function renderReport(options) {
  const format = normalizeFormat(options.format);
  const outputDir = path.resolve(options.outputDir || process.cwd());
  await fs.mkdir(outputDir, { recursive: true });

  const baseName = buildOutputBaseName(options.parsed);
  const outputPath = path.join(outputDir, `${baseName}.${format}`);

  if (format === 'md') {
    const markdown = appendMarkdownImageGallery(options.markdown, options.images || [], options.imageAnalysis || {}, options.imgDir || 'img');
    await fs.writeFile(outputPath, markdown, 'utf8');
    return buildRenderResult(outputPath, format);
  }

  const html = await createHtmlDocument({
    markdown: options.markdown,
    parsed: options.parsed,
    images: options.images || [],
    imageAnalysis: options.imageAnalysis || {},
    reportType: options.reportType || 'pentest'
  });

  if (format === 'html') {
    await fs.writeFile(outputPath, html, 'utf8');
    return buildRenderResult(outputPath, format);
  }

  if (format === 'pdf') {
    await renderPdf(html, outputPath, options.parsed);
    return buildRenderResult(outputPath, format);
  }

  throw new Error(`Unsupported format: ${format}`);
}

export async function createHtmlDocument({ markdown, parsed, images, imageAnalysis, reportType }) {
  const [template, styles] = await Promise.all([
    fs.readFile(new URL('report.html', TEMPLATE_DIR), 'utf8'),
    fs.readFile(new URL('styles.css', TEMPLATE_DIR), 'utf8')
  ]);

  const rawHtml = marked.parse(markdown, { gfm: true, breaks: false });
  const highlighted = highlightCodeBlocks(rawHtml);
  const decorated = decorateSeverityBadges(highlighted);
  const withResponsiveTables = wrapTablesForResponsive(decorated);
  const { html, toc } = addHeadingIds(withResponsiveTables);
  const severity = highestSeverity(markdown);
  const title = `${parsed.machineName} Report`;
  const subtitle = `${typeLabel(reportType)} | ${parsed.metadata.os || 'OS not documented'} | ${parsed.metadata.date || ''}`;

  return fillTemplate(template, {
    title: escapeHtml(title),
    subtitle: escapeHtml(subtitle),
    machine: escapeHtml(parsed.machineName),
    date: escapeHtml(parsed.metadata.date || ''),
    severity: escapeHtml(severity),
    styles,
    highlightStyles: readHighlightStyles(),
    toc: buildToc(toc),
    content: html,
    imageGallery: buildImageGalleryHtml(images, imageAnalysis),
    script: clientScript()
  });
}

export function normalizeFormat(format) {
  const normalized = String(format || 'html').toLowerCase();
  if (['html', 'pdf', 'md'].includes(normalized)) return normalized;
  throw new Error(`Invalid format "${format}". Use html, pdf, or md.`);
}

export function buildOutputBaseName(parsed) {
  const machine = slugify(parsed.machineName || parsed.metadata.target || 'target');
  const date = parsed.metadata.date || new Date().toISOString().slice(0, 10);
  return `report-${machine}-${date}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function renderPdf(html, outputPath, parsed) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('screen');
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      margin: {
        top: '20mm',
        right: '20mm',
        bottom: '22mm',
        left: '20mm'
      },
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:9px;color:#64748b;padding:0 20mm;display:flex;justify-content:space-between;"><span>Confidential | ${escapeHtml(parsed.machineName)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`
    });
  } catch (error) {
    throw new Error(`PDF rendering failed: ${error.message}. If Chrome is missing, run "npx puppeteer browsers install chrome".`);
  } finally {
    if (browser) await browser.close();
  }
}

async function buildRenderResult(outputPath, format) {
  const stats = await fs.stat(outputPath);
  return {
    outputPath,
    format,
    bytes: stats.size,
    size: formatBytes(stats.size)
  };
}

function highlightCodeBlocks(html) {
  return html.replace(/<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g, (match, language, encodedCode) => {
    const code = decodeHtml(encodedCode);
    let highlighted;

    try {
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(code, { language }).value;
      } else {
        highlighted = hljs.highlightAuto(code).value;
      }
    } catch {
      highlighted = escapeHtml(code);
    }

    const langLabel = language ? escapeHtml(language) : 'code';
    const langClass = language ? ` language-${escapeHtml(language)}` : '';
    const copyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    return [
      '<div class="code-block-wrapper">',
      `<div class="code-block-header"><span class="code-lang-label">${langLabel}</span><button type="button" class="copy-btn" aria-label="Copy code">${copyIcon} Copy</button></div>`,
      `<pre><code class="hljs${langClass}">${highlighted}</code></pre>`,
      '</div>'
    ].join('');
  });
}

function wrapTablesForResponsive(html) {
  return html.replace(/(<table[\s\S]*?<\/table>)/g, '<div class="table-wrapper">$1</div>');
}

function addHeadingIds(html) {
  const counts = new Map();
  const toc = [];

  const output = html.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
    const text = stripTags(inner).trim();
    const base = slugify(text, 'section');
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count + 1}`;
    toc.push({ level: Number(level), text, id });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });

  return { html: output, toc };
}

function buildToc(entries) {
  if (!entries || entries.length === 0) return '<p class="toc-empty">No headings found.</p>';
  return [
    '<nav class="toc-list" aria-label="Report table of contents">',
    ...entries.map((entry) => `<a class="toc-link depth-${entry.level}" href="#${entry.id}">${escapeHtml(entry.text)}</a>`),
    '</nav>'
  ].join('\n');
}

function buildImageGalleryHtml(images, imageAnalysis) {
  if (!images || images.length === 0) return '';

  const groups = groupImages(images, imageAnalysis);
  const sections = [];

  sections.push('<section class="evidence-gallery" id="screenshot-evidence">');
  sections.push('<h2>Screenshot Evidence</h2>');

  for (const [category, groupedImages] of Object.entries(groups)) {
    if (groupedImages.length === 0) continue;
    sections.push(`<h3>${escapeHtml(categoryLabel(category))}</h3>`);
    sections.push('<div class="evidence-grid">');
    for (const image of groupedImages) {
      const analysis = imageAnalysis[image.relativePath] || {};
      const label = analysis.label || image.label;
      const description = analysis.description || image.caption || `${label} screenshot.`;
      sections.push([
        `<figure class="evidence-card" data-category="${escapeHtml(analysis.category || image.category)}">`,
        `<button class="image-button" type="button" data-lightbox-src="${image.dataUri}" data-lightbox-caption="${escapeAttribute(label)}">`,
        `<img src="${image.dataUri}" alt="${escapeAttribute(description)}" loading="lazy">`,
        '</button>',
        '<figcaption>',
        `<span class="category-badge category-${escapeHtml(analysis.category || image.category)}">${escapeHtml(categoryLabel(analysis.category || image.category))}</span>`,
        `<strong>${escapeHtml(label)}</strong>`,
        `<span>${escapeHtml(description)}</span>`,
        `<small>${escapeHtml(image.relativePath)}${image.width && image.height ? ` | ${image.width}x${image.height}` : ''}</small>`,
        '</figcaption>',
        '</figure>'
      ].join('\n'));
    }
    sections.push('</div>');
  }

  sections.push('</section>');
  sections.push('<div class="lightbox" aria-hidden="true"><button type="button" class="lightbox-close" aria-label="Close image preview">x</button><img alt=""><p></p></div>');
  return sections.join('\n');
}

function appendMarkdownImageGallery(markdown, images, imageAnalysis, imgDir) {
  if (!images || images.length === 0) return markdown;

  const lines = ['', '## Screenshot Evidence', ''];
  const groups = groupImages(images, imageAnalysis);

  for (const [category, groupedImages] of Object.entries(groups)) {
    if (groupedImages.length === 0) continue;
    lines.push(`### ${categoryLabel(category)}`, '');
    for (const image of groupedImages) {
      const analysis = imageAnalysis[image.relativePath] || {};
      const label = analysis.label || image.label;
      const description = analysis.description || image.caption || '';
      const imagePath = `./${imgDir.replace(/\/+$/g, '')}/${image.relativePath}`;
      lines.push(`![${escapeMarkdownAlt(label)}](${imagePath})`);
      if (description) lines.push(`_${description}_`);
      lines.push('');
    }
  }

  return `${markdown.trim()}\n${lines.join('\n')}`;
}

function groupImages(images, imageAnalysis) {
  const groups = { recon: [], exploit: [], privesc: [], proof: [], misc: [] };
  for (const image of images) {
    const category = imageAnalysis[image.relativePath]?.category || image.category || 'misc';
    const key = Object.hasOwn(groups, category) ? category : 'misc';
    groups[key].push(image);
  }
  return groups;
}

function decorateSeverityBadges(html) {
  let output = html.replace(/(<strong>Severity:<\/strong>\s*)(Critical|High|Medium|Low|Info)/g, (match, prefix, severity) => {
    return `${prefix}<span class="severity severity-${severity.toLowerCase()}">${severity}</span>`;
  });

  output = output.replace(/<td>(Critical|High|Medium|Low|Info)<\/td>/g, (match, severity) => {
    return `<td><span class="severity severity-${severity.toLowerCase()}">${severity}</span></td>`;
  });

  return output;
}

function highestSeverity(markdown) {
  const order = ['Critical', 'High', 'Medium', 'Low', 'Info'];
  for (const severity of order) {
    if (new RegExp(`\\b${severity}\\b`).test(markdown)) return severity;
  }
  return 'Info';
}

function readHighlightStyles() {
  try {
    const filePath = require.resolve('highlight.js/styles/github-dark.css');
    return readFileSync(filePath, 'utf8');
  } catch {
    return '.hljs{background:#0f172a;color:#e2e8f0}';
  }
}

function fillTemplate(template, values) {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`{{${key}}}`).join(String(value ?? ''));
  }
  return output;
}

function clientScript() {
  return `
(function() {
  const root = document.documentElement;

  /* ── Theme Toggle ──────────────────────────────── */
  const toggle = document.querySelector('[data-theme-toggle]');
  const stored = localStorage.getItem('404reportor-theme');
  if (stored) root.dataset.theme = stored;
  function updateThemeIcons() {
    const isDark = root.dataset.theme !== 'light';
    document.querySelector('.icon-sun')?.setAttribute('style', isDark ? 'display:none' : '');
    document.querySelector('.icon-moon')?.setAttribute('style', isDark ? '' : 'display:none');
  }
  updateThemeIcons();
  toggle?.addEventListener('click', function() {
    var next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    localStorage.setItem('404reportor-theme', next);
    updateThemeIcons();
  });

  /* ── Scroll Progress Bar ───────────────────────── */
  var progressBar = document.getElementById('scrollProgress');
  function updateProgress() {
    var scrollTop = window.scrollY;
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    var pct = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    if (progressBar) progressBar.style.width = pct + '%';
  }

  /* ── Back to Top ───────────────────────────────── */
  var backBtn = document.getElementById('backToTop');
  function updateBackToTop() {
    if (!backBtn) return;
    if (window.scrollY > 400) backBtn.classList.add('visible');
    else backBtn.classList.remove('visible');
  }
  backBtn?.addEventListener('click', function() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ── Scroll Spy (Active TOC Link) ──────────────── */
  var tocLinks = Array.from(document.querySelectorAll('.toc-link'));
  var headings = tocLinks.map(function(link) {
    var id = link.getAttribute('href')?.slice(1);
    return id ? document.getElementById(id) : null;
  }).filter(Boolean);

  function updateScrollSpy() {
    var scrollPos = window.scrollY + 120;
    var activeId = '';
    for (var i = headings.length - 1; i >= 0; i--) {
      if (headings[i].offsetTop <= scrollPos) { activeId = headings[i].id; break; }
    }
    tocLinks.forEach(function(link) {
      if (link.getAttribute('href') === '#' + activeId) link.classList.add('active');
      else link.classList.remove('active');
    });
  }

  /* ── Scroll Listener (throttled) ────────────────── */
  var ticking = false;
  window.addEventListener('scroll', function() {
    if (!ticking) {
      window.requestAnimationFrame(function() {
        updateProgress();
        updateBackToTop();
        updateScrollSpy();
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
  updateProgress();
  updateBackToTop();
  updateScrollSpy();

  /* ── Code Copy Buttons ─────────────────────────── */
  document.querySelectorAll('.copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var wrapper = btn.closest('.code-block-wrapper');
      var code = wrapper?.querySelector('code');
      if (!code) return;
      var text = code.innerText || code.textContent;
      navigator.clipboard.writeText(text).then(function() {
        btn.classList.add('copied');
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
        setTimeout(function() {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
        }, 2000);
      });
    });
  });

  /* ── Mobile Sidebar Toggle ─────────────────────── */
  var sidebar = document.getElementById('sidebar');
  var sidebarToggle = document.getElementById('sidebarToggle');
  var overlay = document.getElementById('sidebarOverlay');
  function closeSidebar() {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('open');
  }
  sidebarToggle?.addEventListener('click', function() {
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('open');
  });
  overlay?.addEventListener('click', closeSidebar);
  tocLinks.forEach(function(link) {
    link.addEventListener('click', function() {
      if (window.innerWidth <= 920) closeSidebar();
    });
  });

  /* ── Lightbox ──────────────────────────────────── */
  var lightbox = document.querySelector('.lightbox');
  var lightboxImg = lightbox?.querySelector('img');
  var lightboxCaption = lightbox?.querySelector('p');
  document.querySelectorAll('.image-button').forEach(function(button) {
    button.addEventListener('click', function() {
      if (!lightbox || !lightboxImg || !lightboxCaption) return;
      lightboxImg.src = button.dataset.lightboxSrc;
      lightboxCaption.textContent = button.dataset.lightboxCaption || '';
      lightbox.setAttribute('aria-hidden', 'false');
    });
  });
  document.querySelector('.lightbox-close')?.addEventListener('click', closeLightbox);
  lightbox?.addEventListener('click', function(e) { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeLightbox(); });
  function closeLightbox() {
    if (!lightbox || !lightboxImg) return;
    lightbox.setAttribute('aria-hidden', 'true');
    lightboxImg.removeAttribute('src');
  }
})();
`;
}

function typeLabel(type) {
  switch (String(type || '').toLowerCase()) {
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

function categoryLabel(category) {
  switch (category) {
    case 'recon':
      return 'Recon';
    case 'exploit':
      return 'Exploit';
    case 'privesc':
      return 'Privilege Escalation';
    case 'proof':
      return 'Proof';
    case 'misc':
    default:
      return 'Misc';
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\n/g, ' ');
}

function escapeMarkdownAlt(value) {
  return String(value || 'Screenshot').replace(/]/g, '\\]');
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]*>/g, '');
}
