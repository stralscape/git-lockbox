'use strict';

const fs = require('fs');
const path = require('path');
const proc = require('./proc');
const repo = require('./repo');

const DEFAULT_DIST_FOLDER = 'dist';

/** True when child is parent itself or lives underneath it. */
function isPathInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/**
 * Resolve and validate the working-tree folder packaged by --dist-only.
 * The folder is packaged as-is from disk: Git tracking/ignore rules do not apply.
 */
function resolveDistFolder({ repoRoot, folder }) {
  const requested = String(folder || '').trim();
  if (!requested) {
    throw new Error('--dist-only needs a folder name (omit the value to use "dist").');
  }

  const repoReal = fs.realpathSync(path.resolve(repoRoot));
  const absolute = path.resolve(repoReal, requested);

  if (!path.isAbsolute(requested) && !isPathInside(repoReal, absolute)) {
    throw new Error('--dist-only folder must be inside the repository (use an absolute path to package a folder outside).');
  }

  let stats;
  try {
    stats = fs.statSync(absolute);
  } catch (err) {
    throw new Error(
      `Cannot package "${requested}": ${err.code === 'ENOENT' ? 'folder not found' : err.message}`
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`Cannot package "${requested}": not a directory.`);
  }

  const real = fs.realpathSync(absolute);
  if (!path.isAbsolute(requested) && !isPathInside(repoReal, real)) {
    throw new Error(`Cannot package "${requested}": the path resolves outside the repository via a symlink.`);
  }
  if (real === repoReal) {
    throw new Error('Cannot package the repository root; choose a subfolder.');
  }
  if (isPathInside(path.join(repoReal, '.git'), real)) {
    throw new Error('Cannot package the repository\'s .git directory.');
  }
  if (fs.existsSync(path.join(real, '.git'))) {
    throw new Error(`Cannot package "${requested}": the folder contains a .git entry.`);
  }
  if (fs.readdirSync(real).length === 0) {
    throw new Error(`Cannot package "${requested}": the folder is empty.`);
  }

  return real;
}

/**
 * Resolve the git commit to archive for whole-tree runs, verifying it exists.
 */
function resolveTreeish({ sourceCommit }) {
  const treeCheck = proc.runSync(repo.GIT, ['rev-parse', '--verify', '--quiet', sourceCommit]);
  if (treeCheck.status !== 0) {
    throw new Error(`Cannot archive: commit ${sourceCommit.slice(0, 10)} not found.`);
  }
  return sourceCommit;
}

/** Friendly label for logging/UI. */
function archiveModeLabel(distFolder) {
  return distFolder
    ? `working-tree folder "${distFolder}" (--dist-only) - packaged as-is from disk (tracking/ignore rules are not consulted)`
    : 'entire tracked tree (HEAD) - only committed files';
}

module.exports = {
  resolveTreeish,
  resolveDistFolder,
  archiveModeLabel,
  isPathInside,
  DEFAULT_DIST_FOLDER,
};
