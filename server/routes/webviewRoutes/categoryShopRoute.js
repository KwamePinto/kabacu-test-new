const express = require('express')
const router = express.Router()

const getCategory = require('../../controllers/webviewControllers/categoryShopController')
const { authenticateUser, optionalUser } = require('../../config/authMiddleware')



router.get('/data-category',getCategory.dataCategory)

router.get('/electronic-category',getCategory.eletronicCategory)

router.get('/automobile-category',getCategory.automobileCategory)

router.get('/course-category',getCategory.courseCategory)
router.get('/course/:id', optionalUser, getCategory.courseDetail)
router.post('/course/:id/buy', authenticateUser, getCategory.coursePurchase)

router.get('/p2p-category',getCategory.p2pCategory)

router.get('/games-category', getCategory.gamesCategory)




module.exports = router;