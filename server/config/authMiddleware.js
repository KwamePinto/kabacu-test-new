const { verifyUserToken, verifyUserAdminToken } = require('./authUtils');
const UserAdminModel = require('../models/UserAdminModel');

// Cache admin isActive status for 5 minutes — avoids a DB round-trip on every request.
// Cleared immediately when an admin is deactivated via the UI.
const _adminActiveCache = new Map();
const ADMIN_CACHE_TTL_MS = 5 * 60 * 1000;
function _isAdminActive(adminId) {
  const cached = _adminActiveCache.get(adminId);
  if (cached && Date.now() - cached.at < ADMIN_CACHE_TTL_MS) return Promise.resolve(cached.active);
  return UserAdminModel.findById(adminId).select('isActive').lean().then(admin => {
    const active = !!(admin && admin.isActive !== false);
    _adminActiveCache.set(adminId, { active, at: Date.now() });
    return active;
  });
}
function authenticateUser(req, res, next) {
  const token = req.cookies.user_token;

  if (!token) {
    console.log("You must be logged in.");
    return res.redirect('/user/login'); // ✅ NOT "/"
  }

  try {
    const decoded = verifyUserToken(token);

    req.user = {
      id: decoded.userId,
      username: decoded.username,
      role:  decoded.role,
      minerId: decoded.minerId
    };

    res.locals.user = req.user;

    next();

  } catch (error) {
    console.log("Invalid token:", error.message);
    res.clearCookie('user_token');
    return res.redirect('/user/login'); // ✅ NOT "/"
  }
}

function authenticateAdminUser(req, res, next) {
  const token = req.cookies.admin_token;

  if (!token) {
    console.log("You must be logged in.");
    return res.redirect('/command');
  }

  try {
    const decoded = verifyUserAdminToken(token);

    req.user = {
      id: decoded.userId,
      username: decoded.username,
      role:  decoded.role,
    };

    res.locals.user = req.user;

    // Async check: if account has been deactivated since token was issued, kick them out.
    // Result is cached for 5 min to avoid a DB round-trip on every single request.
    _isAdminActive(decoded.userId)
      .then(function (active) {
        if (!active) {
          res.clearCookie('admin_token');
          return res.redirect('/command');
        }
        next();
      })
      .catch(function () { next(); }); // on DB error, allow through to avoid locking everyone out

  } catch (error) {
    console.log("Invalid token:", error.message);
    res.clearCookie('admin_token');
    return res.redirect('/command');
  }
}


function optionalUser(req, res, next) {
  const token = req.cookies.user_token;

  if (!token) {
    res.locals.user = null;
    return next();
  }

  try {
    const decoded = verifyUserToken(token);

    req.user = {
      id: decoded.userId,
      username: decoded.username,
    };

    res.locals.user = req.user;

  } catch (error) {
    res.locals.user = null;
    res.clearCookie('user_token');
  }

  next();
}



module.exports = {
  authenticateAdminUser,
  authenticateUser,
  optionalUser,
  invalidateAdminCache: id => _adminActiveCache.delete(id?.toString()),
};
