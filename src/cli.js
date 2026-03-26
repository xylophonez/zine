import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { ArweaveSigner, createData } from "arbundles";

const ARWEAVE_UPLOAD_URL = "https://up.arweave.net/tx";
const TXID_RE = /^[A-Za-z0-9_-]{43}$/;

const CONTENT_TYPE_BY_EXT = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".pdf": "application/pdf"
};

function parseArgv(argv) {
  const positionals = [];
  const flags = new Map();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq > -1) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
      continue;
    }

    const short = token.slice(1);
    if (short === "h") {
      flags.set("help", true);
      continue;
    }
    if (short === "c") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) flags.set("content", true);
      else {
        flags.set("content", next);
        i += 1;
      }
      continue;
    }
    if (short === "j") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) flags.set("jwk", true);
      else {
        flags.set("jwk", next);
        i += 1;
      }
      continue;
    }
    positionals.push(token);
  }

  return { positionals, flags };
}

function usage() {
  console.log(`zine - upload and publish to Arweave

Usage:
  zine ship [content-path] [--content ./content] [--manifest ./dist/manifest.json] [--jwk ./wallet.json]
  zine upload <file-path> [--content-type text/plain] [--jwk ./wallet.json]

What gets printed:
  zine ship   -> prints manifest txid
  zine upload -> prints file txid

Defaults:
  content:  ./content
  manifest: ./dist/manifest.json
  wallet:   --jwk, then ARWEAVE_JWK, then ./wallet.json, then ~/.zine/wallet.json

More:
  zine build [content-path] [--out ./dist/manifest.json]
  zine validate [content-path]
  zine help`);
}

function valueOrDefault(v, fallback) {
  return v === undefined || v === null || v === "" ? fallback : v;
}

function isTrue(v) {
  return v === true || String(v).toLowerCase() === "true";
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(inputPath) {
  if (!inputPath) return "";
  return isAbsolute(inputPath) ? inputPath : resolve(process.cwd(), inputPath);
}

function padBase64(v) {
  const missing = v.length % 4;
  if (missing === 0) return v;
  return `${v}${"=".repeat(4 - missing)}`;
}

function base64UrlToBuffer(v) {
  const normalized = padBase64(v.replace(/-/g, "+").replace(/_/g, "/"));
  return Buffer.from(normalized, "base64");
}

function bufferToBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function deriveAddressFromJwk(jwk) {
  if (!jwk || typeof jwk.n !== "string") {
    throw new Error("Invalid JWK: missing 'n' field");
  }
  const ownerBytes = base64UrlToBuffer(jwk.n);
  const digest = createHash("sha256").update(ownerBytes).digest();
  return bufferToBase64Url(digest);
}

async function resolveWalletPath(flags) {
  const candidates = [
    flags.get("jwk"),
    process.env.ARWEAVE_JWK,
    "./wallet.json",
    join(homedir(), ".zine", "wallet.json")
  ].filter(Boolean);

  for (const candidate of candidates) {
    const abs = normalizePath(String(candidate));
    if (await exists(abs)) return abs;
  }

  throw new Error(
    "Wallet not found. Use --jwk /path/to/wallet.json, set ARWEAVE_JWK, or place wallet at ./wallet.json or ~/.zine/wallet.json"
  );
}

async function loadSigner(flags) {
  const walletPath = await resolveWalletPath(flags);
  const jwk = JSON.parse(await readFile(walletPath, "utf8"));
  return {
    signer: new ArweaveSigner(jwk),
    address: deriveAddressFromJwk(jwk),
    walletPath
  };
}

function extractTxId(responseBody) {
  if (!responseBody) return "";
  const trimmed = responseBody.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.id === "string") return parsed.id;
    if (typeof parsed?.txid === "string") return parsed.txid;
    if (typeof parsed?.result?.id === "string") return parsed.result.id;
  } catch {
    // plain text response
  }
  return trimmed.replace(/^"|"$/g, "");
}

async function uploadData(data, signer, tags) {
  const dataItem = createData(data, signer, { tags });
  await dataItem.sign(signer);

  const res = await fetch(ARWEAVE_UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: dataItem.getRaw()
  });

  const bodyText = await res.text();
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${bodyText}`);

  const txid = extractTxId(bodyText) || dataItem.id;
  if (!txid) throw new Error(`Upload succeeded but txid missing: ${bodyText}`);
  return txid;
}

function contentTypeForPath(path) {
  const ext = extname(path).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream";
}

async function walkMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(abs)));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext === ".md" || ext === ".markdown") files.push(abs);
  }
  return files;
}

function stripQuotes(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseScalar(v) {
  const raw = stripQuotes(v);
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function parseArrayInline(v) {
  const inner = v.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((x) => parseScalar(x.trim()))
    .filter((x) => x !== "");
}

function parseFrontmatterYamlish(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (!match) continue;

    const key = match[1];
    const valuePart = match[2].trim();
    if (!valuePart) {
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const listMatch = lines[j].match(/^\s*-\s+(.*)$/);
        if (!listMatch) break;
        list.push(parseScalar(listMatch[1].trim()));
        j += 1;
      }
      if (list.length > 0) {
        out[key] = list;
        i = j - 1;
      } else {
        out[key] = "";
      }
      continue;
    }

    if (valuePart.startsWith("[") && valuePart.endsWith("]")) out[key] = parseArrayInline(valuePart);
    else out[key] = parseScalar(valuePart);
  }

  return out;
}

function extractFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: normalized };
  return {
    frontmatter: parseFrontmatterYamlish(normalized.slice(4, end)),
    body: normalized.slice(end + 5)
  };
}

function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-_/]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^\/+|\/+$/g, "");
}

function normalizeStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

function markdownToPlainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/[#>*_~\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIsoDateOrNull(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizePost({ sourcePath, raw, frontmatter, body, contentDir, authorAddress }) {
  const stem = basename(sourcePath, extname(sourcePath));
  const slug = slugify(frontmatter.slug || frontmatter.path || stem);
  const plain = markdownToPlainText(body);
  const wordCount = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  const contentHash = createHash("sha256").update(raw).digest("hex");

  return {
    id: createHash("sha1").update(`${slug}:${contentHash}`).digest("hex"),
    sourcePath: relative(contentDir, sourcePath),
    slug,
    title: String(frontmatter.title || "").trim(),
    description: String(frontmatter.description || frontmatter.desc || "").trim(),
    categories: normalizeStringArray(frontmatter.categories ?? frontmatter.category),
    tags: normalizeStringArray(frontmatter.tags ?? frontmatter.tag),
    date: toIsoDateOrNull(frontmatter.date),
    updated: toIsoDateOrNull(frontmatter.updated),
    draft: Boolean(frontmatter.draft ?? false),
    bannerTxId: String(frontmatter.banner || "").trim(),
    authorAddress,
    wordCount,
    readingTime: Math.max(1, Math.ceil(wordCount / 200)),
    excerpt: plain.slice(0, 220),
    contentHash,
    frontmatter
  };
}

function validatePost(post) {
  const errors = [];
  if (!post.title) errors.push(`missing required field \"title\" (${post.sourcePath})`);
  if (!post.slug) errors.push(`missing/invalid slug (${post.sourcePath})`);
  if (!post.bannerTxId) errors.push(`missing required field \"banner\" (${post.sourcePath})`);
  if (post.bannerTxId && !TXID_RE.test(post.bannerTxId)) {
    errors.push(`invalid banner txid format (${post.sourcePath}): ${post.bannerTxId}`);
  }
  return errors;
}

function validateCollection(posts) {
  const errors = [];
  const slugs = new Set();
  for (const post of posts) {
    errors.push(...validatePost(post));
    if (slugs.has(post.slug)) errors.push(`duplicate slug \"${post.slug}\"`);
    slugs.add(post.slug);
  }
  return errors;
}

async function collectPosts(contentDir, authorAddress) {
  const files = await walkMarkdownFiles(contentDir);
  const posts = [];
  for (const path of files) {
    const raw = await readFile(path, "utf8");
    const { frontmatter, body } = extractFrontmatter(raw);
    posts.push(normalizePost({ sourcePath: path, raw, frontmatter, body, contentDir, authorAddress }));
  }
  posts.sort((a, b) => a.slug.localeCompare(b.slug));
  return posts;
}

async function loadManifest(path) {
  if (!(await exists(path))) return null;
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function mapPostsBySlug(posts) {
  const map = new Map();
  for (const post of posts || []) {
    if (post?.slug) map.set(post.slug, post);
  }
  return map;
}

function resolveContentDir(flags, positionalPath) {
  return normalizePath(String(valueOrDefault(flags.get("content"), positionalPath || "./content")));
}

function resolveManifestPath(flags) {
  return normalizePath(String(valueOrDefault(flags.get("manifest"), flags.get("out") || "./dist/manifest.json")));
}

async function cmdUpload(positionals, flags) {
  const path = normalizePath(String(positionals[0] || ""));
  if (!path) throw new Error("Missing path. Usage: zine upload <file-path>");
  if (!(await exists(path))) throw new Error(`File not found: ${path}`);

  const { signer } = await loadSigner(flags);
  const raw = await readFile(path);
  const contentType = String(valueOrDefault(flags.get("content-type"), contentTypeForPath(path)));
  const txid = await uploadData(raw, signer, [
    { name: "Content-Type", value: contentType },
    { name: "App-Name", value: "zine" },
    { name: "Type", value: "file" },
    { name: "File-Name", value: basename(path) }
  ]);

  console.log(txid);
}

async function cmdBuild(positionals, flags) {
  const { address } = await loadSigner(flags);
  const contentDir = resolveContentDir(flags, positionals[0]);
  const manifestPath = resolveManifestPath(flags);

  if (!(await exists(contentDir))) throw new Error(`Content directory not found: ${contentDir}`);

  const existing = await loadManifest(manifestPath);
  const existingBySlug = mapPostsBySlug(existing?.posts || []);
  const posts = await collectPosts(contentDir, address);
  const errors = validateCollection(posts);
  if (errors.length) throw new Error(`Build failed:\n- ${errors.join("\n- ")}`);

  const merged = posts.map((post) => {
    const prev = existingBySlug.get(post.slug);
    if (!prev) return post;
    return {
      ...post,
      postTxId: prev.postTxId || null,
      publishedAt: prev.publishedAt || null
    };
  });

  const manifest = {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    authorAddress: address,
    sourceDir: contentDir,
    postCount: merged.length,
    posts: merged
  };

  await writeJson(manifestPath, manifest);
  console.error(`manifest built: ${manifestPath}`);
}

async function cmdValidate(positionals, flags) {
  const authorAddress = "unknown";
  const contentDir = resolveContentDir(flags, positionals[0]);
  if (!(await exists(contentDir))) throw new Error(`Content directory not found: ${contentDir}`);
  const posts = await collectPosts(contentDir, authorAddress);
  const errors = validateCollection(posts);

  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.error(`ok: ${posts.length} posts validated`);
}

async function cmdShip(positionals, flags) {
  const { signer, address } = await loadSigner(flags);
  const contentDir = resolveContentDir(flags, positionals[0]);
  const manifestPath = resolveManifestPath(flags);
  const includeDrafts = isTrue(flags.get("include-drafts"));

  if (!(await exists(contentDir))) throw new Error(`Content directory not found: ${contentDir}`);

  const rawPosts = await collectPosts(contentDir, address);
  const errors = validateCollection(rawPosts);
  if (errors.length) throw new Error(`Ship failed:\n- ${errors.join("\n- ")}`);

  const previous = await loadManifest(manifestPath);
  const previousBySlug = mapPostsBySlug(previous?.posts || []);
  const nowIso = new Date().toISOString();

  let uploaded = 0;
  let skipped = 0;
  const posts = [];

  for (const post of rawPosts) {
    const prev = previousBySlug.get(post.slug);
    const unchanged =
      prev && prev.contentHash === post.contentHash && typeof prev.postTxId === "string" && prev.postTxId.length > 0;

    if (post.draft && !includeDrafts) {
      skipped += 1;
      posts.push({ ...post, postTxId: prev?.postTxId || null, publishedAt: prev?.publishedAt || null });
      continue;
    }

    if (unchanged) {
      skipped += 1;
      posts.push({ ...post, postTxId: prev.postTxId, publishedAt: prev.publishedAt || nowIso });
      continue;
    }

    const markdownPath = join(contentDir, post.sourcePath);
    const markdown = await readFile(markdownPath, "utf8");
    const postTxId = await uploadData(markdown, signer, [
      { name: "Content-Type", value: "text/markdown; charset=utf-8" },
      { name: "App-Name", value: "zine" },
      { name: "Type", value: "blog-post" },
      { name: "Slug", value: post.slug },
      { name: "Title", value: post.title },
      { name: "Banner", value: post.bannerTxId },
      { name: "Author", value: address }
    ]);

    uploaded += 1;
    posts.push({ ...post, postTxId, publishedAt: nowIso });
    console.error(`uploaded post ${post.slug} -> ${postTxId}`);
  }

  const manifest = {
    schemaVersion: "1.0.0",
    generatedAt: nowIso,
    authorAddress: address,
    sourceDir: contentDir,
    postCount: posts.length,
    uploadedCount: uploaded,
    skippedCount: skipped,
    posts
  };

  const manifestTxId = await uploadData(JSON.stringify(manifest, null, 2), signer, [
    { name: "Content-Type", value: "application/json; charset=utf-8" },
    { name: "App-Name", value: "zine" },
    { name: "Type", value: "manifest" },
    { name: "Author", value: address }
  ]);

  manifest.manifestTxId = manifestTxId;
  await writeJson(manifestPath, manifest);

  console.error(`ship done uploaded=${uploaded} skipped=${skipped} manifest=${manifestPath}`);
  console.log(manifestTxId);
}

function normalizeCommand(cmd, subcmd, rest) {
  if (cmd === "help") return ["help", null, rest];
  if (cmd === "publish") return ["ship", null, rest];
  if (cmd === "up") return ["upload", null, rest];
  return [cmd, subcmd, rest];
}

export async function main() {
  const { positionals, flags } = parseArgv(process.argv.slice(2));
  const [cmd, subcmd, rest] = normalizeCommand(positionals[0], positionals[1], positionals.slice(2));

  if (!cmd || isTrue(flags.get("help")) || cmd === "help") {
    usage();
    return;
  }

  if (cmd === "upload") {
    const args = subcmd ? [subcmd, ...rest] : rest;
    await cmdUpload(args, flags);
    return;
  }

  if (cmd === "ship") {
    const args = subcmd ? [subcmd, ...rest] : rest;
    await cmdShip(args, flags);
    return;
  }

  if (cmd === "build") {
    const args = subcmd ? [subcmd, ...rest] : rest;
    await cmdBuild(args, flags);
    return;
  }

  if (cmd === "validate") {
    const args = subcmd ? [subcmd, ...rest] : rest;
    await cmdValidate(args, flags);
    return;
  }

  usage();
  process.exit(1);
}
