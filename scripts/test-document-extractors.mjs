/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const {
  extractDocumentContentByType,
  resolveDocumentFileType,
  DocumentExtractionError,
} = await import(dist('utils/documentExtraction.js'));
const { readZipArchive, ZipArchiveError } = await import(
  dist('utils/zipArchive.js')
);

/**
 * Minimal ZIP writer for fixtures. CRCs are zeroed: the production reader
 * trusts sizes and signatures, not checksums, and these archives never leave
 * the test process.
 */
const buildZip = (entries, { encrypt = false } = {}) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data, 'utf8');
    const method = entry.deflate ? 8 : 0;
    const payload = entry.deflate ? deflateRawSync(data) : data;
    const uncompressedSize =
      entry.declaredUncompressedSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(encrypt ? 1 : 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(encrypt ? 1 : 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBytes, payload);
    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
};

test('the ZIP reader inflates stored and deflated entries and skips directories', () => {
  const archive = readZipArchive(
    buildZip([
      { path: 'stored.txt', data: 'plain payload' },
      { path: 'deflated.txt', data: 'compressed payload', deflate: true },
      { path: 'folder/', data: '' },
    ])
  );
  assert.deepEqual(archive.entryPaths().sort(), ['deflated.txt', 'stored.txt']);
  assert.equal(archive.read('stored.txt').toString('utf8'), 'plain payload');
  assert.equal(
    archive.read('deflated.txt').toString('utf8'),
    'compressed payload'
  );
  assert.equal(archive.read('missing.txt'), null);
});

test('the ZIP reader rejects encrypted entries and lying size declarations', () => {
  assert.throws(
    () => readZipArchive(buildZip([{ path: 'a.txt', data: 'x' }], { encrypt: true })),
    ZipArchiveError
  );
  const lyingArchive = readZipArchive(
    buildZip([
      {
        path: 'bomb.txt',
        data: 'A'.repeat(50_000),
        deflate: true,
        declaredUncompressedSize: 10,
      },
    ])
  );
  // The declared size caps the inflate budget, so the oversized payload fails.
  assert.throws(() => lyingArchive.read('bomb.txt'), ZipArchiveError);
  assert.throws(() => readZipArchive(Buffer.from('not a zip file')), ZipArchiveError);
});

test('the ZIP reader enforces the per-entry decompressed budget', () => {
  const archive = buildZip([
    {
      path: 'huge.txt',
      data: 'irrelevant',
      declaredUncompressedSize: 65 * 1024 * 1024,
    },
  ]);
  assert.throws(() => readZipArchive(archive), ZipArchiveError);
});

test('file-type resolution prefers the extension and falls back to MIME', () => {
  assert.equal(resolveDocumentFileType('report.pdf', 'application/pdf'), 'pdf');
  assert.equal(resolveDocumentFileType('notes.md', 'text/plain'), 'md');
  assert.equal(
    resolveDocumentFileType('deck.pptx', 'application/octet-stream'),
    'pptx'
  );
  assert.equal(
    resolveDocumentFileType(
      'sheet.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ),
    'xlsx'
  );
  assert.equal(resolveDocumentFileType('main.py', ''), 'code');
  assert.equal(resolveDocumentFileType('Dockerfile', ''), 'code');
  assert.equal(resolveDocumentFileType('page.html', 'text/html'), 'html');
  assert.equal(resolveDocumentFileType('data.tsv', ''), 'csv');
  // Unknown extension, declared text MIME → plain text.
  assert.equal(resolveDocumentFileType('trace.out', 'text/plain'), 'txt');
  // Unknown extension and MIME → unsupported.
  assert.equal(
    resolveDocumentFileType('binary.exe', 'application/octet-stream'),
    null
  );
});

test('DOCX extraction reads paragraphs, tabs, breaks, and XML entities', async () => {
  const documentXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>
    <w:p><w:r><w:t>Costs</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">rose &amp; fell &lt;fast&gt;</w:t></w:r></w:p>
    <w:p><w:r><w:t/></w:r></w:p>
  </w:body>
</w:document>`;
  const buffer = buildZip([
    { path: 'word/document.xml', data: documentXml, deflate: true },
  ]);
  const extracted = await extractDocumentContentByType(buffer, 'docx');
  assert.equal(
    extracted.content,
    'Quarterly report\n\nCosts\trose & fell <fast>'
  );
  assert.deepEqual(extracted.segments, []);
});

test('PPTX extraction orders slides numerically and maps slide segments', async () => {
  const slide = text =>
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  const buffer = buildZip([
    { path: 'ppt/slides/slide10.xml', data: slide('Closing thoughts') },
    { path: 'ppt/slides/slide2.xml', data: slide('Second point') },
    { path: 'ppt/slides/slide1.xml', data: slide('Opening') },
  ]);
  const extracted = await extractDocumentContentByType(buffer, 'pptx');
  assert.equal(extracted.content, 'Opening\n\nSecond point\n\nClosing thoughts');
  assert.deepEqual(
    extracted.segments.map(segment => segment.label),
    ['Slide 1', 'Slide 2', 'Slide 10']
  );
  for (const segment of extracted.segments) {
    assert.equal(segment.kind, 'slide');
    const text = extracted.content.slice(segment.startChar, segment.endChar);
    assert.ok(text.length > 0 && !text.startsWith('\n'), `segment ${segment.label} is aligned`);
  }
  assert.equal(
    extracted.content.slice(
      extracted.segments[2].startChar,
      extracted.segments[2].endChar
    ),
    'Closing thoughts'
  );
});

test('XLSX extraction resolves shared strings, booleans, and sheet segments', async () => {
  const workbook = `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
    <sheets>
      <sheet name="Budget &amp; Plan" sheetId="1" r:id="rId1"/>
      <sheet name="Empty" sheetId="2" r:id="rId2"/>
      <sheet name="Flags" sheetId="3" r:id="rId3"/>
    </sheets>
  </workbook>`;
  const rels = `<Relationships>
    <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/>
    <Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet3.xml"/>
  </Relationships>`;
  const sharedStrings = `<sst><si><t>Item</t></si><si><t>Amount</t></si><si><t>Server &amp; rack</t></si></sst>`;
  const sheet1 = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1250.5</v></c></row>
  </sheetData></worksheet>`;
  const sheet2 = `<worksheet><sheetData/></worksheet>`;
  const sheet3 = `<worksheet><sheetData>
    <row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="inlineStr"><is><t>inline note</t></is></c></row>
  </sheetData></worksheet>`;
  const buffer = buildZip([
    { path: 'xl/workbook.xml', data: workbook },
    { path: 'xl/_rels/workbook.xml.rels', data: rels },
    { path: 'xl/sharedStrings.xml', data: sharedStrings, deflate: true },
    { path: 'xl/worksheets/sheet1.xml', data: sheet1, deflate: true },
    { path: 'xl/worksheets/sheet2.xml', data: sheet2 },
    { path: 'xl/worksheets/sheet3.xml', data: sheet3 },
  ]);
  const extracted = await extractDocumentContentByType(buffer, 'xlsx');
  assert.equal(
    extracted.content,
    'Sheet: Budget & Plan\nItem\tAmount\nServer & rack\t\t1250.5\n\nSheet: Flags\nTRUE\tinline note'
  );
  assert.deepEqual(
    extracted.segments.map(segment => [segment.kind, segment.label]),
    [
      ['sheet', 'Budget & Plan'],
      ['sheet', 'Flags'],
    ]
  );
  for (const segment of extracted.segments) {
    const text = extracted.content.slice(segment.startChar, segment.endChar);
    assert.ok(text.startsWith(`Sheet: ${segment.label}`));
  }
});

test('Markdown extraction maps heading sections onto exact offsets', async () => {
  const markdown = [
    '# Overview',
    '',
    'Intro paragraph.',
    '',
    '## Details',
    '',
    'More text here.',
    '',
  ].join('\n');
  const extracted = await extractDocumentContentByType(
    Buffer.from('\ufeff' + markdown),
    'md'
  );
  assert.equal(extracted.content, markdown);
  assert.deepEqual(
    extracted.segments.map(segment => segment.label),
    ['Overview', 'Details']
  );
  const [overview, details] = extracted.segments;
  assert.equal(
    extracted.content.slice(overview.startChar, overview.endChar),
    '# Overview\n\nIntro paragraph.\n\n'
  );
  assert.equal(
    extracted.content.slice(details.startChar, details.endChar),
    '## Details\n\nMore text here.\n'
  );
});

test('HTML extraction reduces markup to text and keeps the title', async () => {
  const html = `<html><head><title>Release notes</title><style>body{}</style></head>
    <body><h1>Release notes</h1><p>Version <b>2.0</b> ships today.</p><script>alert(1)</script></body></html>`;
  const extracted = await extractDocumentContentByType(Buffer.from(html), 'html');
  assert.ok(extracted.content.includes('Release notes'));
  assert.ok(extracted.content.includes('Version 2.0 ships today.'));
  assert.ok(!extracted.content.includes('alert(1)'));
});

test('CSV and code files pass through with normalized line endings', async () => {
  const csv = await extractDocumentContentByType(
    Buffer.from('name,total\r\nwidget,4\r\n'),
    'csv'
  );
  assert.equal(csv.content, 'name,total\nwidget,4\n');
  const code = await extractDocumentContentByType(
    Buffer.from('const answer = 42;\n'),
    'code'
  );
  assert.equal(code.content, 'const answer = 42;\n');
});

test('a corrupt Office upload fails with a clear extraction error', async () => {
  await assert.rejects(
    extractDocumentContentByType(Buffer.from('not an archive'), 'docx'),
    DocumentExtractionError
  );
  await assert.rejects(
    extractDocumentContentByType(
      buildZip([{ path: 'unrelated.txt', data: 'x' }]),
      'docx'
    ),
    /missing its word\/document\.xml part/
  );
  await assert.rejects(
    extractDocumentContentByType(
      buildZip([{ path: 'ppt/slides/nothing.xml', data: '<x/>' }]),
      'pptx'
    ),
    /contains no slides/
  );
});

test('PDF extraction produces per-page segments through pdfjs', async () => {
  const lines = [];
  const objects = [];
  const addObject = content => {
    objects.push(content);
    return objects.length;
  };
  // Two single-line pages built as a minimal but standards-valid PDF.
  const font = addObject(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  );
  const streamOne = 'BT /F1 12 Tf 72 720 Td (Alpha page text) Tj ET';
  const streamTwo = 'BT /F1 12 Tf 72 720 Td (Beta page text) Tj ET';
  const contentOne = addObject(
    `<< /Length ${streamOne.length} >>\nstream\n${streamOne}\nendstream`
  );
  const contentTwo = addObject(
    `<< /Length ${streamTwo.length} >>\nstream\n${streamTwo}\nendstream`
  );
  const pagesId = objects.length + 3;
  const pageOne = addObject(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentOne} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
  );
  const pageTwo = addObject(
    `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentTwo} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`
  );
  const pages = addObject(
    `<< /Type /Pages /Kids [${pageOne} 0 R ${pageTwo} 0 R] /Count 2 >>`
  );
  const catalog = addObject(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
  lines.push('%PDF-1.4');
  const offsets = [];
  let position = lines.join('\n').length + 1;
  for (let index = 0; index < objects.length; index += 1) {
    const body = `${index + 1} 0 obj\n${objects[index]}\nendobj`;
    offsets.push(position);
    lines.push(body);
    position += body.length + 1;
  }
  const xrefPosition = position;
  lines.push('xref');
  lines.push(`0 ${objects.length + 1}`);
  lines.push('0000000000 65535 f ');
  for (const offset of offsets) {
    lines.push(`${String(offset).padStart(10, '0')} 00000 n `);
  }
  lines.push(
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>`
  );
  lines.push(`startxref\n${xrefPosition}`);
  lines.push('%%EOF');
  const pdfBuffer = Buffer.from(lines.join('\n'), 'latin1');

  const pdfLib = await import(
    pathToFileURL(
      path.join(repoRoot, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs')
    ).href
  );
  const extracted = await extractDocumentContentByType(pdfBuffer, 'pdf', {
    pdfLib,
  });
  assert.equal(extracted.content, 'Alpha page text\n\nBeta page text');
  assert.deepEqual(
    extracted.segments.map(segment => [segment.label, segment.kind]),
    [
      ['Page 1', 'page'],
      ['Page 2', 'page'],
    ]
  );
  assert.equal(
    extracted.content.slice(
      extracted.segments[1].startChar,
      extracted.segments[1].endChar
    ),
    'Beta page text'
  );
});
