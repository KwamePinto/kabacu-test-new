const express = require('express')
const router = express.Router()


const getDashboard = require('../../controllers/adminControllers/dashboardController')

router.get('/', (req, res) => res.redirect('/admin/main/dashboard'))
router.get('/dashboard',getDashboard.dashboard)


module.exports = router