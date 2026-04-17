#!/usr/bin/env node

const http = require('http');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const crypto = require('crypto');

const { installPostReceiveHook } = require('./install-hook.js');

const PORT = process.env.PORT || 8000;
const GIT_REPOS_PATH = process.env.GIT_REPOS_PATH || '/var/git/repos';
const LFS_OBJECTS_PATH = process.env.LFS_OBJECTS_PATH || '/var/git/lfs-objects';
const MAX_BODY_BYTES = 1024 * 1024; // 1MB limit for request bodies

// ─── LFS helpers ─────────────────────────────────────────────────────
function isValidOid(oid) {
  return typeof oid === 'string' && /^[0-9a-f]{64}$/.test(oid);
}

function lfsObjectPath(oid) {
  return path.join(LFS_OBJECTS_PATH, oid.substring(0, 2), oid.substring(2, 4), oid);
}

// ─── Validation helpers ──────────────────────────────────────────────
// Validate repo name to prevent path traversal
function isValidRepoName(name) {
  // Only allow alphanumeric, dash, underscore, dot
  return /^[a-zA-Z0-9_.-]+$/.test(name);
}

// Parse query string without url module
function parseQueryString(queryStr) {
  const result = {};
  if (queryStr) {
    queryStr.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      result[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
  }
  return result;
}

// Handle git smart HTTP protocol requests
function handleGitSmartHTTP(req, res, repoName, service, queryStr) {
  if (!isValidRepoName(repoName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid repository name' }));
    return;
  }

  const repoPath = path.join(GIT_REPOS_PATH, repoName);

  // Prevent directory traversal
  if (!repoPath.startsWith(GIT_REPOS_PATH)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid path' }));
    return;
  }

  // Determine which git command to use
  let gitCommand;
  if (service === 'git-upload-pack') {
    gitCommand = 'upload-pack';
  } else if (service === 'git-receive-pack') {
    gitCommand = 'receive-pack';
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid service' }));
    return;
  }

  // Build git command - use --advertise-refs only for discovery requests (GET /info/refs)
  const isDiscoveryRequest = req.method === 'GET' && req.url.includes('/info/refs');
  // -c http.receivepack=true: enables push over smart HTTP (disabled by default)
  // -c safe.directory=*: repos may be owned by a different UID (root vs git user)
  const gitArgs = ['-c', 'http.receivepack=true', '-c', 'safe.directory=*', gitCommand, '--stateless-rpc'];
  if (isDiscoveryRequest) {
    gitArgs.push('--advertise-refs');
  }
  gitArgs.push(repoPath);

  // Spawn git subprocess
  const git = spawn('git', gitArgs);

  // Set content-type per git smart HTTP spec (RFC 6570):
  // Discovery (GET /info/refs): application/x-git-<service>-advertisement
  // Pack exchange (POST):       application/x-git-<service>-result
  const suffix = isDiscoveryRequest ? 'advertisement' : 'result';
  const contentType = `application/x-${service}-${suffix}`;

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });

  // Handle git process errors
  git.on('error', (err) => {
    console.error(`[ERROR] Git process error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Git error' }));
  });

  // Handle EPIPE on git stdin (git process may exit before we finish writing)
  git.stdin.on('error', (err) => {
    if (err.code !== 'EPIPE') console.error(`[ERROR] git stdin: ${err.message}`);
  });

  // Pipe request body to git stdin
  if (req.method === 'POST') {
    req.pipe(git.stdin);
  } else {
    git.stdin.end();
  }

  // For discovery requests (GET /info/refs), wrap in pkt-line format
  if (isDiscoveryRequest) {
    // Send service announcement in pkt-line format (RFC 5816)
    // Format: 4-digit hex length + message (length includes the 4 hex digits)
    const serviceMsg = `# service=${service}\n`;
    const totalLength = Buffer.byteLength(serviceMsg) + 4;
    const servicePktLine = totalLength.toString(16).padStart(4, '0');
    res.write(servicePktLine + serviceMsg);
    res.write('0000'); // Flush packet (no newline - pkt-line is raw binary)
  }

  // Pipe git stdout to response
  git.stdout.pipe(res);

  // Log stderr
  git.stderr.on('data', (chunk) => {
    console.error(`[GIT STDERR] ${chunk.toString('utf8').trim()}`);
  });

  // Handle git process exit
  git.on('exit', (code) => {
    if (code !== 0) {
      console.log(`[INFO] Git process exited with code ${code}`);
    }
  });
}

const server = http.createServer((req, res) => {
  // Parse URL manually to avoid deprecation warning
  const questionMarkIndex = req.url.indexOf('?');
  const pathname = questionMarkIndex !== -1 ? req.url.substring(0, questionMarkIndex) : req.url;
  const queryStr = questionMarkIndex !== -1 ? req.url.substring(questionMarkIndex + 1) : '';
  const query = parseQueryString(queryStr);

  console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

  // Health check endpoint
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Repository creation endpoint: POST /repos with JSON body {name: "repo-name"}
  if (pathname === '/repos' && req.method === 'POST') {
    let body = '';
    let bodyBytes = 0;
    req.on('data', (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      let repoName;

      // Try to get repo name from JSON body
      try {
        const bodyData = JSON.parse(body);
        repoName = bodyData.name || query.name;
      } catch (e) {
        // If no JSON, try query parameter
        repoName = query.name;
      }

      if (!repoName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Repository name required (POST body {name: "..."} or ?name=...)' }));
        return;
      }

      if (!isValidRepoName(repoName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid repository name (alphanumeric, dash, underscore, dot only)' }));
        return;
      }

      const repoPath = path.join(GIT_REPOS_PATH, repoName + '.git');

      // Prevent directory traversal
      if (!repoPath.startsWith(GIT_REPOS_PATH)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid path' }));
        return;
      }

      // Check if repo already exists
      if (fs.existsSync(repoPath)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Repository already exists' }));
        return;
      }

      // Create bare repository
      const git = spawn('git', ['init', '--bare', repoPath]);

      let error = '';
      git.stderr.on('data', (chunk) => {
        error += chunk.toString();
      });

      git.on('error', (err) => {
        console.error(`[ERROR] Failed to spawn git init: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create repository' }));
      });

      git.on('exit', (code) => {
        if (code === 0) {

          // Set HEAD to main in the bare repo immediately
          try {
            fs.writeFileSync(path.join(repoPath, 'HEAD'), 'ref: refs/heads/main\n');
          } catch (e) {
            console.error(`[ERROR] Failed to set HEAD: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to initialize repository' }));
            return;
          }

          // Create initial commit SYNCHRONOUSLY before responding
          // This ensures the commit objects exist when clone requests arrive
          const tmpDir = path.join(os.tmpdir(), `ax-git-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);

          try {
            fs.mkdirSync(tmpDir, { recursive: true });

            // Create an empty initial commit so origin/main exists.
            // The sidecar expects origin/main for fetch+reset; native git
            // can clone empty repos but the separate-gitdir workflow needs a ref.
            const commands = [
              { args: ['init', '-b', 'main'], name: 'git init' },
              { args: ['config', 'user.name', 'init'], name: 'git config user.name' },
              { args: ['config', 'user.email', 'init@local'], name: 'git config user.email' },
              { args: ['commit', '--allow-empty', '-m', 'init'], name: 'git commit' },
              { args: ['remote', 'add', 'origin', repoPath], name: 'git remote add' },
              { args: ['push', '-u', 'origin', 'main'], name: 'git push' }
            ];

            for (const cmd of commands) {
              const result = spawnSync('git', cmd.args, { cwd: tmpDir, encoding: 'utf-8' });
              if (result.status !== 0 && result.status !== null) {
                const stderr = (result.stderr || '').trim();
                // Config commands are idempotent — warn only. Critical commands must succeed.
                const critical = ['git commit', 'git push'];
                if (critical.includes(cmd.name)) {
                  throw new Error(`${cmd.name} failed (exit ${result.status}): ${stderr}`);
                }
                console.warn(`[WARN] ${cmd.name} returned non-zero exit code ${result.status}: ${stderr}`);
              }
            }

            // Clean up temp directory
            try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) { /* best-effort */ }

            // Install post-receive hook for skills reconciliation.
            // Must succeed — if we return 201 without a hook, the agent
            // will push changes that never trigger reconcile. Fail hard.
            try {
              installPostReceiveHook(repoPath, repoName);
            } catch (hookErr) {
              console.error(`[ERROR] Failed to install post-receive hook: ${hookErr.message}`);
              // Clean up the bare repo so retries aren't permanently blocked
              // by the 409 "Repository already exists" branch. Without this,
              // a hook-install failure orphans the bare repo on disk and the
              // agent can never be re-provisioned. Best-effort — same style
              // as the tmpDir cleanup above.
              try {
                fs.rmSync(repoPath, { recursive: true, force: true });
                console.error(`[INFO] Removed orphan bare repo after hook failure: ${repoPath}`);
              } catch (cleanupErr) {
                console.error(`[ERROR] Failed to clean up orphan bare repo ${repoPath}: ${cleanupErr.message}`);
              }
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to install hook', details: hookErr.message }));
              return;
            }

            // Now respond - the repo has the initial commit and is ready for cloning
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'created',
              name: repoName,
              path: repoPath
            }));
          } catch (e) {
            console.error(`[ERROR] Failed to create initial commit: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to initialize repository' }));
          }
        } else {
          const errorMsg = error || `exit code ${code}`;
          console.error(`[ERROR] git init --bare failed: ${errorMsg}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to create repository', details: errorMsg }));
        }
      });
    });
    return;
  }

  // Git smart HTTP protocol - GET /repo.git/info/refs?service=git-upload-pack
  const gitRefMatch = pathname.match(/^\/([a-zA-Z0-9_.-]+\.git)\/info\/refs$/);
  if (gitRefMatch && req.method === 'GET') {
    const repoName = gitRefMatch[1];
    const service = query.service;
    if (service) {
      handleGitSmartHTTP(req, res, repoName, service, queryStr);
      return;
    }
  }

  // Git smart HTTP protocol - POST /repo.git/git-upload-pack or git-receive-pack
  const gitUploadMatch = pathname.match(/^\/([a-zA-Z0-9_.-]+\.git)\/(git-upload-pack|git-receive-pack)$/);
  if (gitUploadMatch && req.method === 'POST') {
    const repoName = gitUploadMatch[1];
    const service = gitUploadMatch[2];
    handleGitSmartHTTP(req, res, repoName, service, queryStr);
    return;
  }

  // ─── Git LFS Batch API ────────────────────────────────────────────
  // POST /{repo}.git/info/lfs/objects/batch
  const lfsBatchMatch = pathname.match(/^\/([a-zA-Z0-9_.-]+\.git)\/info\/lfs\/objects\/batch$/);
  if (lfsBatchMatch && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/vnd.git-lfs+json' });
        res.end(JSON.stringify({ message: 'Invalid JSON' }));
        return;
      }

      const operation = parsed.operation; // "upload" or "download"
      const objects = parsed.objects || [];
      const baseUrl = `http://${req.headers.host}`;

      const responseObjects = objects.map((obj) => {
        if (!isValidOid(obj.oid)) {
          return { oid: obj.oid, size: obj.size, error: { code: 422, message: 'Invalid OID' } };
        }
        const objPath = lfsObjectPath(obj.oid);
        const exists = fs.existsSync(objPath);

        if (operation === 'upload') {
          if (exists) {
            // Already uploaded — return empty actions (client skips upload)
            return { oid: obj.oid, size: obj.size };
          }
          return {
            oid: obj.oid,
            size: obj.size,
            actions: {
              upload: { href: `${baseUrl}/lfs/objects/${obj.oid}` },
              verify: { href: `${baseUrl}/lfs/objects/${obj.oid}/verify` },
            },
          };
        }

        // download
        if (!exists) {
          return { oid: obj.oid, size: obj.size, error: { code: 404, message: 'Not found' } };
        }
        return {
          oid: obj.oid,
          size: obj.size,
          actions: {
            download: { href: `${baseUrl}/lfs/objects/${obj.oid}` },
          },
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/vnd.git-lfs+json' });
      res.end(JSON.stringify({ transfer: 'basic', objects: responseObjects }));
    });
    return;
  }

  // ─── Git LFS Object Upload ──────────────────────────────────────
  // PUT /lfs/objects/{oid}
  const lfsUploadMatch = pathname.match(/^\/lfs\/objects\/([0-9a-f]{64})$/);
  if (lfsUploadMatch && req.method === 'PUT') {
    const oid = lfsUploadMatch[1];
    const objPath = lfsObjectPath(oid);
    const tmpPath = path.join(LFS_OBJECTS_PATH, '.tmp', `${oid}-${Date.now()}`);

    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });

    const hash = crypto.createHash('sha256');
    const stream = fs.createWriteStream(tmpPath);

    req.on('data', (chunk) => {
      hash.update(chunk);
      stream.write(chunk);
    });

    req.on('end', () => {
      stream.end(() => {
        const computed = hash.digest('hex');
        if (computed !== oid) {
          try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
          res.writeHead(422, { 'Content-Type': 'application/vnd.git-lfs+json' });
          res.end(JSON.stringify({ message: `SHA256 mismatch: expected ${oid}, got ${computed}` }));
          return;
        }
        // Move to final location
        fs.mkdirSync(path.dirname(objPath), { recursive: true });
        fs.renameSync(tmpPath, objPath);
        res.writeHead(200);
        res.end();
      });
    });
    return;
  }

  // ─── Git LFS Object Download ────────────────────────────────────
  // GET /lfs/objects/{oid}
  const lfsDownloadMatch = pathname.match(/^\/lfs\/objects\/([0-9a-f]{64})$/);
  if (lfsDownloadMatch && req.method === 'GET') {
    const oid = lfsDownloadMatch[1];
    const objPath = lfsObjectPath(oid);

    if (!fs.existsSync(objPath)) {
      res.writeHead(404, { 'Content-Type': 'application/vnd.git-lfs+json' });
      res.end(JSON.stringify({ message: 'Not found' }));
      return;
    }

    const stat = fs.statSync(objPath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
    });
    fs.createReadStream(objPath).pipe(res);
    return;
  }

  // ─── Git LFS Object Verify ──────────────────────────────────────
  // POST /lfs/objects/{oid}/verify
  const lfsVerifyMatch = pathname.match(/^\/lfs\/objects\/([0-9a-f]{64})\/verify$/);
  if (lfsVerifyMatch && req.method === 'POST') {
    const oid = lfsVerifyMatch[1];
    const objPath = lfsObjectPath(oid);

    if (!fs.existsSync(objPath)) {
      res.writeHead(404, { 'Content-Type': 'application/vnd.git-lfs+json' });
      res.end(JSON.stringify({ message: 'Not found' }));
      return;
    }

    const stat = fs.statSync(objPath);
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.size !== undefined && parsed.size !== stat.size) {
          res.writeHead(422, { 'Content-Type': 'application/vnd.git-lfs+json' });
          res.end(JSON.stringify({ message: `Size mismatch: expected ${parsed.size}, got ${stat.size}` }));
          return;
        }
      } catch { /* no body or invalid JSON is fine for verify */ }
      res.writeHead(200);
      res.end();
    });
    return;
  }

  // Not found
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[STARTUP] Git HTTP Server listening on port ${PORT}`);
});
