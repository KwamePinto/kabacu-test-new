const path = require('path');
const fs   = require('fs');
const { authenticateAdminUser } = require('../../config/authMiddleware');

const LOG_DIR    = path.join(__dirname, '../../../log');
const adminLayout = 'layouts/adminLayout';
const LINES_PER_PAGE = 200;

function getLogFiles() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse();
  } catch { return []; }
}

async function readTailLines(filePath, n) {
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lines   = content.split('\n').filter(Boolean);
  return lines.slice(-n).reverse();
}

exports.viewLogs = [authenticateAdminUser, async (req, res) => {
  const files   = getLogFiles();
  const file    = req.query.file || (files[0] || '');
  const filter  = (req.query.filter || '').trim().toLowerCase();
  const page    = Math.max(1, parseInt(req.query.page) || 1);

  let lines = [];
  let error = null;

  if (file) {
    const safe = path.basename(file);
    const full = path.join(LOG_DIR, safe);
    if (!fs.existsSync(full) || !full.startsWith(LOG_DIR)) {
      error = 'Log file not found.';
    } else {
      try {
        lines = await readTailLines(full, 5000);
        if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter));
      } catch (e) {
        error = 'Could not read log file.';
      }
    }
  }

  const total      = lines.length;
  const totalPages = Math.max(1, Math.ceil(total / LINES_PER_PAGE));
  const pageSafe   = Math.min(page, totalPages);
  const paged      = lines.slice((pageSafe - 1) * LINES_PER_PAGE, pageSafe * LINES_PER_PAGE);

  res.render('adminview/logs', {
    layout: adminLayout,
    files,
    file,
    filter,
    lines: paged,
    total,
    page: pageSafe,
    totalPages,
    error,
  });
}];

exports.downloadLog = [authenticateAdminUser, (req, res) => {
  const safe = path.basename(req.query.file || '');
  const full = path.join(LOG_DIR, safe);
  if (!safe || !fs.existsSync(full) || !full.startsWith(LOG_DIR)) {
    return res.status(404).send('File not found.');
  }
  res.download(full, safe);
}];
