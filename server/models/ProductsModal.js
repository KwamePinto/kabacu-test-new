const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({

  category: {
    type: String,
    required: true
  },

  // Market this product is sold in, as an ISO alpha-2 code ("NG", "GH").
  // Signed-in users only see products matching their profile country;
  // signed-out visitors can browse any market via the header picker.
  country: {
    type: String,
    uppercase: true,
    trim: true,
    default: 'NG',
  },
  is_deleted: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  images: [String],
  costPrice: {
    type: Number,
    default: 0,
  },
  reward_point:{
    type:Number,
    default: 0
  },
  description:{
    type: String,
    required: true,
    default:null,
  },


  // NORMAL PRODUCT
  item_name: String,
  item_price: Number,
  //description: String,
  // piece_price: Number,
  // item_type: String,

  // DATA PRODUCT
  dataDetails: {
    plan_id: Number,
    network: String,
    plan_type: String,
    plan_name: String,
    amount: Number,
    oldPrice:Number,
    validate_period: String
  },

  // AUTOMOBILE PRODUCT
  automobileDetails: {
    brand: String,
    model: String,
    year: Number,
    fuel_type: String,
    transmission: String,
    price: Number,
    condition: String // new / used
  },
    //ElECTRONICS PRODUCT
  electronicDetails: {
    itemName: String,
    brandItem: String,
    itemtype: String,
    items_price: Number,
  },

   coursesDetails: {
    title: String,
    instructor: String,
    course_description: String,
    course_price: Number,
    courseCategory: String,
    difficulty: { type: String, enum: ['Beginner', 'Intermediate', 'Advanced'] },
    overview: String,
    whatYouWillLearn: [String],
    chapterCount: { type: Number, default: 0 },
    lessonCount: { type: Number, default: 0 },
    estimatedDuration: String,
    published: { type: Boolean, default: false },
  },
   checkout: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'checkout',
      
    },
     cart: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'cart',
      
    },

}, { timestamps: true });

/* Home page and every category page query by category and sort by newest —
   without this the queries are full collection scans. */
productSchema.index({ category: 1, createdAt: -1 });
productSchema.index({ category: 1, country: 1, createdAt: -1 });

module.exports = mongoose.model('Product', productSchema);