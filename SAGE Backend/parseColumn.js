'use strict';

/**
 * parseColumn.js
 *
 * Reads an uploaded CSV / Excel file and returns every value found in the column
 * whose header matches the selected Manage Data tab (Faculty, Rooms, Sections,
 * Courses, Timeslots). For Excel files the data must be in a sheet named "Compile".
 * The header match ignores upper/lower case, so "Faculty",
 * "FACULTY" and "fAcUlTy" all work. Spaces/underscores are ignored too, so a
 * "Time Slots" header matches the Timeslots tab.
 *
 * Nothing in here touches the database or Express; it is a pure function of
 * (file bytes, file name, tab) so it is easy to test.
 */

const XLSX = require('xlsx');

// Header text expected for each tab.
const COLUMN_BY_TAB = {
  faculty: 'Faculty',
  rooms: 'Rooms',
  sections: 'Sections',
  courses: 'Courses',
  timeslots: 'Timeslots',
};

// Excel files must contain a sheet with this name (any upper/lower case), and ONLY that
// sheet is read. CSV files have no sheets, so this rule does not apply to them.
const REQUIRED_SHEET = 'Compile';

const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'];
const HEADER_SCAN_ROWS = 10; // the header may sit below a few title rows

class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

// "Time Slots", "time_slots", "TIMESLOTS:" -> "timeslots"
const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Trim and collapse inner whitespace: "  Michelle   andersen " -> "Michelle andersen"
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

const extensionOf = (name) => {
  const m = /\.[^.\\/]+$/.exec(name || '');
  return m ? m[0].toLowerCase() : '';
};

const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const isZip = (buf) => startsWith(buf, [0x50, 0x4b, 0x03, 0x04]); // .xlsx
const isOle = (buf) => startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // .xls
const isPdf = (buf) => startsWith(buf, [0x25, 0x50, 0x44, 0x46]); // %PDF

const NOT_ALLOWED = 'Only CSV or Excel files (.csv, .xlsx, .xls) are allowed.';

/**
 * Checks the file really is what its extension claims, so a PDF or Word file
 * renamed to "faculty.csv" is rejected. Returns 'csv' or 'excel'.
 */
function detectKind(buffer, fileName) {
  const ext = extensionOf(fileName);
  if (!ALLOWED_EXTENSIONS.includes(ext)) throw new UploadError(NOT_ALLOWED);
  if (!buffer || buffer.length === 0) throw new UploadError('The uploaded file is empty.');

  if (ext === '.csv') {
    const looksBinary =
      isZip(buffer) || isOle(buffer) || isPdf(buffer) || buffer.subarray(0, 8192).includes(0x00);
    if (looksBinary) throw new UploadError(NOT_ALLOWED);
    return 'csv';
  }

  if (!isZip(buffer) && !isOle(buffer)) throw new UploadError(NOT_ALLOWED);
  return 'excel';
}

/**
 * CSV text. Excel's plain "CSV" on Windows is ANSI (windows-1252), while "CSV UTF-8"
 * and most other tools are UTF-8. Try strict UTF-8 first, fall back to windows-1252,
 * so names like "Dela Peña" survive either way.
 */
function decodeCsv(buffer) {
  let buf = buffer;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3); // BOM
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

/** Returns each sheet as an array of rows (array of cells), with text exactly as displayed. */
function loadSheets(buffer, kind) {
  const workbook =
    kind === 'csv'
      ? // raw: true keeps CSV cells as text, so "001" or "2-3" are not turned into numbers/dates
        XLSX.read(decodeCsv(buffer), { type: 'string', raw: true })
      : XLSX.read(buffer, { type: 'buffer' });

  return workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
    }),
  }));
}

/** Finds the header cell (case-insensitive) and returns all non-empty cells beneath it. */
function readColumn(rows, wanted) {
  const target = normalize(wanted);
  const limit = Math.min(HEADER_SCAN_ROWS, rows.length);

  for (let r = 0; r < limit; r++) {
    const col = rows[r].findIndex((cell) => normalize(cell) === target);
    if (col === -1) continue;

    const values = [];
    for (let i = r + 1; i < rows.length; i++) {
      const v = clean(rows[i][col]);
      if (v) values.push(v);
    }
    return { found: true, values };
  }
  return { found: false, values: [] };
}

/** Header names of the first non-empty row, used to make the "not found" error helpful. */
function headersSeen(rows) {
  for (const row of rows.slice(0, HEADER_SCAN_ROWS)) {
    const names = row.map(clean).filter(Boolean);
    if (names.length) return names.slice(0, 8);
  }
  return [];
}

/**
 * Main entry point.
 * @returns {{ label: string, values: string[], duplicatesInFile: number }}
 * @throws  {UploadError} for a wrong file type, missing column, or empty column
 */
function readTabColumn({ buffer, fileName, tab }) {
  const label = COLUMN_BY_TAB[tab];
  if (!label) throw new UploadError(`Unknown data type "${tab}".`);

  const kind = detectKind(buffer, fileName);

  let sheets;
  try {
    sheets = loadSheets(buffer, kind);
  } catch {
    throw new UploadError('The file could not be read. Make sure it is a valid CSV or Excel file.');
  }

  // Excel: only the "Compile" sheet is used; every other sheet is ignored.
  if (kind === 'excel') {
    const compile = sheets.filter((s) => s.name.trim().toLowerCase() === REQUIRED_SHEET.toLowerCase());
    if (compile.length === 0) {
      const names = sheets.map((s) => s.name).join(', ');
      throw new UploadError(
        `The Excel file must contain a sheet named "${REQUIRED_SHEET}".` + (names ? ` Sheets found: ${names}.` : '')
      );
    }
    sheets = compile;
  }

  let foundAnywhere = false;
  const all = [];
  for (const sheet of sheets) {
    const { found, values } = readColumn(sheet.rows, label);
    if (found) {
      foundAnywhere = true;
      all.push(...values);
    }
  }

  if (!foundAnywhere) {
    const seen = sheets.length ? headersSeen(sheets[0].rows) : [];
    const hint = seen.length ? ` Columns found: ${seen.join(', ')}.` : '';
    const where = kind === 'excel' ? `in the "${REQUIRED_SHEET}" sheet` : 'in the file';
    throw new UploadError(`No "${label}" column found ${where}.${hint}`);
  }

  // Remove repeats inside the file (case-insensitive), keeping the first spelling.
  const seenKeys = new Set();
  const values = [];
  for (const v of all) {
    const key = v.toLowerCase();
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      values.push(v);
    }
  }

  if (values.length === 0) throw new UploadError(`The "${label}" column has no data rows.`);

  return { label, values, duplicatesInFile: all.length - values.length };
}

module.exports = { readTabColumn, UploadError, COLUMN_BY_TAB, ALLOWED_EXTENSIONS, REQUIRED_SHEET, extensionOf };