# 404reportor

[![npm version](https://img.shields.io/npm/v/404reportor.svg)](https://www.npmjs.com/package/404reportor)
[![License](https://img.shields.io/npm/l/404reportor.svg)](https://github.com/yourusername/404reportor/blob/main/LICENSE)
[![NPM downloads](https://img.shields.io/npm/dt/404reportor.svg)](https://www.npmjs.com/package/404reportor)

**404reportor** is an npm CLI tool that transforms raw cybersecurity notes and screenshots into polished HTML, PDF, or Markdown reports. It works for HTB, CTF, OSCP/CPTS style labs and pentest reporting. By default it uses Google Gemini or Anthropic Claude for AI‑enhanced drafts, but it also provides a local fallback when no API key is configured.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
- [AI Setup](#ai-setup)
- [Notes Format](#notes-format)
- [Screenshots](#screenshots)
- [Outputs](#outputs)
- [Security Considerations](#security-considerations)
- [Contributing](#contributing)
- [License](#license)

## Installation

### Development (from source)

```bash
git clone https://github.com/yourusername/404reportor.git
cd 404reportor
npm install
npm link   # makes the `404reportor` command available globally on your machine
```

### After publishing (global installation)

```bash
npm install -g 404reportor
```

## Quick Start

Create a new workspace scaffold:

```bash
404reportor init
```

Edit `main.md` with your raw notes and place any screenshots in the `img/` directory.

Generate a report:

```bash
# Basic HTML report
404reportor run --type htb --format html

# PDF report with AI‑generated markdown saved alongside
404reportor run --provider google --type htb --format pdf --save-md

# Run completely locally (no API key needed)
404reportor run --no-ai --format html
```

## Commands

| Command | Description |
|---------|-------------|
| `404reportor init [--force]` | Scaffold `main.md`, `img/`, `img/captions.txt`, and `.env`. |
| `404reportor setup --provider <google|anthropic>` | Create or update `.env` with the selected AI provider key. |
| `404reportor run [options]` | Parse notes, process screenshots, generate and render the report. |
| `404reportor --help` | Show global help. |
| `404reportor <command> --help` | Show help for a specific command. |

### Run options (selected)

- `--provider <google|anthropic|auto>` – Choose AI provider (default auto‑detect).
- `--type <htb|ctf|pentest|cpts|oscp>` – Report type (affects terminology).
- `--format <html|pdf|md>` – Output format.
- `--save-md` – Save the AI‑generated Markdown draft alongside the final output.
- `--no-ai` – Skip AI generation and use the local fallback.

## AI Setup

Configure an API key for the desired provider:

```bash
# Google Gemini / AI Studio
404reportor setup --provider google
# Anthropic Claude
404reportor setup --provider anthropic
```

Open the generated `.env` and paste your key:

```dotenv
RECON_REPORT_PROVIDER=google
GEMINI_API_KEY=your_google_api_key
GEMINI_MODEL=gemini-2.5-flash

# or for Anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

If no key is present, the CLI falls back to the local report generator automatically.

## Notes Format

The parser is flexible – any markdown document containing headings, commands, outputs, credentials, service scans, or CVE references will be processed. Example `main.md`:

```markdown
TARGET: 10.10.11.42
MACHINE: Cascade (HTB)
OS: Windows
DIFFICULTY: Medium

# Port scan
nmap -sC -sV -oA nmap/initial 10.10.11.42
22/tcp   open  ssh     OpenSSH 7.4
80/tcp   open  http    Apache 2.4.18

# Web enumeration
gobuster dir -u http://10.10.11.42 -w /usr/share/wordlists/dirb/common.txt
found: /admin (302)
```

## Screenshots

Place screenshots in `img/`. Supported extensions:

- `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`

Nested directories are allowed:

```text
img/
  01-nmap.png
  exploit/02-shell.png
  privesc/03-root.png
```

Optional captions can be added in `img/captions.txt`:

```text
01-nmap.png: Initial Nmap scan showing exposed SSH and HTTP services.
exploit/02-shell.png: First shell as the low‑privileged user.
```

## Outputs

- **HTML** – Self‑contained with embedded CSS, base64 images, table of contents, dark/light toggle, print‑friendly styles, image lightbox, and severity badges.
- **PDF** – Generated via Puppeteer. If Chrome is unavailable, install the bundled browser:

```bash
npx puppeteer browsers install chrome
```
- **Markdown** – Raw AI‑generated draft (when `--save-md` is used).

## Security Considerations

Raw notes may contain real credentials or sensitive data. The generated report masks secrets, but AI mode sends notes and image analysis to the chosen provider. Use `--no-ai` for isolated environments.

## Contributing

Contributions are welcome! Follow these steps:

1. **Fork** the repository and clone your fork.
2. Create a feature branch:

   ```bash
   git checkout -b feature/awesome-feature
   ```
3. Install dependencies and link locally:

   ```bash
   npm install
   npm link
   ```
4. Make your changes, ensuring code follows existing style and includes appropriate tests (if applicable).
5. Run linting and format checks:

   ```bash
   npm run lint   # (if a lint script is defined)
   npm run format # (if a format script is defined)
   ```
6. Commit with a clear message and push to your fork.
7. Open a Pull Request against `main`. Please include:
   - A description of the change.
   - Any relevant screenshots or examples.
   - Instructions for testing.

Please adhere to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT © 2024‑2026
