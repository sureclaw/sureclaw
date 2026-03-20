import type { IncomingMessage, ServerResponse } from 'node:http';

// Build a minimal valid ZIP containing a SKILL.md for the linear skill
function buildLinearSkillZip(): Buffer {
  // Build a stored (uncompressed) ZIP with one file: SKILL.md
  // The SKILL.md should have frontmatter with requires.env: [LINEAR_API_KEY]
  const skillMd = `---
name: linear
description: Linear issue tracker integration
requires:
  env:
    - LINEAR_API_KEY
---

# Linear Skill

Query and manage Linear issues.

## Tools

### linear
Execute GraphQL queries against the Linear API.
`;

  // Use the same ZIP building approach as the test file in tests/clawhub/registry-client.test.ts
  const nameBuf = Buffer.from('SKILL.md', 'utf8');
  const dataBuf = Buffer.from(skillMd, 'utf8');

  // Local file header
  const lh = Buffer.alloc(30 + nameBuf.length);
  lh.writeUInt32LE(0x04034b50, 0);       // local file header signature
  lh.writeUInt16LE(20, 4);               // version needed
  lh.writeUInt16LE(0, 8);                // method: stored
  lh.writeUInt32LE(dataBuf.length, 18);  // compressed size
  lh.writeUInt32LE(dataBuf.length, 22);  // uncompressed size
  lh.writeUInt16LE(nameBuf.length, 26);  // filename length
  nameBuf.copy(lh, 30);

  // Central directory
  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0);       // central directory signature
  cd.writeUInt16LE(20, 4);               // version made by
  cd.writeUInt16LE(20, 6);               // version needed
  cd.writeUInt32LE(dataBuf.length, 20);  // compressed size
  cd.writeUInt32LE(dataBuf.length, 24);  // uncompressed size
  cd.writeUInt16LE(nameBuf.length, 28);  // filename length
  cd.writeUInt32LE(0, 42);               // local header offset
  nameBuf.copy(cd, 46);

  const cdOffset = lh.length + dataBuf.length;
  const cdSize = cd.length;

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);              // entries on this disk
  eocd.writeUInt16LE(1, 10);             // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lh, dataBuf, cd, eocd]);
}

const linearSkillZip = buildLinearSkillZip();

export function handleClawHub(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '', 'http://localhost');
  const path = url.pathname;

  // GET /api/v1/search?q=... → return search results
  if (path === '/api/v1/search' || path === '/clawhub/api/v1/search') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      results: [{
        slug: 'ManuelHettich/linear',
        displayName: 'Linear',
        summary: 'Linear issue tracker integration',
        version: '1.0.0',
        score: 9.5,
      }],
    }));
    return;
  }

  // GET /api/v1/download?slug=ManuelHettich/linear → return ZIP with SKILL.md
  if (path === '/api/v1/download' || path === '/clawhub/api/v1/download') {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(linearSkillZip.length),
    });
    res.end(linearSkillZip);
    return;
  }

  // GET /api/v1/skills → list popular skills
  if (path === '/api/v1/skills' || path === '/clawhub/api/v1/skills') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      items: [{
        slug: 'ManuelHettich/linear',
        displayName: 'Linear',
        summary: 'Linear issue tracker integration',
        latestVersion: { version: '1.0.0' },
      }],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}
