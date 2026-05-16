# recon-report

`recon-report` is an npm CLI tool that turns raw cybersecurity notes and screenshots into professional HTML, PDF, or Markdown reports.

It is designed for HTB, CTF, OSCP/CPTS-style labs, and pentest reporting. You can use Claude for the best report draft, but the CLI also has a local fallback so it still works without an API key.

## Install

From this project folder during development:

```bash
npm install
npm link
```

After publishing:

```bash
npm install -g recon-report
```

## Quick Start

Create a report workspace:

```bash
recon-report init
```

Write your raw notes in `main.md`, then add screenshots under `img/`.

Generate a report:

```bash
recon-report run --type htb --format html
```

Generate a PDF from AI-written Markdown:

```bash
recon-report run --provider google --type htb --format pdf --save-md
```

Generate without AI:

```bash
recon-report run --no-ai --format html
```

## Commands

```bash
recon-report init
recon-report init --force
recon-report run
recon-report run --format html
recon-report run --format pdf
recon-report run --format md
recon-report run --type htb
recon-report run --type ctf
recon-report run --type pentest
recon-report run --type cpts
recon-report run --type oscp
recon-report run --input notes.md --img-dir screenshots --output reports
recon-report run --provider google --format pdf --save-md
recon-report setup --provider google
```

## AI Setup

Use Google AI Studio / Gemini:

```bash
recon-report setup --provider google
```

Then paste your key into `.env`:

```bash
RECON_REPORT_PROVIDER=google
GEMINI_API_KEY=your_google_ai_studio_key_here
GEMINI_MODEL=gemini-2.5-flash
```

You can also use Anthropic:

```bash
RECON_REPORT_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_api_key_here
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

If no API key is available, `recon-report` automatically uses the local fallback generator. Do not pass `--no-ai` when you want a polished AI-written report.

## Notes Format

There is no strict format. The parser accepts headings, freeform notes, commands, outputs, credentials, flags, service scan lines, and CVEs.

Example:

```markdown
TARGET: 10.10.11.42
MACHINE: Cascade (HTB)
OS: Windows
DIFFICULTY: Medium

# port scan
nmap -sC -sV -oA nmap/initial 10.10.11.42
22/tcp   open  ssh     OpenSSH 7.4
80/tcp   open  http    Apache 2.4.18

# web enum
gobuster dir -u http://10.10.11.42 -w /usr/share/wordlists/dirb/common.txt
found: /admin (302)
```

## Screenshots

Place screenshots in `img/`.

Supported extensions:

- `.png`
- `.jpg`
- `.jpeg`
- `.gif`
- `.webp`
- `.bmp`

Nested folders are supported:

```text
img/
  01-nmap.png
  exploit/02-shell.png
  privesc/03-root.png
```

Optional captions can be added in `img/captions.txt`:

```text
01-nmap.png: Initial Nmap scan showing exposed SSH and HTTP services.
exploit/02-shell.png: First shell as the low-privileged user.
```

## Outputs

HTML output is self-contained and includes:

- Embedded CSS.
- Embedded base64 images.
- Table of contents.
- Dark/light toggle.
- Print-friendly styles.
- Image lightbox.
- Severity badges.

PDF output uses Puppeteer. If Chrome is not available on your system, install the browser package used by Puppeteer:

```bash
npx puppeteer browsers install chrome
```

## Security Notes

Raw notes can contain real credentials and sensitive proof values. The generated report masks secrets, but AI mode sends the provided notes and image analysis to Anthropic. Use `--no-ai` for restricted environments.
