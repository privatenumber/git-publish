# Two-Worktree Isolation Design

**Date:** 2025-11-08
**Status:** Approved

## Problem

Pack hooks (prepare, prepack) currently run in the user's working directory, causing files to be modified there. The current fix uses a custom `copyDirectory` implementation with monorepo special-casing and symlink management, adding ~100 lines of complex logic.

## Solution

Use Git's native worktree mechanism to create two isolated environments:

1. **Pack worktree:** Clean checkout of HEAD where pack runs
2. **Publish worktree:** Clean checkout of publish branch where tarball extracts

This eliminates file copying logic while maintaining fast execution via symlinked node_modules.

## Architecture

```
User's working directory (untouched)

/tmp/git-publish-xxx/
  ├── pack-worktree/      (HEAD checkout, symlinked node_modules)
  │   └─> Run pack here (isolated)
  │       └─> Tarball output
  │
  └── publish-worktree/   (publish branch, empty)
      └─> Extract tarball here
          └─> Commit & push
```

## Implementation Flow

### 1. Create Publish Worktree (existing)

```typescript
const publishWorktreePath = path.join(temporaryDirectory, 'publish-worktree');
await spawn('git', ['worktree', 'add', '--force', publishWorktreePath, 'HEAD']);

// Checkout publish branch or create orphan
if (fresh || !remoteBranchExists) {
  await spawn('git', ['checkout', '--orphan', localTemporaryBranch], { cwd: publishWorktreePath });
} else {
  await spawn('git', ['fetch', '--depth=1', remote, `${publishBranch}:${localTemporaryBranch}`]);
  await spawn('git', ['symbolic-ref', 'HEAD', `refs/heads/${localTemporaryBranch}`], { cwd: publishWorktreePath });
}

// Clear completely
await spawn('git', ['rm', '--cached', '-r', ':/'], { cwd: publishWorktreePath }).catch(() => {});
await spawn('git', ['clean', '-fdx'], { cwd: publishWorktreePath });
```

### 2. Create Pack Worktree (new)

```typescript
const packWorktreePath = path.join(temporaryDirectory, 'pack-worktree');
await spawn('git', ['worktree', 'add', '--force', packWorktreePath, 'HEAD'], { cwd: gitRootPath });
```

### 3. Symlink node_modules (new)

**Regular package:**
```typescript
const nodeModulesPath = path.join(cwd, 'node_modules');
await fs.symlink(
  nodeModulesPath,
  path.join(packWorktreePath, 'node_modules'),
  'dir'
);
```

**Monorepo:**
```typescript
// Root node_modules
const rootNodeModules = path.join(gitRootPath, 'node_modules');
await fs.symlink(
  rootNodeModules,
  path.join(packWorktreePath, 'node_modules'),
  'dir'
);

// Package node_modules (if exists)
const packageNodeModules = path.join(cwd, 'node_modules');
await fs.symlink(
  packageNodeModules,
  path.join(packWorktreePath, gitSubdirectory, 'node_modules'),
  'dir'
);
```

### 4. Run Pack (modified)

```typescript
const packArgs = packageManager === 'bun'
  ? ['pm', 'pack', '--destination', packTarballDirectory]
  : ['pack', '--pack-destination', packTarballDirectory];

const packCwd = gitSubdirectory
  ? path.join(packWorktreePath, gitSubdirectory)
  : packWorktreePath;

await spawn(packageManager, packArgs, { cwd: packCwd });
```

### 5. Extract (existing)

```typescript
await extractTarball(tarballPath, publishWorktreePath);
```

### 6. Cleanup (modified)

```typescript
await spawn('git', ['worktree', 'remove', '--force', publishWorktreePath]);
await spawn('git', ['worktree', 'remove', '--force', packWorktreePath]);
await spawn('git', ['branch', '-D', localTemporaryBranch]);
await fs.rm(temporaryDirectory, { recursive: true, force: true });
```

## Benefits

1. **Simplicity:** Eliminates ~90 lines of custom file copying and filtering logic
2. **Performance:** No file copying, only symlinks for node_modules
3. **Correctness:** Uses Git's native worktree mechanism instead of manual operations
4. **Maintainability:** Less code, clearer intent, easier to understand

## Code Changes

**Remove:**
- `copyDirectory` helper function
- Monorepo special-case copying logic
- Recursive node_modules exclusion logic

**Add:**
- Pack worktree creation
- Simplified node_modules symlinking

**Modify:**
- `packPackage()` function signature and implementation
- Cleanup to remove both worktrees

## Testing

All existing tests should pass without modification:
- `prepack hook does not modify working directory` - verifies isolation
- `dependencies are accessible in pack hooks` - verifies symlinks work
- `monorepo workspace structure is accessible` - verifies monorepo handling
- All other existing tests
