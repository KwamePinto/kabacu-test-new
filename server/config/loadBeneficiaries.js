// middleware/loadBeneficiaries.js
const Beneficiary = require('../models/BeneficiaryModel');

async function loadBeneficiaries(req, res, next) {
  try {
    if (!req.user || req.originalUrl.startsWith('/admin') || req.originalUrl.startsWith('/api')) {
      res.locals.beneficiaries = [];
      return next();
    }

    res.locals.beneficiaries = await Beneficiary.find({
      user: req.user.id,
      is_deleted: 0
    }).sort({ createdAt: -1 });

  } catch (error) {
    res.locals.beneficiaries = [];
  }

  next();
}

module.exports = loadBeneficiaries;
