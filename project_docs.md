
# ============================================================
# 404reportor — AI-Powered Cybersecurity Report Generator
# NPM CLI Tool — Full Implementation Specification
# ============================================================

Build a production-ready npm CLI tool called `404reportor` that transforms raw cybersecurity notes into professional reports. Follow every specification below exactly.

## 1. PROJECT STRUCTURE

Create this exact file tree:

404reportor/
├── bin/
│   └── 404reportor.js        # CLI entry point (#!/usr/bin/env node)
├── src/
│   ├── parser.js              # Parses main.md into structured sections
│   ├── image-processor.js     # Handles img/ folder — base64, OCR metadata
│   ├── ai-engine.js           # Builds prompts + calls Claude API (claude-sonnet-4-20250514)
│   ├── renderer.js            # Converts AI output → HTML/PDF/MD
│   └── templates/
│       ├── report.html        # Full HTML report template (dark/light toggle)
│       └── styles.css         # Professional pentest report CSS
├── package.json
├── .env.example               # ANTHROPIC_API_KEY=
└── README.md



## 2. INSTALLATION FLOW

When a user runs `npm install -g 404reportor` they get a global CLI.

In any project folder they run:
  `404reportor init`   → scaffolds main.md + img/ + .env in cwd
  `404reportor run`    → processes and generates report
  `404reportor run --format pdf`     → pdf output
  `404reportor run --format html`    → html output (default)
  `404reportor run --format md`      → markdown output
  `404reportor run --type htb`       → HTB machine report style
  `404reportor run --type ctf`       → CTF writeup style
  `404reportor run --type pentest`   → professional pentest report
  `404reportor run --type cpts`      → CPTS exam report style
  `404reportor run --type oscp`      → OSCP exam report style



## 3. main.md FORMAT — USER WRITES THIS

The user just dumps raw notes. The AI must handle ALL of these mixed in any order:

```
TARGET: 10.10.11.42
MACHINE: Cascade (HTB)
OS: Windows
DIFFICULTY: Medium

# port scan
nmap -sC -sV -oA nmap/initial 10.10.11.42
22/tcp   open  ssh     OpenSSH 7.4
80/tcp   open  http    Apache 2.4.18
5986/tcp open  wsman   Microsoft HTTPAPI 2.4

# web enum
gobuster dir -u http://10.10.11.42 -w /usr/share/wordlists/dirb/common.txt
found: /admin (302)
found: /uploads (403)

found ldap anon bind!! 
ldapsearch -x -H ldap://10.10.11.42 -b "dc=cascade,dc=local"
got user: r.thompson  password hint in description field: rY4n5eva

# got shell
evil-winrm -i 10.10.11.42 -u r.thompson -p rY4n5eva
*Evil-WinRM* PS> whoami
cascade\r.thompson

# privesc
found TightVNC encrypted pass in registry:
HKLM\Software\TightVNC\Server -> Password: 6bcf2a4b6e5aca0f
decrypted with vncpwd: sT333ve2

# root
got admin via lateral movement to s.smith, then found ArkSvc account
s.smith in AD Recycle Bin group → restored deleted user → cleartext pass in AD attribute
SYSTEM flag: [REDACTED]
```

The parser MUST handle: bash commands + output, freeform notes, IP addresses,
credentials, CVEs, flag values, indented blocks, headers with #, 
and mixed unstructured text. No strict format required from the user.



## 4. IMAGE PROCESSING (img/ folder)

Implement src/image-processor.js with this exact logic:

Step 1 — Discovery
  - Scan img/ for: .png .jpg .jpeg .gif .webp .bmp
  - Sort files alphabetically (user names them 01-nmap.png, 02-web.png etc.)
  - Support nested subfolders (img/privesc/01.png)

Step 2 — Prepare for AI Vision
  - Convert each image to base64
  - Detect image dimensions with the 'sharp' library
  - Auto-label each image from filename: "01-nmap.png" → label "Initial Nmap Scan"
    (strip leading numbers, replace hyphens/underscores with spaces, title-case)
  - If user added a caption file (img/captions.txt, format "filename: caption"),
    use that caption instead of auto-label

Step 3 — Send to Claude Vision
  - Include ALL images in the AI prompt as vision blocks
  - Ask AI to: describe what each screenshot shows, extract visible text/commands,
    identify tools used, note any credentials or flags visible
  - AI returns a JSON map: { "01-nmap.png": { label, description, extracted_text, category } }
  - Categories: "recon", "exploit", "privesc", "proof", "misc"

Step 4 — Embed in Report
  - Images are embedded as base64 inline in HTML (no external refs, fully portable)
  - Each image gets: caption label, AI-generated description as alt text,
    category badge (color-coded), and is placed in the correct report section
  - "proof" category images (root.txt / user.txt visible) → auto-placed in Flags section
  - Images resize responsively, click to expand (lightbox in HTML output)
  - In PDF output: images embedded at max-width with captions below



## 5. AI ENGINE — REPORT GENERATION PROMPT

In src/ai-engine.js, build the following multi-part prompt to Claude:

SYSTEM PROMPT:
"You are an expert penetration tester and technical writer with 10+ years experience.
You write clear, professional cybersecurity reports that are both technically accurate
and readable by non-technical stakeholders. You NEVER fabricate information —
if something isn't in the notes, you say it wasn't documented. You format reports
in clean Markdown with proper sections. For OSCP/CPTS style reports you follow
the official exam report structure exactly."

USER PROMPT (assembled by ai-engine.js):
- Section 1: Report type + metadata (--type flag value)
- Section 2: Full parsed main.md content
- Section 3: Image analysis JSON from image-processor.js
- Section 4: Instruction block (see below)

INSTRUCTION BLOCK sent to AI:
"Generate a complete [TYPE] report from the above notes.

REPORT MUST INCLUDE (adapt sections to report type):
1. Executive Summary (2-3 sentences, non-technical)
2. Target Information table (IP, hostname, OS, difficulty, date)
3. Attack Narrative — story-form walkthrough of the full compromise chain
4. Technical Findings — for each vulnerability found:
   - Finding name
   - Severity (Critical/High/Medium/Low/Info)
   - Description
   - Steps to reproduce (numbered, with exact commands)
   - Evidence (reference images by filename)
   - Remediation recommendation
5. Exploitation Steps — step-by-step with exact commands used,
   outputs trimmed to relevant lines
6. Flags / Proof (user.txt, root.txt, screenshots)
7. Tools Used (table: tool, version/source, purpose)
8. Recommendations Summary
9. Appendix — full raw command outputs if lengthy

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
- Output clean Markdown only, no preamble"



## 6. RENDERER — OUTPUT FORMATS

HTML output (default):
  - Self-contained single .html file (all CSS + images base64 inline)
  - Professional pentest report styling: dark sidebar TOC, clean typography
  - Severity badges (red/orange/yellow/blue/gray)
  - Syntax-highlighted code blocks (use highlight.js bundled)
  - Print-friendly CSS (@media print)
  - Dark/light mode toggle button
  - TOC auto-generated from headings with anchor links
  - Output: report-[machinename]-[date].html

PDF output:
  - Use puppeteer (headless Chrome) to render the HTML → PDF
  - A4 page size, 20mm margins
  - Page numbers in footer: "Confidential | [Machine Name] | Page X of Y"
  - Cover page: tool name, machine name, date, severity rating (auto-calculated)
  - Output: report-[machinename]-[date].pdf

Markdown output:
  - Clean GitHub-flavored markdown
  - Images referenced as ./img/[filename] (relative paths)
  - Output: report-[machinename]-[date].md



## 7. DEPENDENCIES

Use ONLY these packages (no bloat):
  - @anthropic-ai/sdk     → Claude API calls
  - sharp                  → image dimension detection + resize
  - puppeteer             → HTML → PDF rendering
  - commander             → CLI argument parsing
  - chalk                 → colored terminal output
  - ora                   → spinner for AI processing steps
  - dotenv               → .env loading
  - marked               → Markdown → HTML conversion
  - highlight.js          → code block syntax highlighting
  - Node.js built-ins for everything else (fs, path, crypto)



## 8. CLI UX — TERMINAL OUTPUT

When user runs `404reportor run`, show:

  ⠋ Reading main.md... (file size, line count)
  ✓ Parsed 14 sections, 47 commands, 3 credentials found
  ⠋ Processing 6 images from img/...
  ✓ Images analyzed: 2 recon, 2 exploit, 1 privesc, 1 proof
  ⠋ Generating report with Claude AI... (estimated ~30s)
  ✓ Report generated: 2,847 words, 8 sections, 4 findings
  ⠋ Rendering HTML output...
  ✓ Saved: report-cascade-2025-05-16.html (1.2MB)
  
  📋 Summary:
     Machine: Cascade (HTB — Medium — Windows)
     Findings: 1 Critical, 2 High, 1 Medium
     Attack Path: LDAP Enum → Password Reuse → VNC Decrypt → AD Recycle Bin
     Time to generate: 34s



## 9. CONFIG FILE (optional)

Support a 404reportor.config.js in cwd:

module.exports = {
  author: "404",
  company: "Independent",
  defaultType: "htb",
  defaultFormat: "html",
  redactCredentials: true,      // censor passwords in output
  includeRawAppendix: true,     // append all raw notes at end
  cvssScoring: true,            // auto-calculate CVSS scores
  watermark: "CONFIDENTIAL",    // adds to PDF footer
  logoPath: "./logo.png"        // optional, placed on PDF cover
}



## 10. ERROR HANDLING + EDGE CASES

Handle ALL of these gracefully:
  - No main.md found → helpful error with `404reportor init` suggestion
  - No API key → clear message with link to get key
  - img/ folder missing → warn but continue (report generated without images)
  - Image format unsupported → skip with warning, list supported formats
  - main.md is empty → error with format hint
  - API rate limit hit → retry with exponential backoff (3 attempts)
  - API timeout → save partial result + error message
  - Puppeteer/Chrome not available → fall back to HTML only with notice
  - Very large main.md (>50k chars) → auto-chunk into multiple API calls and merge



## 11. PACKAGE.JSON REQUIREMENTS

{
  "name": "404reportor",
  "version": "1.0.0",
  "description": "AI-powered cybersecurity report generator for HTB, CTF, CPTS, OSCP",
  "bin": { "404reportor": "./bin/404reportor.js" },
  "keywords": ["cybersecurity", "ctf", "pentest", "htb", "oscp", "report"],
  "engines": { "node": ">=18.0.0" }
}

Build the COMPLETE, WORKING implementation of all files listed above.
Every file must be production-ready with proper error handling.
Do not use placeholder comments like "// implement this" — write the full code.
    



## 12. PROVIDER CONFIG — MULTI-PROVIDER AI SUPPORT

Add a provider configuration system so users can plug in ANY AI backend.
The tool must NOT be hardcoded to Anthropic — it should be provider-agnostic.

### 12a. NEW CLI COMMAND: `404reportor config`

Implement an interactive setup wizard:

  `404reportor config`         → interactive setup (prompts + saves)
  `404reportor config --show`  → print current config (mask API key)
  `404reportor config --reset` → clear saved config

The interactive wizard (use Node.js readline or the 'enquirer' package) asks:

  ? Select provider:
    › Anthropic (Claude)
      OpenAI
      Groq
      Mistral
      Together AI
      Ollama (local)
      Custom OpenAI-compatible endpoint

  ? API Key: (hidden input, typed chars show as ****)
  
  ? Base URL: (pre-filled per provider, editable)
    Anthropic  → https://api.anthropic.com
    OpenAI     → https://api.openai.com/v1
    Groq       → https://api.groq.com/openai/v1
    Mistral    → https://api.mistral.ai/v1
    Together   → https://api.together.xyz/v1
    Ollama     → http://localhost:11434/v1
    Custom     → (blank, user types full URL)

  ? Model name: (pre-filled with provider default, editable)
    Anthropic  → claude-sonnet-4-20250514
    OpenAI     → gpt-4o
    Groq       → llama-3.3-70b-versatile
    Mistral    → mistral-large-latest
    Custom     → (blank, user types)

  ? Vision support? (y/n) → if no, images will be described via filename only
  
  ✓ Testing connection... (runs ping test automatically — see section 13)
  ✓ Config saved to ~/.404reportor/config.json

### 12b. CONFIG FILE LOCATION

Save provider config to `~/.404reportor/config.json` (global, not per-project).
This way the user sets it once and all projects use it.

Format:
{
  "provider": "anthropic" | "openai" | "groq" | "custom" | ...,
  "apiKey": "sk-...",                   // stored here, NOT in .env
  "baseUrl": "https://api.anthropic.com",
  "model": "claude-sonnet-4-20250514",
  "visionSupported": true,
  "maxTokens": 8192,
  "temperature": 0.3,                  // low temp for factual reports
  "configuredAt": "2025-05-16T10:00:00Z"
}

PRIORITY ORDER for config resolution (highest to lowest):
  1. CLI flag:          `--model gpt-4o --key sk-xxx`    (one-off override)
  2. Project .env:      `RECON_API_KEY=`, `RECON_MODEL=`  (project-specific)
  3. Global config:     `~/.404reportor/config.json`       (set via config cmd)
  4. Environment var:   `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (legacy fallback)

### 12c. AI CLIENT ABSTRACTION LAYER

Create src/ai-client.js — a unified client that wraps provider differences:

class AIClient {
  constructor(config) { ... }

  // Anthropic native SDK path
  async callAnthropic(messages, images) { ... }

  // OpenAI-compatible path (covers OpenAI, Groq, Mistral,
  // Together, Ollama, LM Studio, vLLM, any custom endpoint)
  async callOpenAICompat(messages, images) { ... }

  // Unified method — auto-routes based on provider
  async complete(messages, images) {
    if (this.config.provider === 'anthropic') {
      return this.callAnthropic(messages, images)
    }
    return this.callOpenAICompat(messages, images)
  }
}

For OpenAI-compatible calls use the native fetch API — do NOT import the
openai npm package. Build the request manually:
POST {baseUrl}/chat/completions
Headers: { Authorization: "Bearer {apiKey}", Content-Type: "application/json" }
Body: { model, messages, max_tokens, temperature, stream: false }

For vision on OpenAI-compatible providers, embed images as:
{ role: "user", content: [
    { type: "image_url", image_url: { url: "data:image/png;base64,{b64}" } },
    { type: "text", text: "..." }
]}

If visionSupported is false in config, skip image base64 embedding entirely
and only pass image filenames/labels as text context to the AI.
    

copy
section 13 — ping / health check command

## 13. `404reportor ping` — AI HEALTH CHECK COMMAND

Implement a dedicated ping command that tests the configured AI endpoint.

  `404reportor ping`                → test current config
  `404reportor ping --verbose`     → show full request + response
  `404reportor ping --key sk-xxx --url https://... --model gpt-4o`
                                         → test a config WITHOUT saving it

### What ping does (in order):

Step 1 — Config resolution
  Load config from priority chain (section 12b)
  Print: "Provider: anthropic | Model: claude-sonnet-4-20250514"
  Print: "Endpoint: https://api.anthropic.com"
  Print: "API Key: sk-ant-...****  (last 4 shown)"

Step 2 — Send test message
  Send exactly this message to the AI:
  { role: "user", content: "Say: RECON_REPORT_PING_OK" }
  
  Set a 10 second timeout on the request.

Step 3 — Evaluate response
  SUCCESS conditions (any of these passes):
    - HTTP 200 + response body has content
    - Response text contains "PING_OK" or any non-empty string
  
  FAILURE conditions:
    - HTTP 401 / 403  → "Invalid API key"
    - HTTP 404        → "Model not found or wrong base URL"
    - HTTP 429        → "Rate limited — key works but quota exceeded"
    - HTTP 5xx        → "Provider server error — try again later"
    - Timeout         → "No response in 10s — check URL or local server"
    - Network error   → "Cannot reach endpoint — check URL"

Step 4 — Terminal output

SUCCESS output:
    ✓ Connection OK
    Provider  : anthropic
    Model     : claude-sonnet-4-20250514
    Endpoint  : https://api.anthropic.com
    Latency   : 843ms
    Response  : "RECON_REPORT_PING_OK"
    Vision    : ✓ supported
    Status    : 🟢 ready to generate reports

FAILURE output:
    ✗ Connection FAILED
    Provider  : custom
    Model     : llama-3-8b
    Endpoint  : http://localhost:11434/v1
    Error     : Cannot reach endpoint — is Ollama running?
    Hint      : run `ollama serve` then try again
    Status    : 🔴 not ready

### --verbose flag shows:
    → Request headers (with key masked as sk-...XXXX)
  → Request body (full JSON)
  ← Response status + headers
  ← Response body (first 500 chars)

### Auto-ping on `404reportor config`
  After saving config, automatically run ping once.
  If ping fails, warn the user but still save the config:
    ⚠ Config saved but ping failed: Invalid API key
    Run `404reportor ping` after fixing your key.

### Provider-specific hints:
  Build a hints map — if error matches + provider known, show targeted help:
  {
    "anthropic + 401": "Get key at console.anthropic.com",
    "openai + 401":    "Get key at platform.openai.com/api-keys",
    "groq + 401":      "Get key at console.groq.com/keys",
    "ollama + ECONNREFUSED": "Run: ollama serve",
    "ollama + 404":    "Run: ollama pull {model} first",
    "custom + ECONNREFUSED": "Check your base URL — is the server running?",
    "any + 429":       "You're rate limited. Wait or upgrade your plan."
  }
    