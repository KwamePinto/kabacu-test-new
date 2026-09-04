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
    // Which service actually fulfils this bundle. Default 'ODS' preserves
    // every product created before this field existed. Decides whether
    // `network` resolves against NetworkModel (ODS) or GsubzPlanModel
    // (GSUBZ), and which of plan_id / gsubz_plan_code the purchase uses.
    provider: { type: String, enum: ['ODS', 'GSUBZ'], default: 'ODS' },
    // Inherited from the selected Data Plan (NetworkModel.planId), never typed
    // on the product form. Sent to OurDataStore as `data_plan` on purchase.
    plan_id: Number,
    // GSubz's own plan code for this exact bundle size (its `plan` field on
    // /pay). Kept separate from plan_id rather than reusing it — plan_id is
    // a Number and every purchase call site reads it directly, so conflating
    // the two types risks a silent bug at a money-handling call site.
    gsubz_plan_code: String,
    // The plan this bundle belongs to, by name, e.g. "CTC Weekly Special-MTN".
    // Resolved against NetworkModel or GsubzPlanModel depending on `provider`.
    network: String,
    // Card headline, e.g. "2GB Data Plan"
    plan_type: String,
    // Kept in step with plan_type for older records and search
    plan_name: String,
    amount: Number,
    // Optional. When set and higher than amount, the card shows it struck
    // through plus a cashback badge for the difference (display only).
    oldPrice:Number,
    validate_period: String,
    // Optional freebie shown as a chip, e.g. "2GB YouTube"
    bonus: String
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