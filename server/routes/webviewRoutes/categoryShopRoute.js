const express = require('express')
const router = express.Router()

const getCategory = require('../../controllers/webviewControllers/categoryShopController')
const { authenticateUser, optionalUser } = require('../../config/authMiddleware')
const { pageGate } = require('../../middleware/pageFlagsMiddleware')



router.get('/data-category', pageGate('data'), getCategory.dataCategory)

router.get('/electronic-category', pageGate('electronics'), getCategory.eletronicCategory)

router.get('/automobile-category', pageGate('automobile'), getCategory.automobileCategory)

router.get('/course-category', pageGate('courses'), getCategory.courseCategory)
router.get('/course/:id', pageGate('courses'), optionalUser, getCategory.courseDetail)
router.post('/course/:id/buy', pageGate('courses'), authenticateUser, getCategory.coursePurchase)

router.get('/p2p-category', pageGate('p2p'), getCategory.p2pCategory)

router.get('/games-category', getCategory.gamesCategory)




module.exports = router;