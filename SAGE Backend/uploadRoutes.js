'use strict';

/**
 * uploadRoutes.js
 *
 * POST /api/upload/:tab   (tab = faculty | rooms | sections | courses | timeslots)
 */

const express = require('express');
const multer = require('multer');
const { readTabColumn, UploadError, ALLOWED_EXTENSIONS, extensionOf } = require('./parseColumn');

// Configuration for tables and default column requirements
const TABLES = {
  faculty:   { table: 'faculty',   idColumn: 'faculty_id',  nameColumn: 'name',      idPrefix: 'F0', extraColumns: { employment_type: 'Full-Time' } },
  rooms:     { table: 'rooms',     idColumn: 'room_id',     isDirectId: true,                        extraColumns: { room_type: 'Lecture', capacity: 30 } },
  sections:  { table: 'sections',  idColumn: 'section_id',  nameColumn: 'program',   idPrefix: 'SEC', extraColumns: { year_level: 1 } },
  courses:   { table: 'courses',   idColumn: 'course_code', nameColumn: 'description', idPrefix: 'CRS', extraColumns: {} },
  timeslots: { table: 'timeslots', idColumn: 'timeslot_id', nameColumn: 'day',       idPrefix: 'TS',  extraColumns: {} },
};

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_EXTENSIONS.includes(extensionOf(file.originalname))) return cb(null, true);
    cb(new UploadError('Only CSV or Excel files (.csv, .xlsx, .xls) are allowed.'));
  },
});

function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message });
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).` });
    }
    return res.status(400).json({ error: err.message || 'Upload failed.' });
  });
}

/** Inserts values that are not already in the table (case-insensitive). */
async function insertNew(pool, cfg, values) {
  const { table, idColumn, nameColumn, idPrefix, isDirectId, extraColumns = {} } = cfg;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // -------------------------------------------------------------
    // SPECIAL CASE FOR ROOMS:
    // The uploaded values (e.g. 324, 326) are the Room IDs themselves.
    // -------------------------------------------------------------
    if (isDirectId) {
      const [existing] = await conn.query(`SELECT \`${idColumn}\` AS id FROM \`${table}\` FOR UPDATE`);
      const knownIds = new Set(existing.map((r) => String(r.id ?? '').trim().toLowerCase()));

      // Filter out room numbers already in the table
      const freshRooms = values.filter((v) => !knownIds.has(String(v).trim().toLowerCase()));

      if (freshRooms.length > 0) {
        const extraKeys = Object.keys(extraColumns);
        const extraVals = Object.values(extraColumns);

        const cols = [`\`${idColumn}\``, ...extraKeys.map((k) => `\`${k}\``)].join(', ');
        
        // Inserts room_id = '324', room_type = 'Lecture', capacity = 30
        const rows = freshRooms.map((roomNumber) => [
          String(roomNumber).trim(),
          ...extraVals
        ]);

        await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ?`, [rows]);
      }

      await conn.commit();
      return { added: freshRooms.length, alreadyThere: values.length - freshRooms.length };
    }

    // -------------------------------------------------------------
    // STANDARD CASE (Faculty, Sections, Courses, Timeslots):
    // -------------------------------------------------------------
    const [existing] = await conn.query(
      `SELECT \`${idColumn}\` AS id, \`${nameColumn}\` AS name FROM \`${table}\` FOR UPDATE`
    );

    const known = new Set(existing.map((r) => String(r.name ?? '').trim().toLowerCase()));
    const fresh = values.filter((v) => !known.has(v.toLowerCase()));

    if (fresh.length > 0) {
      const extraKeys = Object.keys(extraColumns);
      const extraVals = Object.values(extraColumns);

      if (idPrefix) {
        let maxNumber = 0;
        for (const r of existing) {
          const match = String(r.id ?? '').match(/(\d+)(?!.*\d)/);
          if (match) {
            const num = parseInt(match[1], 10);
            if (!isNaN(num) && num > maxNumber) {
              maxNumber = num;
            }
          }
        }

        const next = maxNumber + 1;
        const formatId = (num) => (table === 'faculty' ? `F0${num}` : `${idPrefix}-${String(num).padStart(4, '0')}`);

        console.log(`[Upload ${table}] Highest existing ID number: ${maxNumber}. First new row gets ID: ${formatId(next)}`);

        const cols = [`\`${idColumn}\``, `\`${nameColumn}\``, ...extraKeys.map((k) => `\`${k}\``)].join(', ');
        const rows = fresh.map((v, i) => [
          formatId(next + i),
          v,
          ...extraVals,
        ]);

        await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ?`, [rows]);
      } else {
        const cols = [`\`${nameColumn}\``, ...extraKeys.map((k) => `\`${k}\``)].join(', ');
        const rows = fresh.map((v) => [v, ...extraVals]);

        await conn.query(`INSERT INTO \`${table}\` (${cols}) VALUES ?`, [rows]);
      }
    }

    await conn.commit();
    return { added: fresh.length, alreadyThere: values.length - fresh.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function createUploadRouter(pool) {
  const router = express.Router();

  router.post('/:tab', receiveFile, async (req, res) => {
    const tab = req.params.tab;
    const cfg = TABLES[tab];
    if (!cfg) return res.status(400).json({ error: `Unknown data type "${tab}".` });
    if (!req.file) return res.status(400).json({ error: 'No file received.' });

    try {
      const { label, values, duplicatesInFile } = readTabColumn({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        tab,
      });

      const { added, alreadyThere } = await insertNew(pool, cfg, values);
      const skipped = alreadyThere + duplicatesInFile;

      const message =
        added === 0
          ? `No new ${label} entries: all ${values.length} in the file already exist.`
          : `Added ${added} new ${label} ${added === 1 ? 'entry' : 'entries'}` +
            (skipped > 0 ? ` (${skipped} duplicate${skipped === 1 ? '' : 's'} skipped).` : '.');

      res.json({ message });
    } catch (err) {
      if (err instanceof UploadError) return res.status(err.status).json({ error: err.message });
      console.error('Upload failed:', err);
      res.status(500).json({ error: err.sqlMessage || 'Upload failed on the server. Please try again.' });
    }
  });

  return router;
}

module.exports = createUploadRouter;