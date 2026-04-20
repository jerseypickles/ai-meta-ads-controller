/**
 * Zeus Code Tools — read-only access al codebase del proyecto.
 *
 * Seguridad:
 * - Sandbox: nunca salir de PROJECT_ROOT
 * - Blocklist: .env, .git, node_modules, dist, build, *.key, *.pem, credentials
 * - Cap tamaño: 50KB por archivo
 * - Cap cantidad: 200 archivos en list, 100 en grep, 25KB en grep output
 * - No ejecuta código. Solo read.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

// Sube desde este archivo hasta encontrar package.json = PROJECT_ROOT
function findProjectRoot() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = findProjectRoot();
const MAX_FILE_BYTES = 50 * 1024;
const MAX_LIST_FILES = 200;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_OUTPUT_BYTES = 25 * 1024;

const EXCLUDE_DIR_PATTERNS = [
  /^node_modules$/,
  /^\.git$/,
  /^\.next$/,
  /^dist$/,
  /^build$/,
  /^coverage$/,
  /^\.cache$/,
  /^logs?$/,
  /^\.DS_Store$/,
  /^\.claude$/,
  /^\.obsidian$/
];

const EXCLUDE_FILE_PATTERNS = [
  /^\.env/,                 // .env, .env.local, etc
  /\.key$/i,
  /\.pem$/i,
  /\.cert$/i,
  /\.p12$/i,
  /credentials[^/]*\.json$/i,
  /\.lock$/,                // yarn.lock, package-lock.json (big, no info útil)
  /^package-lock\.json$/,
  /secrets?[^/]*\.(json|yml|yaml|txt)$/i
];

// Tipos de archivo relevantes para análisis de código
const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.json', '.md', '.css', '.html',
  '.yml', '.yaml',
  '.sh'
]);

function isExcludedDir(name) {
  return EXCLUDE_DIR_PATTERNS.some(p => p.test(name));
}

function isExcludedFile(name) {
  return EXCLUDE_FILE_PATTERNS.some(p => p.test(name));
}

function sanitizePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') throw new Error('path requerido');
  // Remove leading slash, resolve relative
  const cleaned = rawPath.replace(/^\/+/, '');
  const resolved = path.resolve(PROJECT_ROOT, cleaned);
  // Must be inside PROJECT_ROOT
  if (!resolved.startsWith(PROJECT_ROOT + path.sep) && resolved !== PROJECT_ROOT) {
    throw new Error('path fuera del proyecto');
  }
  // Must not hit excluded segment
  const rel = path.relative(PROJECT_ROOT, resolved);
  const segments = rel.split(path.sep);
  for (const seg of segments) {
    if (isExcludedDir(seg)) throw new Error(`path dentro de dir excluido: ${seg}`);
  }
  const basename = path.basename(resolved);
  if (isExcludedFile(basename)) throw new Error(`archivo excluido: ${basename}`);
  return resolved;
}

/**
 * Lista archivos del proyecto — glob simplificado.
 * pattern: substring del path (ej "brain-analyzer", "ZeusPanel.jsx", "src/ai/")
 * extensions: filtrar por extensiones (ej [".js", ".jsx"])
 */
function listCodeFiles({ pattern = '', extensions = null, limit = 100 } = {}) {
  const results = [];
  const extSet = extensions ? new Set(extensions) : null;

  function walk(dir, depth = 0) {
    if (depth > 8 || results.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (isExcludedDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (isExcludedFile(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (extSet && !extSet.has(ext)) continue;
        if (!extSet && !CODE_EXTENSIONS.has(ext)) continue;
        const rel = path.relative(PROJECT_ROOT, full);
        if (pattern && !rel.toLowerCase().includes(pattern.toLowerCase())) continue;
        try {
          const stat = fs.statSync(full);
          results.push({
            path: rel,
            size: stat.size,
            modified: stat.mtime.toISOString()
          });
        } catch (_) {}
      }
    }
  }

  walk(PROJECT_ROOT);
  return results.slice(0, Math.min(limit, MAX_LIST_FILES));
}

/**
 * Lee un archivo del proyecto.
 */
function readCodeFile({ path: rawPath, start_line = 1, limit_lines = 500 } = {}) {
  const full = sanitizePath(rawPath);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error('no es archivo');

  const bytes = stat.size;
  const content = fs.readFileSync(full, 'utf8');
  const allLines = content.split('\n');
  const total = allLines.length;

  const startIdx = Math.max(0, (start_line || 1) - 1);
  const endIdx = Math.min(total, startIdx + (limit_lines || 500));
  const slice = allLines.slice(startIdx, endIdx).join('\n');

  // Cap hard size
  const capped = slice.length > MAX_FILE_BYTES ? slice.substring(0, MAX_FILE_BYTES) + '\n\n... [truncado, archivo más largo que cap]' : slice;

  return {
    path: path.relative(PROJECT_ROOT, full),
    total_lines: total,
    size_bytes: bytes,
    start_line: startIdx + 1,
    end_line: endIdx,
    content: capped,
    truncated: slice.length > MAX_FILE_BYTES
  };
}

/**
 * Grep simple en el proyecto.
 * pattern: string o regex-string
 * file_glob: substring del path (ej "src/ai", "brain")
 */
function grepCode({ pattern, file_glob = '', extensions = null, max_matches = 40, context_lines = 1 } = {}) {
  if (!pattern) throw new Error('pattern requerido');

  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (_) {
    // Fallback a literal string match
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  const files = listCodeFiles({
    pattern: file_glob,
    extensions,
    limit: 500
  });

  const matches = [];
  let totalBytes = 0;

  for (const f of files) {
    if (matches.length >= MAX_GREP_MATCHES) break;
    if (totalBytes >= MAX_GREP_OUTPUT_BYTES) break;

    let content;
    try {
      content = fs.readFileSync(path.join(PROJECT_ROOT, f.path), 'utf8');
    } catch (_) {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      if (re.test(lines[i])) {
        const ctxStart = Math.max(0, i - (context_lines || 0));
        const ctxEnd = Math.min(lines.length, i + (context_lines || 0) + 1);
        const snippet = lines.slice(ctxStart, ctxEnd).map((l, idx) => {
          const lineNum = ctxStart + idx + 1;
          return `${lineNum}${lineNum === i + 1 ? '→' : ':'} ${l.substring(0, 250)}`;
        }).join('\n');
        matches.push({
          path: f.path,
          line: i + 1,
          snippet
        });
        totalBytes += snippet.length;
      }
    }
  }

  return {
    pattern,
    files_searched: files.length,
    matches_count: matches.length,
    matches: matches.slice(0, max_matches),
    truncated: matches.length >= MAX_GREP_MATCHES
  };
}

/**
 * Overview rápido de la estructura del proyecto — árbol shallow.
 */
function codeOverview() {
  const root = PROJECT_ROOT;
  const tree = {};

  function walk(dir, obj, depth) {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (isExcludedDir(entry.name)) continue;
      if (isExcludedFile(entry.name)) continue;
      if (entry.isDirectory()) {
        obj[entry.name + '/'] = {};
        walk(path.join(dir, entry.name), obj[entry.name + '/'], depth + 1);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (depth === 0 || CODE_EXTENSIONS.has(ext)) {
          obj[entry.name] = null;
        }
      }
    }
  }

  walk(root, tree, 0);

  // Also read package.json summary
  let pkg = null;
  try {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg = {
        name: parsed.name,
        description: parsed.description,
        scripts: parsed.scripts,
        dependencies: Object.keys(parsed.dependencies || {}),
        devDependencies: Object.keys(parsed.devDependencies || {})
      };
    }
  } catch (_) {}

  return {
    project_root: path.basename(root),
    tree,
    package_info: pkg
  };
}

module.exports = {
  PROJECT_ROOT,
  listCodeFiles,
  readCodeFile,
  grepCode,
  codeOverview
};
