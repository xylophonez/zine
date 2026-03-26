# zine

Simple CLI for uploading files and shipping markdown blog content to Arweave.

## The 2 commands most people need

```bash
zine upload <path>
zine ship
```

- `zine upload <path>` uploads a single file and prints the txid.
- `zine ship` reads `./content`, uploads changed posts, uploads the manifest, and prints the manifest txid.

That final printed value is easy to pipe or store:

```bash
MANIFEST_ID=$(zine ship)
echo "$MANIFEST_ID"
```

## Install

### Use from source

```bash
git clone <your-repo-url> zine
cd zine
npm install
npm link
```

Then run `zine ...` anywhere.

### Install via npm (when published)

```bash
npm install -g zine-cli
```

## Wallet defaults

`zine` looks for a wallet in this order:

1. `--jwk /path/to/wallet.json`
2. `ARWEAVE_JWK`
3. `./wallet.json`
4. `~/.zine/wallet.json`

## Ship defaults

```bash
zine ship
```

Defaults used:

- Content directory: `./content`
- Manifest output path: `./dist/manifest.json`

Override content path either way:

```bash
zine ship ./my-content
zine ship --content ./my-content
```

Other common flags:

```bash
zine ship --manifest ./out/manifest.json
zine ship --include-drafts
zine ship --jwk ./wallet.json
```

## Upload examples

```bash
zine upload ./assets/hero.png
zine upload ./dist/manifest.json
zine upload ./notes.txt --content-type "text/plain; charset=utf-8"
```

## Markdown/frontmatter expected for `ship`

Each markdown file in `content` should have frontmatter like:

```md
---
title: "My Post"
banner: "<43-char-arweave-txid>"
slug: "my-post" # optional, filename is fallback
draft: false
---

Post body...
```

Required fields:

- `title`
- `banner` (43-char txid)

## Optional commands

```bash
zine validate
zine build
```

- `zine validate` checks content frontmatter and slugs.
- `zine build` writes/updates local manifest without uploading.

## Notes on distribution

For GitHub + npm distribution, this repo is already set up with a `bin` entry in `package.json`:

- `bin/zine.js` is the executable.
- Users can run with `npm link` locally.
- Publish with `npm publish` when ready.

If the package name `zine-cli` is taken, rename `name` in `package.json` (for example to your org scope: `@your-org/zine`).
